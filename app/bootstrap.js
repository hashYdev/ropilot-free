const path = require('path');
const { app, crashReporter } = require('electron');

// Keep data under .../ropilot (not the display product name "Ropilot Studio").
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'ropilot'));
} catch (err) {
  console.error('[BOOTSTRAP] Failed to set userData path:', err);
}

const config = require('./lib/config');
const desktopPackage = require('./package.json');

// Electron sets app.isPackaged=true when the executable is not named "electron"
// (e.g. macOS dev launcher renames to "Ropilot Studio"). scripts/start.js sets ROPILOT_DEV=1.
const isDevLaunch = process.env.ROPILOT_DEV === '1' || !app.isPackaged;

function getCrashSubmitUrl() {
  return `${config.siteUrl}/api/crash-report`;
}

function buildGlobalExtra() {
  return {
    app_env: config.isTest ? 'test' : 'prod',
    app_arch: process.arch,
    app_packaged: !isDevLaunch && app.isPackaged ? '1' : '0',
    ui_host: config.appUrl,
  };
}

function freezeCrashReporterStart() {
  const noop = () => {
    console.log('[CRASH] crashReporter already initialized in bootstrap');
  };

  crashReporter.start = noop;
}

function startCrashReporter() {
  try {
    crashReporter.start({
      productName: 'Ropilot Studio',
      companyName: 'Ropilot',
      submitURL: getCrashSubmitUrl(),
      uploadToServer: true,
      compress: false,
      ignoreSystemCrashHandler: false,
      globalExtra: buildGlobalExtra(),
    });
    console.log(`[CRASH] crashReporter started: ${getCrashSubmitUrl()}`);
    freezeCrashReporterStart();
  } catch (err) {
    console.error('[CRASH] Failed to start crashReporter in bootstrap:', err);
  }
}

function configureWindowsAppIdentity() {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    const productName = desktopPackage.build?.productName || 'Ropilot Studio';
    const appId = desktopPackage.build?.appId || 'com.ropilot.desktop';
    app.setName(productName);
    app.setAppUserModelId(appId);
    console.log(`[BOOTSTRAP] Windows app identity configured: ${productName} (${appId})`);
  } catch (err) {
    console.error('[BOOTSTRAP] Failed to configure Windows app identity:', err);
  }
}

/** Keep Electron's internal app name aligned with packaged branding. */
function configureMacAppIdentity() {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    const productName = desktopPackage.build?.productName || 'Ropilot Studio';
    app.setName(productName);
    console.log(`[BOOTSTRAP] macOS app name set: ${productName}`);
  } catch (err) {
    console.error('[BOOTSTRAP] Failed to configure macOS app identity:', err);
  }
}

configureWindowsAppIdentity();
configureMacAppIdentity();
startCrashReporter();

require(isDevLaunch ? './main.js' : './main.min.js');
