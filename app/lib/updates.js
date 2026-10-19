/**
 * App update checking module
 */

const https = require('https');
const { dialog, shell } = require('electron');
const config = require('./config');

const APP_VERSION_URL = `${config.releasesUrl}/desktop-version.json`;
const APP_DOWNLOAD_URL = `${config.siteUrl}/download`;

let mainWindow = null;

/**
 * Set the main window reference
 */
function setMainWindow(window) {
  mainWindow = window;
}

/**
 * Compare semantic versions (returns 1 if a > b, -1 if a < b, 0 if equal)
 */
function compareVersions(a, b) {
  const partsA = a.split('.').map(n => parseInt(n, 10) || 0);
  const partsB = b.split('.').map(n => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

/**
 * Check for app updates
 */
async function checkAppUpdate(currentVersion) {
  try {
    // Fetch latest version info
    const versionInfo = await new Promise((resolve, reject) => {
      https.get(APP_VERSION_URL, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });

    const latestVersion = versionInfo.version;
    console.log(`App version check: current=${currentVersion}, latest=${latestVersion}`);

    // Simple version comparison (works for semver like 1.0.0 < 1.0.1)
    if (latestVersion && latestVersion !== currentVersion && compareVersions(latestVersion, currentVersion) > 0) {
      // Show update dialog
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `Ropilot Studio ${latestVersion} is available`,
        detail: versionInfo.notes || `You are running version ${currentVersion}. Would you like to download the update?`,
        buttons: ['Download Update', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });

      if (result.response === 0) {
        // Open download page
        shell.openExternal(APP_DOWNLOAD_URL);
      }
    }
  } catch (err) {
    console.log('App update check failed:', err.message);
    // Silently fail - don't bother user if update check fails
  }
}

module.exports = {
  setMainWindow,
  compareVersions,
  checkAppUpdate
};
