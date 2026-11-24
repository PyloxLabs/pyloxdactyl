import json

with open('locales/en.json','r',encoding='utf-8') as f:
    en = json.load(f)

trans = {
    'Loading...': 'Cargando...',
    'Refresh': 'Actualizar',
    'Save': 'Guardar',
    'Cancel': 'Cancelar',
    'Close': 'Cerrar',
    'Yes': 'Sí',
    'No': 'No',
    'Delete': 'Eliminar',
    'Edit': 'Editar',
    'Create': 'Crear',
    'Back': 'Atrás',
    'Next': 'Siguiente',
    'Submit': 'Enviar',
    'Search': 'Buscar',
    'Filter': 'Filtrar',
    'Show': 'Mostrar',
    'Hide': 'Ocultar',
    'Copy': 'Copiar',
    'Copied': 'Copiado',
    'Continue': 'Continuar',
    'Done': 'Hecho',
    'View': 'Ver',
    'Manage': 'Gestionar',
    'Configure': 'Configurar',
    'Settings': 'Configuración',
    'Help': 'Ayuda',
    'Support': 'Soporte',
    'Documentation': 'Documentación',
    'Information': 'Información',
    'Enabled': 'Habilitado',
    'Disabled': 'Deshabilitado',
    'Active': 'Activo',
    'Inactive': 'Inactivo',
    'Enabled?': '¿Habilitado?',
    'General': 'General',
    'Advanced': 'Avanzado',
    'Security': 'Seguridad',
    'Name': 'Nombre',
    'Label': 'Etiqueta',
    'Description': 'Descripción',
    'Email': 'Correo electrónico',
    'Password': 'Contraseña',
    'Username': 'Nombre de usuario',
    'Language': 'Idioma',
    'Status': 'Estado',
    'Online': 'En línea',
    'Offline': 'Sin conexión',
    'Free': 'Libre',
    'Assigned': 'Asignado',
    'Pending': 'Pendiente',
    'Success': 'Éxito',
    'Error': 'Error',
    'Warning': 'Advertencia',
    'Connecting...': 'Conectando...',
    'Connected': 'Conectado',
    'Disconnected': 'Desconectado',
    'Failed': 'Fallido',
    'Actions': 'Acciones',
    'Details': 'Detalles',
    'Overview': 'Resumen',
    'Resources': 'Recursos',
    'Network': 'Red',
    'Users': 'Usuarios',
    'Files': 'Archivos',
    'Console': 'Consola',
    'Power': 'Encendido',
    'Start': 'Iniciar',
    'Stop': 'Detener',
    'Restart': 'Reiniciar',
    'Kill': 'Forzar detención',
    'Suspended': 'Suspendido',
    'Install': 'Instalar',
    'Installing': 'Instalando',
    'Installed': 'Instalado',
    'Uninstall': 'Desinstalar',
    'Update': 'Actualizar',
    'Updating': 'Actualizando',
    'Backup': 'Copia de seguridad',
    'Backups': 'Copias de seguridad',
    'Restore': 'Restaurar',
    'Download': 'Descargar',
    'Upload': 'Subir',
    'Select': 'Seleccionar',
    'Select All': 'Seleccionar todo',
    'None': 'Ninguno',
    'Default': 'Por defecto',
    'Unlimited': 'Ilimitado',
    'Required': 'Obligatorio',
    'Optional': 'Opcional',
    'All': 'Todos',
    'Other': 'Otro',
    'More': 'Más',
    'Less': 'Menos',
    'Today': 'Hoy',
    'Yesterday': 'Ayer',
    'Never': 'Nunca',
    'Last': 'Último',
    'First': 'Primero',
    'New': 'Nuevo',
    'Add': 'Añadir',
    'Remove': 'Eliminar',
    'Remove All': 'Eliminar todo',
    'Are you sure?': '¿Estás seguro?',
    'Confirm': 'Confirmar',
    'Warning!': '¡Advertencia!',
    'Notice': 'Aviso',
    'Note': 'Nota',
    'Example': 'Ejemplo',
    'Tip': 'Consejo',
    'Usage': 'Uso',
    'Version': 'Versión',
    'Latest': 'Más reciente',
    'Current': 'Actual',
    'Memory': 'Memoria',
    'Disk': 'Disco',
    'CPU': 'CPU',
    'Server': 'Servidor',
    'Servers': 'Servidores',
    'Node': 'Nodo',
    'Nodes': 'Nodos',
    'Location': 'Ubicación',
    'Locations': 'Ubicaciones',
    'Account': 'Cuenta',
    'Profile': 'Perfil',
    'Dashboard': 'Panel de control',
    'Admin': 'Administrador',
    'Administration': 'Administración',
    'Home': 'Inicio',
    'Login': 'Iniciar sesión',
    'Logout': 'Cerrar sesión',
    'Register': 'Registrarse',
    'Sign In': 'Iniciar sesión',
    'Sign Out': 'Cerrar sesión',
    'Sign Up': 'Registrarse',
    'Forgot Password': '¿Olvidaste tu contraseña?',
    'Reset Password': 'Restablecer contraseña',
    'Change Password': 'Cambiar contraseña',
    'Two Factor': 'Autenticación de dos factores',
    '2FA': '2FA',
    'API': 'API',
    'API Keys': 'Claves API',
    'Database': 'Base de datos',
    'Databases': 'Bases de datos',
    'Allocation': 'Asignación',
    'Allocations': 'Asignaciones',
    'Startup': 'Inicio',
    'Variables': 'Variables',
    'Egg': 'Egg',
    'Eggs': 'Eggs',
    'Nest': 'Nest',
    'Nests': 'Nests',
    'Schedule': 'Programación',
    'Schedules': 'Programaciones',
    'Task': 'Tarea',
    'Tasks': 'Tareas',
    'File Manager': 'Gestor de archivos',
    'Subusers': 'Subusuarios',
    'Permissions': 'Permisos',
    'Reinstall': 'Reinstalar',
    'Move': 'Mover',
    'Rename': 'Renombrar',
    'New File': 'Nuevo archivo',
    'New Folder': 'Nueva carpeta',
    'Delete File': 'Eliminar archivo',
    'Delete Folder': 'Eliminar carpeta',
    'Upload Files': 'Subir archivos',
    'Download File': 'Descargar archivo',
    'Edit File': 'Editar archivo',
    'Full Screen': 'Pantalla completa',
    'Exit Full Screen': 'Salir de pantalla completa',
    'Clear Console': 'Limpiar consola',
    'Send': 'Enviar',
    'Command': 'Comando',
    'Execute': 'Ejecutar',
    'Stats': 'Estadísticas',
    'Uptime': 'Tiempo en marcha',
    'Usage': 'Uso',
    'Limit': 'Límite',
    'Used': 'Usado',
    'Available': 'Disponible',
    'Total': 'Total',
    'MB': 'MB',
    'GB': 'GB',
    'TB': 'TB',
    'core': 'núcleo',
    'cores': 'núcleos',
    'percent': 'por ciento',
    '%': '%',
    'day': 'día',
    'days': 'días',
    'hour': 'hora',
    'hours': 'horas',
    'minute': 'minuto',
    'minutes': 'minutos',
    'second': 'segundo',
    'seconds': 'segundos',
}

def walk(obj):
    if isinstance(obj, dict):
        res = {}
        for k, v in obj.items():
            res[k] = walk(v)
        return res
    elif isinstance(obj, list):
        return [walk(x) for x in obj]
    elif isinstance(obj, str):
        # try exact match first
        if obj in trans:
            return trans[obj]
        # common patterns
        # preserve placeholders - don't translate inside {}
        s = obj
        # quick patterns
        if s.startswith('The ') or s.startswith('An '):
            pass  # handle contextually later by large mapping
        # preserve tags/entities
        return s  # for now do targeted replacement; we'll refine
    else:
        return obj

# better: deep translate with replacements
es = {}

def tr_str(s):
    if s in trans:
        return trans[s]
    # replacements
    out = s
    # common phrases
    out = out.replace('There was an error processing your request.', 'Se ha producido un error al procesar tu solicitud.')
    out = out.replace('An error occurred while processing your request.', 'Se ha producido un error al procesar tu solicitud.')
    out = out.replace('You do not have permission to perform this action.', 'No tienes permiso para realizar esta acción.')
    out = out.replace("You don't have permission to perform this action.", 'No tienes permiso para realizar esta acción.')
    out = out.replace('Not found.', 'No encontrado.')
    out = out.replace('Page Not Found', 'Página no encontrada')
    out = out.replace('Internal Server Error', 'Error interno del servidor')
    out = out.replace('Unauthorized', 'No autorizado')
    out = out.replace('Forbidden', 'Prohibido')
    out = out.replace('Too Many Requests', 'Demasiadas solicitudes')
    out = out.replace('Bad Request', 'Solicitud incorrecta')
    out = out.replace('This field is required.', 'Este campo es obligatorio.')
    out = out.replace('Invalid email address.', 'Dirección de correo electrónico no válida.')
    out = out.replace('Passwords do not match.', 'Las contraseñas no coinciden.')
    out = out.replace('Password must be at least', 'La contraseña debe tener al menos')
    out = out.replace('characters long.', 'caracteres.')
    out = out.replace('Email or password is incorrect.', 'El correo electrónico o la contraseña son incorrectos.')
    out = out.replace('Account has been suspended.', 'La cuenta ha sido suspendida.')
    out = out.replace('Server is currently offline.', 'El servidor está actualmente sin conexión.')
    out = out.replace('Server is starting...', 'El servidor se está iniciando...')
    out = out.replace('Server is stopping...', 'El servidor se está deteniendo...')
    out = out.replace('Server is running.', 'El servidor está en funcionamiento.')
    out = out.replace('Are you sure you want to delete this?', '¿Estás seguro de que deseas eliminar esto?')
    out = out.replace('Are you sure you want to delete', '¿Estás seguro de que deseas eliminar')
    out = out.replace('This action cannot be undone.', 'Esta acción no se puede deshacer.')
    out = out.replace('Copied to clipboard!', '¡Copiado al portapapeles!')
    # generic replacements
    out = out.replace('Create an account', 'Crear una cuenta')
    out = out.replace('Already have an account?', '¿Ya tienes una cuenta?')
    out = out.replace("Don't have an account?", '¿No tienes una cuenta?')
    out = out.replace('Remember me', 'Recordarme')
    out = out.replace('Forgot your password?', '¿Olvidaste tu contraseña?')
    out = out.replace('Reset your password', 'Restablecer tu contraseña')
    out = out.replace('Send reset link', 'Enviar enlace de restablecimiento')
    out = out.replace('Back to login', 'Volver a iniciar sesión')
    return out

def walk2(obj):
    if isinstance(obj, dict):
        return {k: walk2(v) for k,v in obj.items()}
    elif isinstance(obj, list):
        return [walk2(x) for x in obj]
    elif isinstance(obj, str):
        return tr_str(obj)
    else:
        return obj

es = walk2(en)
with open('locales/es.json','w',encoding='utf-8') as f:
    json.dump(es, f, ensure_ascii=False, indent=2)
    f.write('\n')
print('done')
