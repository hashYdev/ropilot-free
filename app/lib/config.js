const isTest = process.argv.includes('--test') || (process.env.ROPILOT_ENV || '').trim() === 'test';

if (isTest) {
    console.log('[ropilot] Running in TEST mode');
}

module.exports = {
    isTest,
    siteUrl: isTest ? 'https://test.ropilot.ai' : 'https://ropilot.ai',
    appUrl: isTest ? 'https://test-app.ropilot.ai' : 'https://app.ropilot.ai',
    edgeUrl: isTest ? 'https://test.ropilot.ai/edge' : 'https://ropilot.ai/edge',
    releasesUrl: isTest ? 'https://test.ropilot.ai/releases' : 'https://ropilot.ai/releases',
};
