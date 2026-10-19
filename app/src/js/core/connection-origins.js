// Only select between known Ropilot deployments, before dispatching any work.
// A network failure on a write/AI request never triggers automatic replay.
const ORIGINS = {
  prod: ['https://ropilot.ai', 'https://ropilot-site.pages.dev'],
  test: ['https://test.ropilot.ai', 'https://ropilot-site-test.pages.dev'],
};
const selected = { prod: ORIGINS.prod[0], test: ORIGINS.test[0] };

export function serviceOrigin(environment) {
  return selected[environment === 'test' ? 'test' : 'prod'];
}

export async function selectConnectionConfig(config, fetcher = globalThis.fetch) {
  const environment = config.isTest ? 'test' : 'prod';
  const [primary, fallback] = ORIGINS[environment];
  // Preserve explicit developer/custom environments.
  if (config.siteUrl && !ORIGINS[environment].includes(config.siteUrl.replace(/\/+$/, ''))) return config;
  async function healthy(origin) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetcher(`${origin}/api/connection-health`, {
        signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
      });
      if (!response.ok) return false;
      const body = await response.json();
      return body.service === 'ropilot' && body.environment === environment;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  selected[environment] = !await healthy(primary) && await healthy(fallback) ? fallback : primary;
  const origin = selected[environment];
  return { ...config, siteUrl: origin, edgeUrl: `${origin}/edge`, releasesUrl: `${origin}/releases` };
}
