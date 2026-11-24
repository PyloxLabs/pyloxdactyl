#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Pyloxdactyl installer / manager
#
# Interactive menu:
#   sudo bash <(curl -fsSL https://install.pyloxdactyl.pylox.net)
#
# Direct actions:
#   sudo bash <(curl -fsSL https://install.pyloxdactyl.pylox.net) --install
#   sudo bash <(curl -fsSL https://install.pyloxdactyl.pylox.net) --update
#   sudo bash <(curl -fsSL https://install.pyloxdactyl.pylox.net) --eggs
#   sudo bash <(curl -fsSL https://install.pyloxdactyl.pylox.net) --uninstall
#
# The daemon is installed separately from its own repository.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -Eeuo pipefail

PURPLE='\033[38;5;141m'
ORANGE='\033[38;5;208m'
GREEN='\033[38;5;78m'
RED='\033[38;5;196m'
YELLOW='\033[38;5;214m'
NC='\033[0m'

log() {
  if [[ "${1:-}" == "-e" ]]; then
    shift
    printf '%b\n' "$*"
  else
    printf '%s\n' "$*"
  fi
}
info() { printf '%b[*]%b %s\n' "$PURPLE" "$NC" "$*"; }
ok()   { printf '%b[✓]%b %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%b[!]%b %s\n' "$YELLOW" "$NC" "$*" >&2; }
die()  { printf '%b[ERROR]%b %s\n' "$RED" "$NC" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Pyloxdactyl installer / manager

Usage: sudo bash <(curl -fsSL https://install.pyloxdactyl.pylox.net) [options]
       sudo bash scripts/install.sh [options]

With no options, an interactive menu is shown (when stdin is a terminal).

Actions:
  --install             Fresh install (default for non-interactive use)
  --update              Update from GitHub if package.json version increased
  --eggs                Install Pterodactyl/Pelican legacy eggs
  --legacy-eggs         Alias for --eggs
  --uninstall           Remove Pyloxdactyl
  -h, --help            Show this help

Source options:
  --repo OWNER/REPO     GitHub repository (default: PyloxLabs/pyloxdactyl)
  --ref REF             Branch, tag, or commit (default: main; alias: --branch)
  --source-dir DIR      Use a local source tree instead of downloading

Install options:
  --db sqlite|mysql     Database driver (default: sqlite)
  --port PORT           Panel HTTP port (default: 6000)
  --url URL             Public application URL (default: http://localhost:PORT)
  --install-dir DIR     Install directory (default: /opt/pyloxdactyl)
  --data-dir DIR        Runtime data directory (default: /var/lib/pyloxdactyl)
  --service NAME        systemd service name (default: pyloxdactyl)
  --pull-yolks          Pre-pull common Pterodactyl yolks images
  --no-docker           Skip Docker installation/network setup
  --force               Allow installing into a non-empty install directory
  -y, --yes             Do not ask confirmation prompts

Environment equivalents: REPO, REF, SOURCE_DIR, DB_DRIVER, DB_NAME, APP_PORT,
APP_URL, INSTALL_DIR, DATA_DIR, SERVICE_NAME, SERVICE_USER are also accepted.
EOF
}

REPO_SLUG="${REPO_SLUG:-${REPO:-PyloxLabs/pyloxdactyl}}"
REF="${REF:-main}"
SOURCE_DIR="${SOURCE_DIR:-}"

INSTALL_DIR="${INSTALL_DIR:-/opt/pyloxdactyl}"
DATA_DIR="${DATA_DIR:-/var/lib/pyloxdactyl}"
SERVICE_NAME="${SERVICE_NAME:-pyloxdactyl}"
SERVICE_USER="${SERVICE_USER:-pyloxdactyl}"
APP_PORT="${APP_PORT:-6000}"
APP_URL="${APP_URL:-}"
DB_DRIVER="${DB_DRIVER:-sqlite}"
DB_NAME="${DB_NAME:-pyloxdactyl}"
FORCE=0
PULL_YOLKS=0
NO_DOCKER=0
ACTION=""
HAD_ARGS=$(( $# > 0 ? 1 : 0 ))
ASSUME_YES=0
PKG_UPDATED=0
TMP_DIR=""
SRC_DIR=""
SOURCE_LABEL=""
LAST_BACKUP_DIR=""

cleanup() {
  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pyloxdactyl-install.XXXXXX")" || die "Could not create a temporary directory."
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install)          ACTION="install" ;;
    --update)           ACTION="update" ;;
    --eggs|--legacy-eggs) ACTION="eggs" ;;
    --uninstall)        ACTION="uninstall" ;;
    --repo)             REPO_SLUG="${2:-}"; shift ;;
    --repo=*)           REPO_SLUG="${1#*=}" ;;
    --ref)              REF="${2:-}"; shift ;;
    --ref=*)            REF="${1#*=}" ;;
    --branch)           REF="${2:-}"; shift ;;
    --branch=*)         REF="${1#*=}" ;;
    --source-dir)       SOURCE_DIR="${2:-}"; shift ;;
    --source-dir=*)     SOURCE_DIR="${1#*=}" ;;
    --db)               DB_DRIVER="${2:-}"; shift ;;
    --db=*)             DB_DRIVER="${1#*=}" ;;
    --port)             APP_PORT="${2:-}"; shift ;;
    --port=*)           APP_PORT="${1#*=}" ;;
    --url)              APP_URL="${2:-}"; shift ;;
    --url=*)            APP_URL="${1#*=}" ;;
    --install-dir)      INSTALL_DIR="${2:-}"; shift ;;
    --install-dir=*)    INSTALL_DIR="${1#*=}" ;;
    --data-dir)         DATA_DIR="${2:-}"; shift ;;
    --data-dir=*)       DATA_DIR="${1#*=}" ;;
    --service)          SERVICE_NAME="${2:-}"; shift ;;
    --service=*)        SERVICE_NAME="${1#*=}" ;;
    --pull-yolks)       PULL_YOLKS=1 ;;
    --no-docker)        NO_DOCKER=1 ;;
    --force)            FORCE=1 ;;
    -y|--yes)           ASSUME_YES=1 ;;
    -h|--help)          usage; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
  shift
done

DB_DRIVER="${DB_DRIVER,,}"

[[ "$(uname -s)" == "Linux" ]] || die "This installer supports Linux only."
[[ $EUID -eq 0 ]] || die "Run as root: sudo bash <(curl -fsSL https://install.pyloxdactyl.pylox.net)"

[[ "$REPO_SLUG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo must be OWNER/REPO."
[[ "$REF" =~ ^[A-Za-z0-9_./-]+$ ]] || die "--ref contains unsupported characters."
[[ "$DB_DRIVER" == "sqlite" || "$DB_DRIVER" == "mysql" ]] || die "--db must be sqlite or mysql."
[[ "$APP_PORT" =~ ^[0-9]+$ ]] || die "--port must be a number."
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_NAME must contain only letters, numbers and underscores."
[[ "$SERVICE_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || die "--service contains unsupported characters."
[[ "$SERVICE_USER" =~ ^[A-Za-z0-9_.-]+$ ]] || die "SERVICE_USER contains unsupported characters."
[[ -n "$INSTALL_DIR" && "$INSTALL_DIR" != "/" ]] || die "Invalid install directory."
[[ -n "$DATA_DIR" && "$DATA_DIR" != "/" ]] || die "Invalid data directory."

if [[ -z "$APP_URL" ]]; then
  APP_URL="http://localhost:${APP_PORT}"
fi

if [[ "$HAD_ARGS" -eq 1 && -n "$ACTION" ]]; then
  ASSUME_YES=1
fi
if [[ "$HAD_ARGS" -eq 0 && ! -t 0 ]]; then
  ACTION="install"
  ASSUME_YES=1
fi

PKG_MANAGER=""
if command -v apt-get >/dev/null 2>&1; then
  PKG_MANAGER="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG_MANAGER="dnf"
elif command -v yum >/dev/null 2>&1; then
  PKG_MANAGER="yum"
elif command -v apk >/dev/null 2>&1; then
  PKG_MANAGER="apk"
else
  die "No supported package manager found (apt/dnf/yum/apk)."
fi

pkg_update_once() {
  if [[ $PKG_UPDATED -eq 1 ]]; then
    return
  fi
  case "$PKG_MANAGER" in
    apt) apt-get update -qq ;;
    dnf|yum) "$PKG_MANAGER" -y makecache >/dev/null ;;
    apk) apk update >/dev/null ;;
  esac
  PKG_UPDATED=1
}

pkg_install() {
  case "$PKG_MANAGER" in
    apt) DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" ;;
    dnf|yum) "$PKG_MANAGER" -y install "$@" ;;
    apk) apk add --no-cache "$@" ;;
  esac
}

start_service() {
  local name="$1"
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl enable "$name" >/dev/null 2>&1 || true
    systemctl start "$name"
  elif command -v service >/dev/null 2>&1; then
    service "$name" start
  elif command -v rc-service >/dev/null 2>&1; then
    rc-service "$name" start
  else
    warn "Could not start $name automatically; no supported init system found."
  fi
}

node_major() {
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# ── UI helpers ───────────────────────────────────────────────────────────────
clear_screen() {
  printf '\033[2J\033[H'
}

type_line() {
  local color="$1"
  local text="$2"
  local i
  for (( i = 0; i < ${#text}; i++ )); do
    printf '%b%s%b' "$color" "${text:$i:1}" "$NC"
    sleep 0.006
  done
  printf '\n'
}

banner() {
  clear_screen
  printf '%s' "$PURPLE"
  cat <<'EOF'

   ██████╗ ██╗   ██╗██████╗ ██╗████████╗██╗   ██╗██╗     ███████╗
   ██╔══██╗██║   ██║██╔══██╗██║╚══██╔══╝╚██╗ ██╔╝██║     ██╔════╝
   ██████╔╝██║   ██║██████╔╝██║   ██║    ╚████╔╝ ██║     █████╗
   ██╔═══╝ ██║   ██║██╔══██╗██║   ██║     ╚██╔╝  ██║     ██╔══╝
   ██║     ╚██████╔╝██║  ██║██║   ██║      ██║   ███████╗███████╗
   ╚═╝      ╚═════╝ ╚═╝  ╚═╝╚═╝   ╚═╝      ╚═╝   ╚══════╝╚══════╝

EOF
  printf '%s' "$NC"
  type_line "$ORANGE" "   Self-hosted game server control panel"
  printf '\n'
}

step() {
  printf '\n%b━━ %s%b\n' "$PURPLE" "$1" "$NC"
}

run_with_spinner() {
  local label="$1"
  shift
  local log="$TMP_DIR/spinner.log"
  local pid status i
  local -a frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  : > "$log"

  "$@" > "$log" 2>&1 &
  pid=$!
  i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf '\r  %s %b%-64s%b' "${frames[$i]}" "$ORANGE" "$label" "$NC"
    i=$(( (i + 1) % ${#frames[@]} ))
    sleep 0.08
  done

  if wait "$pid"; then status=0; else status=$?; fi
  printf '\r  %*s\r' 90 ''

  if [[ $status -eq 0 ]]; then
    printf '  %b✓%b %s\n' "$GREEN" "$NC" "$label"
  else
    printf '  %b✗%b %s\n' "$RED" "$NC" "$label"
    cat "$log" >&2
    return "$status"
  fi
}

press_enter() {
  if [[ -t 0 ]]; then
    printf '\n%bPress Enter to return to the menu...%b' "$ORANGE" "$NC"
    read -r _ || true
  fi
}

ask_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
  local answer=""

  if [[ $ASSUME_YES -eq 1 || ! -t 0 ]]; then
    [[ "$default" == "y" ]]
    return
  fi

  if [[ "$default" == "y" ]]; then
    read -r -p "$prompt [Y/n]: " answer
    [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
  else
    read -r -p "$prompt [y/N]: " answer
    [[ "$answer" =~ ^[Yy] ]]
  fi
}

# ── Generic helpers ─────────────────────────────────────────────────────────
ensure_base_packages() {
  pkg_update_once
  case "$PKG_MANAGER" in
    apt)   pkg_install curl ca-certificates openssl git tar gnupg ;;
    dnf|yum) pkg_install curl ca-certificates openssl git tar shadow-utils ;;
    apk)   pkg_install curl ca-certificates openssl git tar shadow ;;
  esac
}

ensure_node() {
  ensure_base_packages
  if command -v node >/dev/null 2>&1 && (( $(node_major) >= 18 )); then
    ok "Node.js found: $(node --version)"
  else
    warn "Node.js 18+ not found; installing Node.js 20 LTS"
    case "$PKG_MANAGER" in
      apt)
        curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
        pkg_install nodejs
        ;;
      dnf|yum)
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
        pkg_install nodejs
        ;;
      apk)
        pkg_install nodejs npm
        ;;
    esac
    command -v node >/dev/null 2>&1 || die "Node.js installation failed."
    (( $(node_major) >= 18 )) || die "Node.js 18+ is still not available (found $(node --version))."
    ok "Node.js installed: $(node --version)"
  fi

  if ! command -v npm >/dev/null 2>&1; then
    warn "npm not found; installing it"
    pkg_install npm
    command -v npm >/dev/null 2>&1 || die "npm installation failed."
  fi
}

ensure_docker() {
  if [[ $NO_DOCKER -eq 1 ]]; then
    warn "Docker setup skipped (--no-docker)"
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker not found; installing Docker Engine"
    curl -fsSL https://get.docker.com | sh
    start_service docker
    ok "Docker installed: $(docker --version)"
  else
    ok "Docker found: $(docker --version)"
  fi

  if docker info >/dev/null 2>&1; then
    if ! docker network inspect pylox-servers >/dev/null 2>&1; then
      docker network create pylox-servers >/dev/null
      ok "Created Docker network: pylox-servers"
    else
      ok "Docker network pylox-servers already exists"
    fi
  else
    warn "Docker daemon is not reachable; create the pylox-servers network later."
  fi
}

prepare_source() {
  if [[ -n "$SOURCE_DIR" ]]; then
    SOURCE_DIR="$(cd "$SOURCE_DIR" 2>/dev/null && pwd)" || die "--source-dir is not a valid directory."
    [[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/server.js" ]] || die "--source-dir does not look like a Pyloxdactyl source tree."
    SRC_DIR="$SOURCE_DIR"
    SOURCE_LABEL="local: $SRC_DIR"
    ok "Using local source: $SRC_DIR"
    return
  fi

  mkdir -p "$SRC_DIR"
  local archive="$TMP_DIR/source.tar.gz"
  local url="https://api.github.com/repos/${REPO_SLUG}/tarball/${REF}"
  SOURCE_LABEL="GitHub: ${REPO_SLUG}@${REF}"

  run_with_spinner "Downloading ${REPO_SLUG} (${REF})" \
    curl -fsSL "$url" -o "$archive" || die "Failed to download $url"
  run_with_spinner "Extracting Pyloxdactyl source" \
    tar -xzf "$archive" -C "$SRC_DIR" --strip-components=1 || die "Failed to extract the source archive"

  [[ -f "$SRC_DIR/package.json" && -f "$SRC_DIR/server.js" ]] || die "Downloaded source does not look like Pyloxdactyl."
}

read_version() {
  local file="$1"
  local version=""

  if command -v node >/dev/null 2>&1; then
    version="$(node -e 'process.stdout.write(String(require(process.argv[1]).version || ""))' "$file" 2>/dev/null || true)"
  fi
  if [[ -z "$version" ]]; then
    version="$(grep -m1 -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$file" 2>/dev/null | cut -d'"' -f4 || true)"
  fi
  printf '%s' "${version#v}"
}

semver_gt() {
  local a="${1#v}" b="${2#v}"
  a="${a%%-*}"
  b="${b%%-*}"
  local IFS=.
  local -a av=($a) bv=($b)
  local i x y

  for i in 0 1 2; do
    x="${av[$i]:-0}"
    y="${bv[$i]:-0}"
    x="${x//[!0-9]/}"
    y="${y//[!0-9]/}"
    x="${x:-0}"
    y="${y:-0}"
    if (( 10#$x > 10#$y )); then return 0; fi
    if (( 10#$x < 10#$y )); then return 1; fi
  done
  return 1
}

env_value() {
  local key="$1"
  local file="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | head -n1 | cut -d= -f2- || true
}

load_metadata() {
  local meta="$INSTALL_DIR/.pyloxdactyl-install"
  if [[ -f "$meta" ]]; then
    # shellcheck disable=SC1090
    source "$meta"
  fi
}

write_metadata() {
  {
    printf 'SERVICE_NAME=%q\n' "$SERVICE_NAME"
    printf 'SERVICE_USER=%q\n' "$SERVICE_USER"
    printf 'INSTALL_DIR=%q\n' "$INSTALL_DIR"
    printf 'DATA_DIR=%q\n' "$DATA_DIR"
    printf 'APP_PORT=%q\n' "$APP_PORT"
  } > "$INSTALL_DIR/.pyloxdactyl-install"
}

write_systemd_unit() {
  command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]] || return 0
  local node_path
  node_path="$(command -v node)"

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Pyloxdactyl
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${node_path} ${INSTALL_DIR}/server.js
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
}

restart_panel() {
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl restart "$SERVICE_NAME" >/dev/null 2>&1 || {
      systemctl daemon-reload >/dev/null 2>&1 || true
      systemctl restart "$SERVICE_NAME"
    }
    ok "Service ${SERVICE_NAME} restarted"
  else
    warn "systemd not detected; restart the panel manually if needed."
  fi
}

install_node_deps() {
  if [[ -f "$INSTALL_DIR/package-lock.json" ]]; then
    (cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund)
  else
    (cd "$INSTALL_DIR" && npm install --omit=dev --no-audit --no-fund)
  fi
}

init_database() {
  (cd "$INSTALL_DIR" && node -e '
    const db = require(process.cwd() + "/lib/db");
    (async () => {
      for (let i = 0; i < 200 && !db.ready(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!db.ready()) throw new Error("Database did not become ready");
      db.save();
      process.exit(0);
    })().catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
  ')
}

panel_port() {
  local port=""
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    port="$(env_value APP_PORT "$INSTALL_DIR/.env")"
  fi
  printf '%s' "${port:-$APP_PORT}"
}

health_check() {
  local port="$1"
  local healthy=0
  local i

  for i in {1..15}; do
    if curl -fsS "http://127.0.0.1:${port}/auth/login" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 1
  done

  if [[ $healthy -eq 1 ]]; then
    ok "Panel is responding on port ${port}"
  else
    warn "Panel did not respond on port ${port} yet. Check service logs."
    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
      log "  journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
    fi
  fi
}

final_summary() {
  log ""
  log -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  log -e "${GREEN}  Pyloxdactyl ready${NC}"
  log -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  log ""
  log -e "  URL:           ${YELLOW}${APP_URL}${NC}"
  log -e "  Source:        ${YELLOW}${SOURCE_LABEL}${NC}"
  log -e "  Install dir:   ${YELLOW}${INSTALL_DIR}${NC}"
  log -e "  Data dir:      ${YELLOW}${DATA_DIR}${NC}"
  log -e "  Database:      ${YELLOW}${DB_DRIVER}${NC}"
  log -e "  Service:       ${YELLOW}${SERVICE_NAME}${NC}"
  if [[ -n "$LAST_BACKUP_DIR" ]]; then
    log -e "  Backup:        ${YELLOW}${LAST_BACKUP_DIR}${NC}"
  fi
  log ""
  log -e "  ${PURPLE}Next steps:${NC}"
  log -e "    1. Open ${APP_URL} and register. The first user becomes root admin."
  log -e "    2. Install the daemon separately, then add its address/token as a node in Admin -> Nodes."
  log -e "    3. Add allocations, import eggs, and create a server."
  log ""
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    log -e "  ${PURPLE}Service commands:${NC}"
    log -e "    systemctl status ${SERVICE_NAME}"
    log -e "    systemctl restart ${SERVICE_NAME}"
    log -e "    journalctl -u ${SERVICE_NAME} -f"
    log ""
  fi
}

# ── 1. Install ───────────────────────────────────────────────────────────────
write_env() {
  local db_host="127.0.0.1"
  local db_port="3306"
  local db_user="pyloxdactyl"
  local db_password=""
  local daemon_secret
  daemon_secret="$(openssl rand -hex 32)"

  if [[ "$DB_DRIVER" == "mysql" ]]; then
    info "Installing MariaDB/MySQL and creating the panel database"
    case "$PKG_MANAGER" in
      apt) pkg_install mariadb-server mariadb-client ;;
      dnf|yum) pkg_install mysql-server ;;
      apk) pkg_install mariadb mariadb-client ;;
    esac

    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
      start_service mariadb 2>/dev/null || start_service mysql 2>/dev/null || start_service mysqld
    else
      start_service mariadb 2>/dev/null || start_service mysql 2>/dev/null || true
    fi

    db_password="$(openssl rand -hex 24)"
    local mysql_bin
    mysql_bin="$(command -v mariadb || command -v mysql || true)"
    [[ -n "$mysql_bin" ]] || die "Neither mariadb nor mysql CLI was found after installation."

    "$mysql_bin" <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${db_user}'@'localhost' IDENTIFIED BY '${db_password}';
CREATE USER IF NOT EXISTS '${db_user}'@'127.0.0.1' IDENTIFIED BY '${db_password}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${db_user}'@'localhost';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${db_user}'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
    ok "MySQL database ${DB_NAME} ready"
  fi

  if [[ -f "$INSTALL_DIR/.env" ]]; then
    cp -f "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.bak.$(date +%s)"
    warn "Existing .env backed up before regeneration"
  fi

  umask 077
  cat > "$INSTALL_DIR/.env" <<EOF
# Pyloxdactyl Configuration (generated $(date -u +%Y-%m-%dT%H:%M:%SZ))
NODE_ENV=production
APP_PORT=${APP_PORT}
APP_URL=${APP_URL}
APP_KEY=$(openssl rand -hex 32)

# Database
DB_DRIVER=${DB_DRIVER}
DB_PATH=${DATA_DIR}/panel.db
DB_HOST=${db_host}
DB_PORT=${db_port}
DB_USER=${db_user}
DB_PASSWORD=${db_password}
DB_NAME=${DB_NAME}
DB_CONNECT_TIMEOUT=10000
DB_QUERY_TIMEOUT=30000

# Session
SESSION_SECRET=$(openssl rand -hex 32)

# Daemon
DAEMON_SECRET=${daemon_secret}
DAEMON_URL=http://127.0.0.1:8080

# Docker / Pterodactyl-compatible game containers
DOCKER_SOCKET=/var/run/docker.sock
DOCKER_NETWORK=pylox-servers

# File Upload
MAX_UPLOAD_SIZE=100
EOF
  umask 022
  chown root:"$SERVICE_USER" "$INSTALL_DIR/.env"
  chmod 640 "$INSTALL_DIR/.env"
  ok "Configuration written to $INSTALL_DIR/.env"
}

copy_source_fresh() {
  tar --exclude='./node_modules' \
      --exclude='./.git' \
      --exclude='./data' \
      --exclude='./.env' \
      --exclude='*.db' \
      --exclude='*.db-shm' \
      --exclude='*.db-wal' \
      -cf - -C "$SRC_DIR" . | tar -xf - -C "$INSTALL_DIR"

  if [[ -d "$SRC_DIR/data/extensions" ]]; then
    cp -an "$SRC_DIR/data/extensions/." "$DATA_DIR/extensions/" 2>/dev/null || true
  fi

  if [[ -L "$INSTALL_DIR/data" || -f "$INSTALL_DIR/data" ]]; then
    rm -f "$INSTALL_DIR/data"
  elif [[ -d "$INSTALL_DIR/data" ]]; then
    mv "$INSTALL_DIR/data" "${DATA_DIR}.legacy-$(date +%s)"
  fi
  ln -s "$DATA_DIR" "$INSTALL_DIR/data"
}

do_install() {
  banner
  type_line "$PURPLE" "Fresh installation"

  if [[ -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR" ]]; then
    die "$INSTALL_DIR exists but is not a directory."
  fi
  if [[ -d "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" && $FORCE -eq 0 ]]; then
    die "$INSTALL_DIR is not empty. Use --force to install over it, or set --install-dir."
  fi

  step "1/10  Installing base packages"
  ensure_base_packages
  ok "Base packages ready"

  step "2/10  Fetching Pyloxdactyl source"
  prepare_source

  step "3/10  Checking Node.js"
  ensure_node

  step "4/10  Docker / Pterodactyl compatibility"
  ensure_docker

  step "5/10  Creating service user and directories"
  local nologin
  nologin="$(command -v nologin || true)"
  [[ -n "$nologin" ]] || nologin="/usr/sbin/nologin"

  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$DATA_DIR" --shell "$nologin" "$SERVICE_USER"
    ok "Created service user: $SERVICE_USER"
  else
    ok "Service user already exists: $SERVICE_USER"
  fi

  mkdir -p "$INSTALL_DIR" "$DATA_DIR/extensions" "$DATA_DIR/backups" "$DATA_DIR/uploads"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
  chmod 750 "$DATA_DIR"

  step "6/10  Copying panel files"
  run_with_spinner "Installing panel files" copy_source_fresh || die "Failed to copy panel files"
  mkdir -p "$INSTALL_DIR/public/uploads/branding"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/public/uploads"
  chown -h "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/data"
  ok "Panel files installed in $INSTALL_DIR"

  step "7/10  Writing configuration"
  write_env
  write_metadata

  step "8/10  Installing dependencies and initializing the database"
  run_with_spinner "Installing Node dependencies" install_node_deps || die "Dependency installation failed"
  run_with_spinner "Initializing database" init_database || die "Database initialization failed"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

  step "9/10  Registering the panel service"
  write_systemd_unit
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl enable "$SERVICE_NAME" >/dev/null
    systemctl restart "$SERVICE_NAME"
    ok "Service ${SERVICE_NAME} enabled and started"
  else
    warn "systemd not detected; start the panel manually:"
    log "  cd $INSTALL_DIR && node server.js"
  fi

  step "10/10  Pterodactyl-compatible container images"
  if [[ $PULL_YOLKS -eq 1 ]]; then
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      run_with_spinner "Pulling yolks:java_17" docker pull ghcr.io/pterodactyl/yolks:java_17 || warn "Could not pull yolks:java_17"
      run_with_spinner "Pulling yolks:alpine" docker pull ghcr.io/pterodactyl/yolks:alpine || warn "Could not pull yolks:alpine"
      ok "Pterodactyl yolks images ready"
    else
      warn "Docker is not reachable; could not pre-pull yolks images."
    fi
  else
    ok "Skipped pre-pulling yolks images (use --pull-yolks to enable)"
  fi

  health_check "$APP_PORT"
  final_summary
}

# ── 2. Update ────────────────────────────────────────────────────────────────
backup_for_update() {
  local stamp
  stamp="$(date +%Y%m%d-%H%M%S)"
  LAST_BACKUP_DIR="${DATA_DIR}/update-backups/${stamp}"
  mkdir -p "$LAST_BACKUP_DIR"

  if [[ -f "$INSTALL_DIR/.env" ]]; then
    cp -a "$INSTALL_DIR/.env" "$LAST_BACKUP_DIR/.env"
  fi
  if [[ -f "$INSTALL_DIR/.pyloxdactyl-install" ]]; then
    cp -a "$INSTALL_DIR/.pyloxdactyl-install" "$LAST_BACKUP_DIR/.pyloxdactyl-install"
  fi

  local db_path_value=""
  if [[ -f "$INSTALL_DIR/.env" ]]; then
    db_path_value="$(env_value DB_PATH "$INSTALL_DIR/.env")"
  fi
  if [[ -n "$db_path_value" ]]; then
    [[ "$db_path_value" = /* ]] || db_path_value="$INSTALL_DIR/$db_path_value"
    if [[ -f "$db_path_value" ]]; then
      cp -a "$db_path_value" "$LAST_BACKUP_DIR/panel.db"
    fi
  elif [[ -f "$DATA_DIR/panel.db" ]]; then
    cp -a "$DATA_DIR/panel.db" "$LAST_BACKUP_DIR/panel.db"
  fi

  if [[ -d "$DATA_DIR/extensions" ]]; then
    cp -a "$DATA_DIR/extensions" "$LAST_BACKUP_DIR/extensions"
  fi
  if [[ -d "$INSTALL_DIR/public/uploads" ]]; then
    cp -a "$INSTALL_DIR/public/uploads" "$LAST_BACKUP_DIR/public-uploads"
  fi

  chown -R "$SERVICE_USER:$SERVICE_USER" "$LAST_BACKUP_DIR" 2>/dev/null || true
}

copy_source_update() {
  tar --exclude='./node_modules' \
      --exclude='./.git' \
      --exclude='./data' \
      --exclude='./.env' \
      --exclude='./public/uploads' \
      --exclude='./.pyloxdactyl-install' \
      --exclude='*.db' \
      --exclude='*.db-shm' \
      --exclude='*.db-wal' \
      -cf - -C "$SRC_DIR" . | tar -xf - -C "$INSTALL_DIR"
}

do_update() {
  banner
  type_line "$PURPLE" "Checking for updates"

  [[ -f "$INSTALL_DIR/package.json" ]] || die "Pyloxdactyl does not appear to be installed in $INSTALL_DIR."
  load_metadata

  step "1/6  Preparing"
  ensure_base_packages
  ensure_node

  local local_version remote_version
  local_version="$(read_version "$INSTALL_DIR/package.json")"
  [[ -n "$local_version" ]] || local_version="0.0.0"

  step "2/6  Fetching ${REPO_SLUG} (${REF})"
  prepare_source
  remote_version="$(read_version "$SRC_DIR/package.json")"
  [[ -n "$remote_version" ]] || die "Could not read the remote package version."

  if ! semver_gt "$remote_version" "$local_version"; then
    ok "Already up to date (local ${local_version}, remote ${remote_version})."
    return
  fi

  info "Update available: ${local_version} -> ${remote_version}"
  if [[ $ASSUME_YES -eq 0 ]] && ! ask_yes_no "Apply this update?" y; then
    warn "Update cancelled."
    return
  fi

  step "3/6  Backing up .env, database, extensions and uploads"
  run_with_spinner "Creating update backup" backup_for_update || die "Backup failed; update cancelled."
  ok "Backup saved to ${LAST_BACKUP_DIR}"

  step "4/6  Installing updated files"
  run_with_spinner "Replacing panel files" copy_source_update || die "Failed to install updated files."

  step "5/6  Refreshing dependencies and database schema"
  run_with_spinner "Installing Node dependencies" install_node_deps || die "Dependency installation failed"
  run_with_spinner "Applying database migrations" init_database || die "Database migration failed"

  step "6/6  Restarting panel"
  restart_panel
  health_check "$(panel_port)"

  APP_URL="$(env_value APP_URL "$INSTALL_DIR/.env" || true)"
  [[ -n "$APP_URL" ]] || APP_URL="http://localhost:$(panel_port)"
  final_summary
}

# ── 3. Legacy eggs ───────────────────────────────────────────────────────────
show_legacy_egg_list() {
  cat <<'LIST'

  %bMinecraft%b
    - Waterfall
    - Velocity
    - Quilt
    - Folia
    - Sponge/SpongeNeo
    - Fabric
    - Sponge/SpongeVanilla
    - Purpur
    - Limbo
    - Bungeecord
    - Vanilla Minecraft
    - Neoforge
    - Paper
    - Sponge/SpongeForge
    - Forge Minecraft

  %bHytale%b
    - Hytale

  %bSource Engine%b
    - Counter Strike: Global Offensive
    - Team Fortress 2
    - Garrys Mod
    - Ark:Survival Envolved
    - Custom Source Engine Game
    - Insurgery

  %bVoice Servers%b
    - TeamSpeak 3 Server
    - Mumble Server

  %bRust%b
    - Rust

  %bVintage Story%b
    - Vintage Story

  %bGeneric%b
    - node.js generic
    - python generic
    - Nginx Egg

LIST
}

install_legacy_eggs() {
  banner
  type_line "$PURPLE" "Legacy eggs installer"

  [[ -f "$INSTALL_DIR/package.json" ]] || die "Pyloxdactyl does not appear to be installed in $INSTALL_DIR."
  load_metadata
  ensure_node

  step "Egg list"
  printf '%b' "$PURPLE"
  show_legacy_egg_list | while IFS= read -r line; do
    printf '%b\n' "$line"
  done
  printf '%b' "$NC"

  if [[ $ASSUME_YES -eq 0 ]] && ! ask_yes_no "Import these nests and eggs?" y; then
    warn "Egg import cancelled."
    return
  fi

  step "Importing from Pterodactyl / Pelican / PyloxLabs repositories"

  cat > "$TMP_DIR/import-legacy-eggs.js" <<'NODE'
const crypto = require('crypto');
const APP_DIR = process.env.PYLOXDACTYL_INSTALL_DIR || process.cwd();
const db = require(`${APP_DIR}/lib/db`);
const { parseEggJson } = require(`${APP_DIR}/lib/egg-import`);

const nests = [
  { name: 'Minecraft', description: 'Minecraft - the classic game from Mojang. With support for Vanilla MC, Spigot, and many others!' },
  { name: 'Hytale', description: 'Hytale - A new sandbox game from Hypixel Studios.' },
  { name: 'Source Engine', description: 'Includes support for most Source Dedicated Server games.' },
  { name: 'Voice Servers', description: 'Voice servers such as Mumble and Teamspeak 3.' },
  { name: 'Rust', description: 'Rust - A game where you must fight to survive.' },
  { name: 'Vintage Story', description: 'Vintage Story - An uncompromising wilderness survival sandbox game.' },
  { name: 'Generic', description: 'A list of generic software for coding.' },
];

const eggs = [
  {
    nest: 'Minecraft', name: 'Waterfall',
    description: `Waterfall is a fork of the well-known BungeeCord server proxy.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/proxy/java/waterfall/egg-waterfall.json',
  },
  {
    nest: 'Minecraft', name: 'Velocity',
    description: `Velocity is a Minecraft server proxy with unparalleled server support, scalability, and flexibility.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/proxy/java/velocity/egg-velocity.json',
  },
  {
    nest: 'Minecraft', name: 'Quilt',
    description: `Quilt Server. Quilt is a lightweight mod loader for Minecraft based on Fabric Loader, with support for snapshots and fast updates to new versions.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/quilt/egg-quilt.json',
  },
  {
    nest: 'Minecraft', name: 'Folia',
    description: `Fork of Paper which adds recognised multithreading to the dedicated server.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/folia/egg-folia.json',
  },
  {
    nest: 'Minecraft', name: 'Sponge/SpongeNeo',
    description: `SpongeNeo is the SpongeAPI implementation for Neoforge Loader.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/neoforge/egg-neoforge.json',
  },
  {
    nest: 'Minecraft', name: 'Fabric',
    description: `Fabric Server. Fabric is a lightweight mod loader for Minecraft, with support for snapshots and fast updates to new versions.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/fabric/egg-fabric.json',
  },
  {
    nest: 'Minecraft', name: 'Sponge/SpongeVanilla',
    description: `SpongeVanilla is the SpongeAPI implementation for Vanilla Minecraft.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/spongevanilla/egg-sponge-vanilla.json',
  },
  {
    nest: 'Minecraft', name: 'Purpur',
    description: `A drop-in replacement for Paper servers designed for configurability, and new fun and exciting gameplay features.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/purpur/egg-purpur.json',
  },
  {
    nest: 'Minecraft', name: 'Limbo',
    description: `Standalone server program Limbo.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/limbo/egg-limbo.json',
  },
  {
    nest: 'Minecraft', name: 'Bungeecord',
    description: `For a long time, Minecraft server owners have had a dream that encompasses a free, easy, and reliable way to connect multiple Minecraft servers together. BungeeCord is the answer to said dream. Whether you are a small server wishing to string multiple game-modes together, or the owner of the ShotBow Network, BungeeCord is the ideal solution for you. With the help of BungeeCord, you will be able to unlock your community's full potential.`,
    repo: 'pelican-eggs/minecraft', path: 'proxy/java/bungeecord/pterodactyl-egg-bungeecord.json',
  },
  {
    nest: 'Minecraft', name: 'Vanilla Minecraft',
    description: `Minecraft is a game about placing blocks and going on adventures. Explore randomly generated worlds and build amazing things from the simplest of homes to the grandest of castles. Play in Creative Mode with unlimited resources or mine deep in Survival Mode, crafting weapons and armor to fend off dangerous mobs. Do all this alone or with friends.`,
    repo: 'pelican-eggs/minecraft', path: 'java/vanilla/pterodactyl-egg-vanilla-minecraft.json',
  },
  {
    nest: 'Minecraft', name: 'Neoforge',
    description: `Minecraft Neoforge Server. Minecraft Neoforge is a modding API (Application Programming Interface), which makes it easier to create mods, and also make sure mods are compatible with each other.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/neoforge/egg-neoforge.json',
  },
  {
    nest: 'Minecraft', name: 'Paper',
    description: `High performance Spigot fork that aims to fix gameplay and mechanics inconsistencies.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/paper/egg-paper.json',
  },
  {
    nest: 'Minecraft', name: 'Sponge/SpongeForge',
    description: `SpongeForge is the SpongeAPI implementation for Forge Loader.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/spongeforge/egg-sponge-forge.json',
  },
  {
    nest: 'Minecraft', name: 'Forge Minecraft',
    description: `Minecraft Forge Server. Minecraft Forge is a modding API (Application Programming Interface), which makes it easier to create mods, and also make sure mods are compatible with each other.`,
    repo: 'pterodactyl/game-eggs', path: 'minecraft/java/forge/egg-forge-enhanced.json',
  },
  {
    nest: 'Hytale', name: 'Hytale',
    description: `Set out on an adventure built for both creation and play. Hytale blends the freedom of a sandbox with the momentum of an RPG: explore a procedurally generated world full of dungeons, secrets, and a variety of creatures, then shape it block by block.`,
    repo: 'pterodactyl/game-eggs', path: 'hytale/egg-hytale.json',
  },
  {
    nest: 'Source Engine', name: 'Counter Strike: Global Offensive',
    description: `Counter-Strike: Global Offensive is a multiplayer first-person shooter video game developed by Hidden Path Entertainment and Valve Corporation.`,
    repo: 'pterodactyl/game-eggs', path: 'counter_strike/counter_strike_2/egg-counter--strike2.json',
  },
  {
    nest: 'Source Engine', name: 'Team Fortress 2',
    description: `Team Fortress 2 is a team-based first-person shooter multiplayer video game developed and published by Valve Corporation. It is the sequel to the 1996 mod Team Fortress for Quake and its 1999 remake.`,
    repo: 'pterodactyl/game-eggs', path: 'team_fortress_2/egg-team-fortress-2.json',
  },
  {
    nest: 'Source Engine', name: 'Garrys Mod',
    description: `Garrys Mod, is a sandbox physics game created by Garry Newman, and developed by his company, Facepunch Studios.`,
    repo: 'pterodactyl/game-eggs', path: 'gmod/egg-garry-s-mod.json',
  },
  {
    nest: 'Source Engine', name: 'Ark:Survival Envolved',
    description: `As a man or woman stranded, naked, freezing, and starving on the unforgiving shores of a mysterious island called ARK, use your skill and cunning to kill or tame and ride the plethora of leviathan dinosaurs and other primeval creatures roaming the land. Hunt, harvest resources, craft items, grow crops, research technologies, and build shelters to withstand the elements and store valuables, all while teaming up with (or preying upon) hundreds of other players to survive, dominate... and escape! — Gamepedia: ARK`,
    repo: 'pterodactyl/game-eggs', path: 'ark_survival_evolved/egg-ark--survival-evolved.json',
  },
  {
    nest: 'Source Engine', name: 'Custom Source Engine Game',
    description: `This option allows modifying the startup arguments and other details to run a custom SRCDS based game on the panel.`,
    repo: 'pterodactyl/game-eggs', path: 'hlds_server/vanilla/egg-custom-h-l-d-s-engine-game.json',
  },
  {
    nest: 'Source Engine', name: 'Insurgery',
    description: `Take to the streets for intense close quarters combat, where a team's survival depends upon securing crucial strongholds and destroying enemy supply in this multiplayer and cooperative Source Engine based experience.`,
    repo: 'pterodactyl/game-eggs', path: 'insurgency_sandstorm/egg-insurgency--sandstorm.json',
  },
  {
    nest: 'Voice Servers', name: 'TeamSpeak 3 Server',
    description: `VoIP software designed with security in mind, featuring crystal clear voice quality, endless customization options, and scalabilty up to thousands of simultaneous users.`,
    repo: 'pelican-eggs/voice', path: 'teamspeak/ts3/egg-pterodactyl-teamspeak3.json',
  },
  {
    nest: 'Voice Servers', name: 'Mumble Server',
    description: `Mumble is an open source, low-latency, high quality voice chat software primarily intended for use while gaming.`,
    repo: 'pelican-eggs/voice', path: 'mumble/egg-pterodactyl-mumble-server.json',
  },
  {
    nest: 'Rust', name: 'Rust',
    description: `The only aim in Rust is to survive. To do this you will need to overcome struggles such as hunger, thirst and cold. Build a fire. Build a shelter. Kill animals for meat. Protect yourself from other players, and kill them for meat. Create alliances with other players and form a town. Do whatever it takes to survive.`,
    repo: 'pelican-eggs/games-steamcmd', path: 'rust/vanilla/egg-pterodactyl-rust.json',
  },
  {
    nest: 'Vintage Story', name: 'Vintage Story',
    description: `Vintage Story is an uncompromising wilderness survival sandbox game inspired by lovecraftian horror themes. Find yourself in a ruined world reclaimed by nature and permeated by unnerving temporal disturbances. Relive the advent of human civilization, or take your own path.`,
    repo: 'pelican-eggs/games-standalone', path: 'vintage_story/egg-vintage-story.json',
  },
  {
    nest: 'Generic', name: 'node.js generic',
    description: `A generic node.js egg This will clone a git repo. It defaults to master if no branch is specified. Installs the node_modules on install. If you set user_upload then I assume you know what you are doing.`,
    repo: 'PyloxLabs/generic-eggs', path: 'egg-node-js-generic.json',
  },
  {
    nest: 'Generic', name: 'python generic',
    description: `A Generic Python Egg for Pterodactyl Tested with: https://github.com/Ispira/pixel-bot`,
    repo: 'PyloxLabs/generic-eggs', path: 'egg-python-generic.json',
  },
  {
    nest: 'Generic', name: 'Nginx Egg',
    description: `Pterodactyl Nginx Egg The Pterodactyl Nginx Egg is a web server solution for Pterodactyl, featuring Nginx, PHP, Git support, Cloudflare Tunnel integration, composer and optional WordPress installation. It supports AMD64 & ARM64 architectures and allows users to choose their preferred PHP version (8.0 – 8.4). Key Features: ✅ Supports multiple PHP versions ✅ Git integration for automatic deployment ✅ Cloudflare Tunnel support for secure remote access ✅ Optional WordPress setup ✅ HTTPS configuration support ✅ Automatic updates for Git repositories`,
    repo: 'PyloxLabs/generic-eggs', path: 'egg-nginx.json',
  },
];

async function waitForDb() {
  for (let i = 0; i < 200; i++) {
    if (db.ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Database did not become ready');
}

function ensureNest(name, description, authorId) {
  let row = db.prepare('SELECT id FROM nests WHERE name = ?').get(name);
  if (!row) {
    const result = db.prepare(
      'INSERT INTO nests (uuid, author_id, name, description) VALUES (?, ?, ?, ?)'
    ).run(crypto.randomUUID(), authorId, name, description);
    return result.lastInsertRowid;
  }
  db.prepare(
    "UPDATE nests SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (description IS NULL OR description = '')"
  ).run(description, row.id);
  return row.id;
}

async function fetchEgg(spec) {
  const url = `https://raw.githubusercontent.com/${spec.repo}/main/${spec.path}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Pyloxdactyl-Legacy-Eggs/1.0' },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const data = JSON.parse(await response.text());
  data.name = spec.name;
  data.description = spec.description;
  return parseEggJson(JSON.stringify(data));
}

(async () => {
  await waitForDb();

  const admin = db.prepare('SELECT id FROM users WHERE root_admin = 1 ORDER BY id LIMIT 1').get()
    || db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const authorId = admin ? admin.id : null;

  const nestIds = {};
  for (const nest of nests) {
    nestIds[nest.name] = ensureNest(nest.name, nest.description, authorId);
  }

  let imported = 0;
  let skipped = 0;
  const failures = [];

  for (const spec of eggs) {
    try {
      const parsed = await fetchEgg(spec);
      const nestId = nestIds[spec.nest];
      const existing = db.prepare('SELECT id FROM eggs WHERE name = ? AND nest_id = ?').get(parsed.name, nestId);
      if (existing) {
        skipped++;
        continue;
      }

      const result = db.prepare(`INSERT INTO eggs
        (name, description, docker_image, docker_images, startup, features, file_denylist, config, install_script, author, nest_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        parsed.name,
        parsed.description,
        parsed.docker_image,
        parsed.docker_images,
        parsed.startup,
        parsed.features,
        parsed.file_denylist,
        parsed.config,
        parsed.install_script,
        parsed.author,
        nestId
      );

      const eggId = result.lastInsertRowid;
      const varStmt = db.prepare(`INSERT INTO egg_variables
        (egg_id, name, description, env_var, default_value, user_viewable, user_editable, rules, sort_order, field_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const variable of parsed.variables) {
        varStmt.run(
          eggId,
          variable.name,
          variable.description,
          variable.env_var,
          variable.default_value,
          variable.user_viewable,
          variable.user_editable,
          variable.rules,
          variable.sort_order,
          variable.field_type
        );
      }
      imported++;
    } catch (error) {
      failures.push(`${spec.name}: ${error.message || error}`);
    }
  }

  db.save();
  console.log(`Nests ready: ${Object.keys(nestIds).length}`);
  console.log(`Eggs imported: ${imported}`);
  console.log(`Eggs skipped (already present): ${skipped}`);
  if (failures.length) {
    console.log('Failed eggs:');
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  process.exit(failures.length ? 2 : 0);
})().catch((error) => {
  console.error('Egg import failed:', error.message || error);
  process.exit(1);
});
NODE

  if (cd "$INSTALL_DIR" && PYLOXDACTYL_INSTALL_DIR="$INSTALL_DIR" node "$TMP_DIR/import-legacy-eggs.js"); then
    ok "Legacy egg import finished."
  else
    warn "Some eggs failed to import; see the messages above."
  fi
}

# ── 4. Uninstall ─────────────────────────────────────────────────────────────
do_uninstall() {
  banner
  type_line "$PURPLE" "Uninstalling Pyloxdactyl"

  load_metadata
  [[ -e "$INSTALL_DIR" ]] || die "Nothing to uninstall in $INSTALL_DIR."

  step "1/4  Stopping the panel service"
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    service "$SERVICE_NAME" stop >/dev/null 2>&1 || true
  fi
  ok "Panel service stopped"

  step "2/4  Removing the systemd unit"
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  ok "Systemd unit removed"

  step "3/4  Removing panel files"
  rm -rf "$INSTALL_DIR"
  ok "Removed $INSTALL_DIR"

  step "4/4  Data cleanup"
  if ask_yes_no "Also remove ${DATA_DIR} (database, extensions and uploads)?" n; then
    rm -rf "$DATA_DIR"
    id -u "$SERVICE_USER" >/dev/null 2>&1 && userdel "$SERVICE_USER" >/dev/null 2>&1 || true
    ok "Removed ${DATA_DIR} and user ${SERVICE_USER}"
  else
    warn "Kept ${DATA_DIR} and user ${SERVICE_USER}."
  fi

  log ""
  log -e "${ORANGE}Pyloxdactyl has been uninstalled.${NC}"
}

# ── Menu ─────────────────────────────────────────────────────────────────────
show_menu() {
  banner
  printf '%b  %s%b\n' "$ORANGE" "Main menu" "$NC"
  printf '\n'
  printf '  %b[1]%b %bInstall Pyloxdactyl%b\n' "$PURPLE" "$NC" "$ORANGE" "$NC"
  printf '  %b[2]%b %bUpdate Pyloxdactyl%b\n' "$PURPLE" "$NC" "$ORANGE" "$NC"
  printf '  %b[3]%b %bInstall Legacy Eggs%b\n' "$PURPLE" "$NC" "$ORANGE" "$NC"
  printf '  %b[4]%b %bUninstall Pyloxdactyl%b\n' "$PURPLE" "$NC" "$ORANGE" "$NC"
  printf '  %b[0]%b %bExit%b\n' "$PURPLE" "$NC" "$ORANGE" "$NC"
  printf '\n'
}

main_menu() {
  local choice=""
  while true; do
    show_menu
    printf '%bSelect an option:%b ' "$PURPLE" "$NC"
    read -r choice || exit 0
    case "$choice" in
      1) do_install ;;
      2) do_update ;;
      3) install_legacy_eggs ;;
      4) do_uninstall ;;
      0) exit 0 ;;
      *) warn "Invalid option: $choice" ;;
    esac
    press_enter
  done
}

case "$ACTION" in
  install)   do_install ;;
  update)    do_update ;;
  eggs)      install_legacy_eggs ;;
  uninstall) do_uninstall ;;
  *)         main_menu ;;
esac
