/**
 * Settings Store - Simple JSON read/write for persistent settings
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'ropilot-settings.json');

const DEFAULTS = {
  transparencyEnabled: false,
  pluginAutoUpdateLastCheckAt: 0,
};

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return fallback;
}

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[settings-store] Failed to read settings:', err.message);
  }
  return {};
}

function writeSettings(settings) {
  try {
    const dir = path.dirname(SETTINGS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings-store] Failed to write settings:', err.message);
  }
}

function getSetting(key, defaultValue) {
  const settings = readSettings();
  const hasStoredValue = key in settings;
  const fallbackValue = defaultValue !== undefined ? defaultValue : DEFAULTS[key];
  const rawValue = hasStoredValue ? settings[key] : fallbackValue;

  if (key === 'transparencyEnabled') {
    return normalizeBoolean(rawValue, normalizeBoolean(fallbackValue, DEFAULTS.transparencyEnabled));
  }

  return rawValue;
}

function setSetting(key, value) {
  const settings = readSettings();
  if (key === 'transparencyEnabled') {
    settings[key] = normalizeBoolean(value, DEFAULTS.transparencyEnabled);
  } else {
    settings[key] = value;
  }
  writeSettings(settings);
}

module.exports = { getSetting, setSetting };
