import { electronAPI } from './core/platform.js';

const PLUGIN_BOOTSTRAP_STATE_FILE = 'ropilot-plugin-bootstrap.json';

export async function persistPluginBootstrapKey(apiKey) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return false;

  const api = electronAPI();
  const userDataPath = await api?.getUserDataPath?.();
  if (!userDataPath) return false;

  const writeResult = await api?.writeFile?.(
    `${userDataPath}/${PLUGIN_BOOTSTRAP_STATE_FILE}`,
    JSON.stringify({ apiKey: key }, null, 2)
  );

  return !!writeResult?.success;
}
