const fs = require('fs');
const path = require('path');

const LOCALE_DIR = path.join(__dirname, '..', 'locales');

// Supported language codes. 'en' is the base language and must be complete.
const SUPPORTED = ['en', 'de', 'fr', 'es', 'nl', 'pt'];

// Display names shown in the language picker, in each language's own words.
const LANGUAGE_NAMES = {
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
  es: 'Español',
  nl: 'Nederlands',
  pt: 'Português'
};

// Cache of flattened dictionaries keyed by language code.
const cache = {};

function flatten(obj, prefix, out) {
  for (const k of Object.keys(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    const v = obj[k];
    if (v && typeof v === 'object') {
      flatten(v, key, out);
    } else {
      out[key] = String(v);
    }
  }
  return out;
}

function readJson(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch (err) {
    console.error('[i18n] Failed to load', file, '-', err.message);
    return {};
  }
}

// Flattened dictionary for a language, with English as the fallback base.
// Missing keys fall back to English automatically.
function dict(lang) {
  if (cache[lang]) return cache[lang];
  const base = flatten(readJson(path.join(LOCALE_DIR, 'en.json')), '', {});
  if (lang === 'en') {
    cache.en = base;
    return base;
  }
  const own = flatten(readJson(path.join(LOCALE_DIR, lang + '.json')), '', {});
  const merged = Object.assign({}, base, own);
  cache[lang] = merged;
  return merged;
}

function translate(d, key, vars) {
  let s = d[key];
  if (s === undefined) s = key;
  if (vars) {
    for (const p of Object.keys(vars)) {
      s = s.split('{' + p + '}').join(String(vars[p]));
    }
  }
  return s;
}

function resolve(lang) {
  return SUPPORTED.indexOf(lang) !== -1 ? lang : 'en';
}

// Returns the translation function bound to a language: t('key', { vars })
function makeT(lang) {
  const d = dict(resolve(lang));
  return (key, vars) => translate(d, key, vars);
}

module.exports = { SUPPORTED, LANGUAGE_NAMES, resolve, dict, makeT };