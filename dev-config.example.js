// Copy to dev-config.js (gitignored) and fill in the secret from:
//   wrangler secret put DEV_LOGIN_SECRET   (in crypto-bros-api)
//
// On localhost the site POSTs this to /auth/dev once, stores the session JWT,
// and loads real feed/lessons. Without it you stay in mock-preview mode.
window.__CB_DEV_SECRET__ = 'replace-with-your-DEV_LOGIN_SECRET';
