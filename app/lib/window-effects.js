/**
 * Window effects module
 *
 * Win11: Electron built-in setBackgroundMaterial('acrylic')
 * Win10: mica-electron (setAcrylic)
 */

const os = require('os');

/**
 * Check if running Windows 11 (build >= 22000)
 */
function isWindows11() {
  if (process.platform !== 'win32') return false;
  const release = os.release();
  const parts = release.split('.');
  if (parts.length >= 3) {
    const build = parseInt(parts[2], 10);
    return build >= 22000;
  }
  return false;
}

/**
 * Apply Win11 effects using Electron's built-in backgroundMaterial API.
 * Available since Electron 24. No native addons needed.
 */
function applyWin11Effects(window) {
  try {
    // Try acrylic first, then mica
    for (const material of ['acrylic', 'mica', 'tabbed', 'auto']) {
      try {
        window.setBackgroundMaterial(material);
        console.log(`Applied Win11 backgroundMaterial: ${material}`);
        return true;
      } catch (err) {
        console.log(`backgroundMaterial '${material}' failed:`, err.message);
      }
    }
    return false;
  } catch (err) {
    console.error('Error applying Win11 effects:', err.message);
    return false;
  }
}

/**
 * Apply Win10 acrylic via mica-electron.
 * Window must be a MicaBrowserWindow instance.
 */
function applyWin10Blur(window) {
  try {
    window.setDarkTheme();
    window.setAcrylic();
    console.log('Applied Win10 acrylic via mica-electron');
    return true;
  } catch (err) {
    console.error('Error applying Win10 blur:', err.message);
    return false;
  }
}

/**
 * Apply window effects. Picks the right approach based on OS version.
 */
function applyWindowEffects(window) {
  if (process.platform !== 'win32') return false;

  if (isWindows11()) {
    return applyWin11Effects(window);
  } else {
    return applyWin10Blur(window);
  }
}

/**
 * Check if Windows transparency effects are enabled
 */
function isTransparencyEnabled() {
  if (process.platform !== 'win32') return true;

  try {
    const { execSync } = require('child_process');
    const result = execSync(
      'reg query "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize" /v EnableTransparency',
      { encoding: 'utf8', timeout: 2000 }
    );
    const match = result.match(/EnableTransparency\s+REG_DWORD\s+0x(\d+)/i);
    if (match) {
      const value = parseInt(match[1], 16);
      console.log('Windows transparency effects enabled:', value === 1);
      return value === 1;
    }
  } catch (err) {
    console.log('Could not check transparency setting:', err.message);
  }
  return true;
}

module.exports = {
  isWindows11,
  applyWindowEffects,
  isTransparencyEnabled
};
