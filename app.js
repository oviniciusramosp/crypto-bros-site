// Crypto Bros website — Google sign-in → gated Feed (marquee, F&G/MVRV, tags, posts, detail modal).
'use strict';

const CONFIG = {
  workerBase: 'https://crypto-bros-notion-proxy.crypto-bros.workers.dev',
  googleClientId: '947303618125-0k85q1ds1g8gfq3njtgsh1nc8ihug94p.apps.googleusercontent.com',
  appStoreUrl: 'https://apps.apple.com/br/app/crypto-bros/id6758371729',
  // VAPID public key for Web Push (matches the Worker's VAPID_PRIVATE_JWK secret).
  vapidPublicKey: 'BNs6wLSOtdOlNEdTf20Ci5TUjfYMGCNAJ_3NvRhl0orN64eCjRWDabUcwpRHLN8jsfauqKDWbxiek6DiM8yIHDg',
};

const SESSION_KEY = 'cb-session';
const DEV_SECRET_KEY = 'cb-dev-secret'; // localhost only — exchanged for a real session via /auth/dev
const THEME_KEY = 'cb-theme'; // 'light' | 'dark' | absent(=system)
const AVATAR_KEY = 'cb-avatar';
const NAME_KEY = 'cb-name';
const EMAIL_KEY = 'cb-email';
const HISTORY_PAGE_SIZE = 5;

const $ = (id) => document.getElementById(id);
const getSession = () => localStorage.getItem(SESSION_KEY);
const isLocalHost = () => location.hostname === 'localhost' || location.hostname === '127.0.0.1';
/** Mock feed (no API). Only when local AND we still have no session after dev bootstrap. */
const isPreview = () => isLocalHost() && !getSession();

/**
 * Bearer-authed call to the Worker, with the dead-session path handled once.
 * Returns null when the session is gone (the user has already been sent back to
 * the login screen) — callers just bail. Network errors still throw, so a caller
 * can tell "offline" apart from "signed out".
 */
async function authFetch(path, opts) {
  const res = await fetch(`${CONFIG.workerBase}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${getSession()}`, ...(opts && opts.headers) },
  });
  if (res.status === 401) {
    localStorage.removeItem(SESSION_KEY);
    closeModal(true);
    showLogin();
    return null;
  }
  return res;
}

let feedPosts = [];
let feedHistory = [];
let feedTags = [];
let selectedTag = 'all';
let historyPage = 0;
let marketData = { fng: null, mvrv: null, fngAt: null, mvrvAt: null };
let marqueeTimer = null;
let currentView = 'feed'; // 'feed' | 'lessons' | 'glossary'

// ── Glossary (terms + inline matcher + tooltip) ───────────────────────
// Port of app glossaryMatcher.ts + GlossaryTermsContext + GlossaryTooltip.
let glossaryTerms = []; // [{ id, termo, definicao, alt[] }]
let glossaryMatcher = null;
let glossaryLoadedLang = null; // notionLang last loaded
let glossarySearchQuery = '';
let glossaryActiveTermId = null;
const glossarySegmentsCache = new Map(); // plain text → segments

// ── Utils ─────────────────────────────────────────────────────────────
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function chevronSvg(back) {
  const d = back ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6';
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}
function docIconSvg() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/></svg>`;
}

// ── Theme (system default) ────────────────────────────────────────────
function themePref() {
  try { const p = localStorage.getItem(THEME_KEY); return p === 'light' || p === 'dark' ? p : 'system'; }
  catch (e) { return 'system'; }
}
function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  document.documentElement.setAttribute('data-theme', resolveTheme(themePref()));
}
function repaintOpenCalculators() {
  // DCA avg-line color flips black/white with theme (app DCAChart isOrangePrice).
  if (typeof isCalcOpen === 'function' && typeof renderDcaBody === 'function' && isCalcOpen('dca')) {
    renderDcaBody();
  }
  if (typeof isCalcOpen === 'function' && typeof renderPosBody === 'function' && isCalcOpen('pos')) {
    renderPosBody();
  }
}
function setThemePref(pref) {
  if (pref === 'system') localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, pref);
  applyTheme();
  renderMarket();
  if (isMarketModalOpen()) renderMarketChart();
  renderMenuState();
  repaintThemedContent();
  repaintOpenCalculators();
}
/** Collapsed rail: cycle system → light → dark → system. */
const THEME_CYCLE = ['system', 'light', 'dark'];
function cycleThemePref() {
  const cur = themePref();
  const i = THEME_CYCLE.indexOf(cur);
  setThemePref(THEME_CYCLE[(i < 0 ? 0 : i + 1) % THEME_CYCLE.length]);
}
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themePref() !== 'system') return;
    applyTheme();
    renderMarket();
    if (isMarketModalOpen()) renderMarketChart();
    repaintThemedContent();
    repaintOpenCalculators();
  });
}

/**
 * Notion colours (tag pills, coloured text, highlights) are written as INLINE styles, so
 * flipping data-theme does not recolour them the way a CSS var would — the old theme's
 * hexes stay baked into the DOM until a reload. Re-render everything that carries one.
 */
function repaintThemedContent() {
  if ($('app').classList.contains('hidden')) return; // still on the login screen
  if (feedTags.length) renderTags();
  if (feedPosts.length) renderFeed();
  if (currentPostId && postCache[currentPostId]) renderPostModal(postCache[currentPostId]);
  else if (currentLessonId && lessonCache[currentLessonId]) renderLessonModal(lessonCache[currentLessonId]);
}

// ── i18n glue ─────────────────────────────────────────────────────────
function applyStaticText() {
  $('login-subtitle').textContent = I18N.t('login.subtitle');
  $('login-hint').textContent = I18N.t('login.hint');
  $('g-fake-label').textContent = I18N.t('login.google');
  const sidebar = $('sidebar');
  if (sidebar) sidebar.setAttribute('aria-label', I18N.t('sidebar.nav'));
  applySidebarLabels();
  updateSidebarChromeAria();
  const fab = $('sidebar-fab');
  if (fab) fab.setAttribute('aria-label', I18N.t('sidebar.expand'));
  const tagPrev = $('tagbar-prev');
  const tagNext = $('tagbar-next');
  if (tagPrev) tagPrev.setAttribute('aria-label', I18N.t('filters.prev'));
  if (tagNext) tagNext.setAttribute('aria-label', I18N.t('filters.next'));
  document.querySelectorAll('#login-lang button').forEach((b) =>
    b.classList.toggle('active', b.dataset.lang === I18N.lang));
  renderMenuState();
}

/** Fill sidebar nav labels + Ionicons (and cryptobros Feed glyph). */
function applySidebarLabels() {
  const items = [
    { id: 'sidebar-feed', label: I18N.t('view.feed'), iconHtml: FEED_ICON },
    { id: 'sidebar-lessons', label: I18N.t('view.lessons'), iconHtml: LESSONS_ICON },
    { id: 'sidebar-glossary', label: I18N.t('menu.glossary.title'), iconHtml: GLOSSARY_ICON },
    { id: 'sidebar-dca', label: I18N.t('menu.dca.title'), iconHtml: DCA_ICON },
    { id: 'sidebar-pos', label: I18N.t('menu.pos.title'), iconHtml: POS_ICON },
  ];
  for (const item of items) {
    const btn = $(item.id);
    if (!btn) continue;
    const icon = btn.querySelector('.sidebar__icon');
    const label = btn.querySelector('.sidebar__label');
    if (item.iconHtml && icon) icon.innerHTML = item.iconHtml;
    if (label) label.textContent = item.label;
    btn.dataset.label = item.label;
    btn.setAttribute('aria-label', item.label);
  }
}

const SIDEBAR_COLLAPSED_KEY = 'cb-sidebar-collapsed';
const SIDEBAR_MQ = '(min-width: 1024px)';

function isDesktopSidebar() {
  try { return window.matchMedia(SIDEBAR_MQ).matches; } catch (e) { return false; }
}

function isSidebarCollapsed() {
  return document.getElementById('app')?.classList.contains('is-sidebar-collapsed');
}

function isSidebarOpen() {
  return document.getElementById('app')?.classList.contains('is-sidebar-open');
}

function updateSidebarChromeAria() {
  const toggle = $('sidebar-toggle');
  const menuBtn = $('sidebar-fab');
  const backdrop = $('sidebar-backdrop');
  if (isDesktopSidebar()) {
    const collapsed = isSidebarCollapsed();
    if (toggle) {
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.setAttribute('aria-label', I18N.t(collapsed ? 'sidebar.expand' : 'sidebar.collapse'));
    }
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
    if (backdrop) backdrop.hidden = true;
  } else {
    const open = isSidebarOpen();
    if (toggle) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.setAttribute('aria-label', I18N.t(open ? 'sidebar.collapse' : 'sidebar.expand'));
    }
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      menuBtn.setAttribute('aria-label', I18N.t(open ? 'sidebar.collapse' : 'sidebar.expand'));
    }
    if (backdrop) backdrop.hidden = !open;
  }
}

/**
 * Desktop collapse/expand: only the rail width animates.
 * Labels stay in the DOM and clip via overflow as the row width follows the rail.
 * Icons stay left-aligned; gap == padding-left so text never needs a separate hide phase.
 */
function setSidebarCollapsed(collapsed) {
  const app = $('app');
  if (!app) return;
  app.classList.toggle('is-sidebar-collapsed', !!collapsed);
  app.classList.remove('is-sidebar-rail'); // legacy
  app.classList.remove('is-sidebar-labels-hidden'); // legacy two-phase
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (e) {}
  updateSidebarChromeAria();
  if (typeof syncLessonPanelChrome === 'function') syncLessonPanelChrome();
}

/** Phone/tablet overlay drawer open/close. */
function setSidebarOpen(open) {
  const app = $('app');
  if (!app) return;
  app.classList.toggle('is-sidebar-open', !!open);
  document.body.style.overflow = open && !isDesktopSidebar() ? 'hidden' : '';
  updateSidebarChromeAria();
}

function closeSidebarDrawer() {
  closeUserPopover();
  if (!isDesktopSidebar() && isSidebarOpen()) setSidebarOpen(false);
}

function initSidebar() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch (e) {}
  if (isDesktopSidebar()) {
    const app = $('app');
    if (app) {
      app.classList.toggle('is-sidebar-collapsed', !!collapsed);
      app.classList.remove('is-sidebar-rail');
      app.classList.remove('is-sidebar-labels-hidden');
    }
  } else {
    setSidebarOpen(false);
  }
  updateSidebarChromeAria();
}

function syncNavActive(view) {
  document.querySelectorAll('#sidebar-nav .sidebar__item').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
}
function onLangChange(lang) {
  if (lang === I18N.lang) return;
  I18N.set(lang);
  hideLangBanner(); // an explicit choice settles the locale question
  applyStaticText();
  renderMarket();
  const marquee = $('marquee');
  if (marquee) marquee.setAttribute('aria-label', I18N.t('marquee.aria'));
  if (isMarketModalOpen()) {
    $('market-modal-close').setAttribute('aria-label', I18N.t('marketModal.close'));
    renderMarketModalHeader();
    if (mmState.error || mmState.loading) renderMarketChart();
  }
  if ($('app').classList.contains('hidden')) return; // still on the login screen

  // Language selects a different set of Notion rows entirely — drop everything cached
  // under the old language, including any open lesson / glossary.
  lessonModules = [];
  for (const k of Object.keys(lessonCache)) delete lessonCache[k];
  glossaryTerms = [];
  glossaryMatcher = null;
  glossaryLoadedLang = null;
  glossarySegmentsCache.clear();
  glossarySearchQuery = '';
  hideGlossaryTooltip();

  // Reload glossary for the new language (feeds inline tooltips + glossary page).
  ensureGlossaryLoaded().then(() => {
    if (currentView === 'glossary') renderGlossaryPage();
    else if (feedPosts.length) renderFeed();
    if (currentPostId && postCache[currentPostId]) renderPostModal(postCache[currentPostId]);
    if (currentLessonId && lessonCache[currentLessonId]) renderLessonModal(lessonCache[currentLessonId]);
  });

  // Calculators only need strings re-rendered (no Notion re-fetch).
  if (currentView === 'dca') loadDcaPage();
  else if (currentView === 'pos') loadPosPage();

  // Language picks a different Notion row set — drop the active filter so we do not
  // re-query a PT tag name against EN posts (or vice-versa). Rebuild pills so the
  // "all" label + tagLabel() translations refresh (applyFeedData skips rebuild when
  // the tag name set is unchanged).
  selectedTag = 'all';
  if (feedTags.length) renderTags();
  if (isPreview()) { renderFeed(); return; }
  if (currentView === 'lessons') loadLessons();
  else if (currentView === 'glossary') loadGlossaryPage();
  else if (currentView === 'dca' || currentView === 'pos') { /* already reloaded above */ }
  else loadFeed();
}

// ── Locale suggestion (Cloudflare edge geo → Apple-style banner) ───────
const PT_COUNTRIES = new Set(['BR', 'PT', 'AO', 'MZ', 'CV', 'GW', 'ST', 'TL']);
const LANG_BANNER_KEY = 'cb-lang-banner-dismissed';
// Session-scoped: dismissing a post-language offer shouldn't silence future shared links.
const POST_LANG_BANNER_KEY = 'cb-post-lang-banner-dismissed';

// Site-wide locale banner (#lang-banner) is separate from the post alt-language
// footer (#post-lang-banner), which lives inside the post modal panel.
let langBannerMode = null; // 'site' | 'post' | null

function hidePostLangBanner() {
  const el = $('post-lang-banner');
  if (el) el.classList.add('hidden');
  if (langBannerMode === 'post') langBannerMode = null;
}

function hideLangBanner() {
  // Site-wide top banner only. Post offer has its own hide path.
  hidePostLangBanner();
  langBannerMode = null;
  const el = $('lang-banner');
  if (el) el.classList.add('hidden');
  syncLessonPanelChrome();
}
function showLangBanner(lang) {
  hidePostLangBanner();
  langBannerMode = 'site';
  const el = $('lang-banner');
  $('lang-banner-text').textContent = I18N.tIn(lang, 'langBanner.text');
  const btn = $('lang-banner-switch');
  btn.textContent = I18N.tIn(lang, 'langBanner.switch');
  btn.onclick = () => onLangChange(lang);
  el.classList.remove('hidden');
  syncLessonPanelChrome();
}

/**
 * Measure sticky chrome so the desktop lesson panel fills the remaining viewport:
 *   height = 100dvh − topbar − langBanner − 2×page-pad-top
 * (same top inset as the first module card on the left column).
 * Post-language footer is inside the modal — never part of page chrome.
 */
function syncLessonPanelChrome() {
  const root = document.documentElement;
  const banner = $('lang-banner');
  const mobileTop = $('mobile-topbar');
  // Desktop: no mobile topbar (sidebar chrome). Phone/tablet: measure sticky bar.
  let topbarH = 0;
  if (mobileTop && !isDesktopSidebar()) {
    const cs = getComputedStyle(mobileTop);
    if (cs.display !== 'none') topbarH = mobileTop.getBoundingClientRect().height;
  }
  const bannerVisible =
    banner &&
    !banner.classList.contains('hidden') &&
    langBannerMode === 'site';
  const bannerH = bannerVisible ? banner.getBoundingClientRect().height : 0;
  root.style.setProperty('--topbar-h', `${Math.round(topbarH)}px`);
  root.style.setProperty('--lang-banner-h', `${Math.round(bannerH)}px`);
}
/** Default is the browser language; if the visitor's country speaks another one, offer to switch. */
async function maybeSuggestLanguage() {
  // Skip once the user has chosen a language explicitly, or dismissed the banner.
  if (localStorage.getItem('cb-lang') || localStorage.getItem(LANG_BANNER_KEY)) return;
  let country;
  try {
    const res = await fetch(`${CONFIG.workerBase}/web/geo`);
    country = (await res.json()).country;
  } catch (e) { return; }
  if (!country) return;
  const suggested = PT_COUNTRIES.has(country) ? 'pt' : 'en';
  if (suggested !== I18N.lang) showLangBanner(suggested);
}

/** True when any preferred browser language is Portuguese (pt, pt-BR, pt-PT, …). */
function browserPrefersPortuguese() {
  try {
    const list = (navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [navigator.language || ''];
    return list.some((l) => String(l || '').toLowerCase().startsWith('pt'));
  } catch (e) {
    return true; // fail closed: don't nag if we can't read the locale
  }
}

/**
 * When a PT-BR post is opened in a non-Portuguese browser (and a published EN
 * counterpart exists via Notion "Tradução"), offer to open the English version.
 * Inverse: EN post + Portuguese browser → offer PT.
 * Renders as a fixed footer inside the post modal (same chrome as close/share).
 */
function maybeSuggestPostLanguage(post) {
  hidePostLangBanner();
  if (!post || !post.altId) return;
  try { if (sessionStorage.getItem(POST_LANG_BANNER_KEY)) return; } catch (e) {}

  const lang = post.lang || '';
  const wantsPt = browserPrefersPortuguese();
  let offerLang = null; // UI language to switch into
  if ((lang === 'PT-BR' || lang === 'PT') && !wantsPt) offerLang = 'en';
  else if (lang === 'EN' && wantsPt) offerLang = 'pt';
  if (!offerLang) return;

  langBannerMode = 'post';
  const el = $('post-lang-banner');
  if (!el) return;
  $('post-lang-banner-text').textContent = I18N.tIn(offerLang, 'postLangBanner.text');
  const btn = $('post-lang-banner-switch');
  btn.textContent = I18N.tIn(offerLang, 'postLangBanner.switch');
  btn.onclick = () => switchToAltPost(post.altId, offerLang);
  el.classList.remove('hidden');
}

/** Switch UI language + open the translated post (used by the post-language banner). */
async function switchToAltPost(altId, lang) {
  hideLangBanner();
  try { sessionStorage.setItem(POST_LANG_BANNER_KEY, '1'); } catch (e) {}
  if (lang !== I18N.lang) {
    I18N.set(lang);
    applyStaticText();
    renderMarket();
    // Drop language-scoped caches; the feed for the new language loads in the background.
    lessonModules = [];
    for (const k of Object.keys(lessonCache)) delete lessonCache[k];
    if (!isPreview() && !$('app').classList.contains('hidden')) {
      if (currentView === 'lessons') loadLessons();
      else loadFeed();
    }
  }
  await openPost(altId);
}

// ── Auth + avatar ─────────────────────────────────────────────────────
function decodeJwt(token) {
  try {
    const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(b))));
  } catch (e) { return null; }
}
async function onGoogleCredential(response) {
  const errorEl = $('login-error');
  errorEl.classList.add('hidden');
  try {
    const claims = decodeJwt(response.credential);
    if (claims) {
      if (claims.picture) localStorage.setItem(AVATAR_KEY, claims.picture);
      if (claims.name) localStorage.setItem(NAME_KEY, claims.name);
      if (claims.email) localStorage.setItem(EMAIL_KEY, claims.email);
    }
    const res = await fetch(`${CONFIG.workerBase}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: response.credential }),
    });
    if (!res.ok) throw new Error(`auth ${res.status}`);
    const data = await res.json();
    localStorage.setItem(SESSION_KEY, data.session);
    showApp();
  } catch (e) {
    errorEl.textContent = I18N.t('login.error');
    errorEl.classList.remove('hidden');
  }
}
function initGoogle() {
  if (!window.google || !google.accounts) { setTimeout(initGoogle, 200); return; }
  google.accounts.id.initialize({ client_id: CONFIG.googleClientId, callback: onGoogleCredential, ux_mode: 'popup' });
  // Rendered invisibly (opacity 0) over the custom .g-fake button; width matches so
  // the whole visible button is clickable. Theme is irrelevant since it's hidden.
  google.accounts.id.renderButton($('google-btn'), {
    theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'pill', width: 300,
  });
}
function signOut() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(AVATAR_KEY);
  localStorage.removeItem(NAME_KEY);
  localStorage.removeItem(EMAIL_KEY);
  // Keep DEV_SECRET_KEY so the next reload on localhost can re-bootstrap without re-pasting.
  if (marqueeTimer) clearInterval(marqueeTimer);
  closeSidebarDrawer();
  closeIndicatorModal();
  closeMarketModal();
  showLogin();
}

/** Soft-load optional gitignored `dev-config.js` that may set window.__CB_DEV_SECRET__. */
function loadOptionalDevConfig() {
  if (!isLocalHost() || typeof window.__CB_DEV_SECRET__ === 'string') return Promise.resolve();
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = './dev-config.js';
    s.onload = () => resolve();
    s.onerror = () => resolve(); // missing file is fine — mock preview stays
    document.head.appendChild(s);
  });
}

/**
 * Localhost-only: trade DEV_LOGIN_SECRET for a real Worker session (POST /auth/dev),
 * so feed/lessons hit production Notion data without Google OAuth.
 *
 * Secret sources (first match wins):
 *   1. ?dev_secret=… in the URL (then persisted + stripped from the address bar)
 *   2. localStorage `cb-dev-secret`
 *   3. window.__CB_DEV_SECRET__ (optional gitignored dev-config.js)
 *
 * Returns true when a session was stored. On failure, leaves the page in mock preview.
 */
async function maybeBootstrapDevSession() {
  if (!isLocalHost() || getSession()) return false;

  await loadOptionalDevConfig();

  const params = new URLSearchParams(location.search);
  const fromQuery = params.get('dev_secret');
  const secret =
    fromQuery ||
    localStorage.getItem(DEV_SECRET_KEY) ||
    (typeof window.__CB_DEV_SECRET__ === 'string' ? window.__CB_DEV_SECRET__ : null);
  if (!secret) return false;

  try {
    const res = await fetch(`${CONFIG.workerBase}/auth/dev`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    if (!res.ok) {
      console.warn('[dev] /auth/dev failed', res.status);
      return false;
    }
    const data = await res.json();
    if (!data.session) return false;

    localStorage.setItem(SESSION_KEY, data.session);
    localStorage.setItem(DEV_SECRET_KEY, secret);
    if (data.user?.name) localStorage.setItem(NAME_KEY, data.user.name);
    if (data.user?.email) localStorage.setItem(EMAIL_KEY, data.user.email);
    localStorage.removeItem(AVATAR_KEY);

    // Drop the secret from the URL so it is not left in history/share targets.
    if (fromQuery) {
      params.delete('dev_secret');
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
    }
    console.info('[dev] session bootstrapped — real API content enabled');
    return true;
  } catch (e) {
    console.warn('[dev] bootstrap failed', e);
    return false;
  }
}
function displayName() {
  return localStorage.getItem(NAME_KEY) || (isPreview() ? 'Crypto Bro' : 'Usuário');
}
function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = (parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '');
  return s.toUpperCase() || 'U';
}
function userAvatarNode() {
  const src = localStorage.getItem(AVATAR_KEY);
  const name = displayName();
  if (src) {
    const img = el('img', 'topbar-avatar');
    img.src = src; img.alt = ''; img.referrerPolicy = 'no-referrer';
    img.onerror = () => { img.replaceWith(avatarPlaceholder(name)); };
    return img;
  }
  return avatarPlaceholder(name);
}
function avatarPlaceholder(name) {
  return el('div', 'topbar-avatar avatar--ph', initials(name));
}
function renderMenuUser() {
  $('menu-name').textContent = displayName();
  $('menu-email').textContent = localStorage.getItem(EMAIL_KEY) || (isPreview() ? 'voce@exemplo.com' : '');
  $('menu-avatar').replaceChildren(userAvatarNode());
}

// Favorite coins — read-only mirror of what the user picked in the app (GET /web/profile).
function renderFavoriteCoins(coins) {
  const section = $('menu-coins-section');
  const box = $('menu-coins');
  if (!Array.isArray(coins) || coins.length === 0) {
    section.classList.add('hidden');
    box.replaceChildren();
    return;
  }
  box.innerHTML = coins
    .map((c) => String(c))
    .map((sym) => `<span class="menu__coin"><img src="./assets/crypto/${sym}.webp" alt="" onerror="this.remove()"/>${sym}</span>`)
    .join('');
  section.classList.remove('hidden');
}

async function loadFavoriteCoins() {
  if (isPreview()) return;
  try {
    const res = await authFetch('/web/profile');
    if (!res || !res.ok) return;
    const data = await res.json();
    renderFavoriteCoins(data.coins);
  } catch {
    // Offline — leave the section hidden; it's a nice-to-have.
  }
}

// ── User popover + theme icons ────────────────────────────────────────
/** Theme icons: outline idle → solid when selected (CSS .active). Paths from ionicons@7.4.0. */
function themeIconPair(outline, solid, extraClass) {
  return (
    `<svg class="theme-ico${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 512 512" aria-hidden="true">` +
    `<g class="theme-ico__outline">${outline}</g>` +
    `<g class="theme-ico__solid">${solid}</g>` +
    `</svg>`
  );
}
// System: invert-mode on phone/tablet, laptop on desktop (CSS swaps .theme-ico__bp-*).
const THEME_ICON_SYSTEM =
  `<svg class="theme-ico theme-ico--system" viewBox="0 0 512 512" aria-hidden="true">` +
  // Mobile/tablet — invert-mode-outline / invert-mode
  `<g class="theme-ico__bp-mobile">` +
  `<g class="theme-ico__outline" fill="none" stroke="currentColor" stroke-width="32" stroke-miterlimit="10">` +
  `<circle cx="256" cy="256" r="208"/>` +
  `<path fill="currentColor" stroke="none" d="M256 176v160a80 80 0 010-160zM256 48v128a80 80 0 010 160v128c114.88 0 208-93.12 208-208S370.88 48 256 48z"/>` +
  `</g>` +
  `<g class="theme-ico__solid" fill="none" stroke="currentColor" stroke-width="32" stroke-miterlimit="10">` +
  `<circle cx="256" cy="256" r="208"/>` +
  `<path fill="currentColor" stroke="none" d="M256 176v160a80 80 0 000-160zM256 48v128a80 80 0 000 160v128c-114.88 0-208-93.12-208-208S141.12 48 256 48z"/>` +
  `</g>` +
  `</g>` +
  // Desktop — laptop-outline / laptop
  `<g class="theme-ico__bp-desktop">` +
  `<g class="theme-ico__outline" fill="none" stroke="currentColor" stroke-width="32" stroke-linejoin="round">` +
  `<rect x="48" y="96" width="416" height="304" rx="32.14" ry="32.14"/>` +
  `<path stroke-linecap="round" stroke-miterlimit="10" d="M16 416h480"/>` +
  `</g>` +
  `<g class="theme-ico__solid" fill="currentColor" stroke="none">` +
  `<path d="M496 400h-28.34A47.92 47.92 0 00480 367.86V128.14A48.2 48.2 0 00431.86 80H80.14A48.2 48.2 0 0032 128.14v239.72A47.92 47.92 0 0044.34 400H16a16 16 0 000 32h480a16 16 0 000-32z"/>` +
  `</g>` +
  `</g>` +
  `</svg>`;
const THEME_ICONS = {
  system: THEME_ICON_SYSTEM,
  light: themeIconPair(
    // sunny-outline style (compact on 512 grid)
    `<g fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round">` +
    `<circle cx="256" cy="256" r="80"/>` +
    `<path d="M256 48v48M256 416v48M48 256h48M416 256h48M108 108l34 34M370 370l34 34M108 404l34-34M370 142l34-34"/>` +
    `</g>`,
    `<g fill="currentColor">` +
    `<circle cx="256" cy="256" r="96"/>` +
    `</g>` +
    `<g fill="none" stroke="currentColor" stroke-width="40" stroke-linecap="round">` +
    `<path d="M256 32v56M256 424v56M32 256h56M424 256h56M99 99l40 40M373 373l40 40M99 413l40-40M373 139l40-40"/>` +
    `</g>`
  ),
  dark: themeIconPair(
    `<path fill="none" stroke="currentColor" stroke-width="32" stroke-linecap="round" stroke-linejoin="round" d="M160 136c0-30.62 4.51-61.61 16-88C99.57 81.27 48 159.32 48 248c0 119.29 96.71 216 216 216 88.68 0 166.73-51.57 200-128-26.39 11.49-57.38 16-88 16-119.29 0-216-96.71-216-216z"/>`,
    `<path fill="currentColor" d="M152.62 126.77c0-33 4.85-66.35 17.23-94.77C87.54 67.83 32 151.89 32 247.38 32 375.85 136.15 480 264.62 480c95.49 0 179.55-55.54 215.38-137.85-28.42 12.38-61.8 17.23-94.77 17.23-133.87 0-242.61-108.74-242.61-242.61z"/>`
  ),
};

function userPopoverOpen() {
  const pop = $('user-popover');
  return !!(pop && !pop.classList.contains('hidden'));
}
function openUserPopover() {
  const pop = $('user-popover');
  const trigger = $('user-menu-trigger');
  if (!pop || !trigger) return;
  pop.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
}
function closeUserPopover() {
  const pop = $('user-popover');
  const trigger = $('user-menu-trigger');
  if (!pop || !trigger) return;
  pop.classList.add('hidden');
  trigger.setAttribute('aria-expanded', 'false');
}
function toggleUserPopover() {
  userPopoverOpen() ? closeUserPopover() : openUserPopover();
}

function renderMenuState() {
  document.querySelectorAll('#menu-lang button').forEach((b) =>
    b.classList.toggle('active', b.dataset.lang === I18N.lang));
  const pref = themePref();
  document.querySelectorAll('#menu-theme button').forEach((b) =>
    b.classList.toggle('active', b.dataset.themePref === pref));
  const langLabel = $('menu-lang-label');
  if (langLabel) langLabel.textContent = I18N.t('menu.language');
  const coinsLabel = $('menu-coins-label');
  if (coinsLabel) coinsLabel.textContent = I18N.t('menu.favoriteCoins');
  const themeGroup = $('menu-theme');
  if (themeGroup) themeGroup.setAttribute('aria-label', I18N.t('menu.appearance'));
  const tp = (k) => document.querySelector(`#menu-theme [data-theme-pref="${k}"]`);
  const labels = {
    system: I18N.t('appearance.system'),
    light: I18N.t('appearance.light'),
    dark: I18N.t('appearance.dark'),
  };
  for (const key of Object.keys(labels)) {
    const btn = tp(key);
    if (!btn) continue;
    btn.innerHTML = THEME_ICONS[key];
    btn.setAttribute('aria-label', labels[key]);
    btn.setAttribute('title', labels[key]);
  }
  // Collapsed cycle button: solid icon + fixed “change theme” tooltip.
  const cycle = $('menu-theme-cycle');
  if (cycle) {
    const key = THEME_CYCLE.includes(pref) ? pref : 'system';
    cycle.innerHTML = THEME_ICONS[key];
    const changeTheme = I18N.t('menu.changeTheme');
    cycle.dataset.label = changeTheme;
    cycle.setAttribute('aria-label', changeTheme);
  }
  const logout = $('menu-logout');
  const logoutLabel = $('menu-logout-label');
  if (logout) logout.setAttribute('aria-label', I18N.t('menu.logout'));
  if (logoutLabel) logoutLabel.textContent = I18N.t('menu.logout');
  const notifLabel = $('menu-notif-label');
  if (notifLabel) notifLabel.textContent = I18N.t('menu.notifications');
  updateNotifButton();
  // Keep open calculator copy in sync with language.
  if (typeof isCalcOpen === 'function') {
    if (isCalcOpen('dca')) renderDcaBody();
    if (isCalcOpen('pos')) renderPosBody();
  }
}

// ── Views ─────────────────────────────────────────────────────────────
function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  setSidebarOpen(false);
  document.body.style.overflow = '';
  applyStaticText();
  initGoogle();
}
function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  renderMenuUser();
  applyStaticText();
  startMarquee();
  loadMarket();
  loadFavoriteCoins();
  // Glossary loads in parallel — when ready, re-paint open content so terms get underlines.
  ensureGlossaryLoaded().then(() => {
    if (feedPosts.length) renderFeed();
    if (currentPostId && postCache[currentPostId]) renderPostModal(postCache[currentPostId]);
    if (currentLessonId && lessonCache[currentLessonId]) renderLessonModal(lessonCache[currentLessonId]);
    if (currentView === 'glossary') renderGlossaryPage();
  });
  if (isPreview()) { loadPreviewFeed(); } else { loadFeed(); }
  syncFromUrl(); // restores ?view= / ?post= / ?lesson= on load and after login
  maybeShowIosBanner();
  updateNotifButton();
  syncLessonPanelChrome();
}

// ── Price marquee + market modal ──────────────────────────────────────
// Modal parity: app/crypto-market.tsx + LineChart (SVG port of Skia chart).
// Chart data parity: app chartDataService layers
//   1) bundled JSON (data/charts/*.json — same files as app src/data/charts)
//   2.5) Worker GET /chart-delta (KV)
//   3) CoinGecko market_chart gap-fill

/** Full market list — mirrors useCryptoPrices CRYPTO_IDS (order matters). */
const MARKET_COINS = [
  // Marquee (first 9)
  { id: 'bitcoin', sym: 'BTC' }, { id: 'ethereum', sym: 'ETH' }, { id: 'solana', sym: 'SOL' },
  { id: 'ripple', sym: 'XRP' }, { id: 'chainlink', sym: 'LINK' }, { id: 'hyperliquid', sym: 'HYPE' },
  { id: 'cardano', sym: 'ADA' }, { id: 'sui', sym: 'SUI' }, { id: 'dogecoin', sym: 'DOGE' },
  // Extended (formSheet grid in the app)
  { id: 'binancecoin', sym: 'BNB' }, { id: 'monero', sym: 'XMR' }, { id: 'litecoin', sym: 'LTC' },
  { id: 'avalanche-2', sym: 'AVAX' }, { id: 'polkadot', sym: 'DOT' }, { id: 'the-open-network', sym: 'TON' },
  { id: 'mantle', sym: 'MNT' }, { id: 'stellar', sym: 'XLM' }, { id: 'hedera-hashgraph', sym: 'HBAR' },
  { id: 'crypto-com-chain', sym: 'CRO' }, { id: 'shiba-inu', sym: 'SHIB' }, { id: 'zcash', sym: 'ZEC' },
  { id: 'aave', sym: 'AAVE' }, { id: 'uniswap', sym: 'UNI' }, { id: 'curve-dao-token', sym: 'CRV' },
];
/** Marquee ticker = first 9 (app MARQUEE_IDS). */
const COINS = MARKET_COINS.slice(0, 9);
const MARQUEE_ID_SET = new Set(COINS.map((c) => c.id));

/** Ticker → CoinGecko id (app SYMBOL_TO_COINGECKO). */
const SYMBOL_TO_COINGECKO = Object.fromEntries(MARKET_COINS.map((c) => [c.sym, c.id]));
/** Per-coin chart accent (app COIN_COLORS). BTC falls back to theme accent. */
const COIN_COLORS = {
  ethereum: '#8B5CF6', cardano: '#8B5CF6', solana: '#8B5CF6',
  chainlink: '#3B82F6', sui: '#3B82F6', ripple: '#9CA3AF',
  dogecoin: '#EAB308', hyperliquid: '#22C55E', binancecoin: '#F0B90B',
  monero: '#FF6600', litecoin: '#345D9D', 'avalanche-2': '#E84142',
  polkadot: '#E6007A', 'the-open-network': '#0098EA', mantle: '#65EDBB',
  stellar: '#14B6E7', 'hedera-hashgraph': '#3EC878', 'crypto-com-chain': '#5C7CFA',
  'shiba-inu': '#FFA409', zcash: '#F4B728', aave: '#B6509E', uniswap: '#FF007A',
  'curve-dao-token': '#3B82F6',
  'pax-gold': '#EAB308', 'kinesis-silver': '#C0C0C0',
};
/** SegmentedControl colorVariant → selected pill colors (getNotionSelectedColors-ish). */
const COIN_SEG_COLORS = {
  ethereum: { bg: 'rgba(139,92,246,0.25)', fg: '#8B5CF6' },
  cardano: { bg: 'rgba(139,92,246,0.25)', fg: '#8B5CF6' },
  solana: { bg: 'rgba(139,92,246,0.25)', fg: '#8B5CF6' },
  chainlink: { bg: 'rgba(59,130,246,0.25)', fg: '#3B82F6' },
  sui: { bg: 'rgba(59,130,246,0.25)', fg: '#3B82F6' },
  ripple: { bg: 'rgba(156,163,175,0.25)', fg: '#9CA3AF' },
  dogecoin: { bg: 'rgba(234,179,8,0.25)', fg: '#EAB308' },
  hyperliquid: { bg: 'rgba(34,197,94,0.25)', fg: '#22C55E' },
  binancecoin: { bg: 'rgba(240,185,11,0.25)', fg: '#F0B90B' },
  monero: { bg: 'rgba(255,102,0,0.25)', fg: '#FF6600' },
  litecoin: { bg: 'rgba(52,93,157,0.25)', fg: '#345D9D' },
  'avalanche-2': { bg: 'rgba(232,65,66,0.25)', fg: '#E84142' },
  polkadot: { bg: 'rgba(230,0,122,0.25)', fg: '#E6007A' },
  'the-open-network': { bg: 'rgba(0,152,234,0.25)', fg: '#0098EA' },
  mantle: { bg: 'rgba(101,237,187,0.25)', fg: '#65EDBB' },
  stellar: { bg: 'rgba(20,182,231,0.25)', fg: '#14B6E7' },
  'hedera-hashgraph': { bg: 'rgba(62,200,120,0.25)', fg: '#3EC878' },
  'crypto-com-chain': { bg: 'rgba(92,124,250,0.25)', fg: '#5C7CFA' },
  'shiba-inu': { bg: 'rgba(255,164,9,0.25)', fg: '#FFA409' },
  zcash: { bg: 'rgba(244,183,40,0.25)', fg: '#F4B728' },
  aave: { bg: 'rgba(182,80,158,0.25)', fg: '#B6509E' },
  uniswap: { bg: 'rgba(255,0,122,0.25)', fg: '#FF007A' },
  'curve-dao-token': { bg: 'rgba(59,130,246,0.25)', fg: '#3B82F6' },
};
const CHART_PERIODS = [
  { key: '1m', days: 30, label: '1M' },
  { key: '3m', days: 90, label: '3M' },
  { key: '6m', days: 180, label: '6M' },
  { key: '1y', days: 365, label: '1Y' },
];
const CHART_HEIGHT = 200;
const CHART_HEIGHT_INLINE = 200;
const CHART_PAD = { top: 16, right: 20, bottom: 16, left: 0 }; // DEFAULT_PADDING
const CHART_PAD_INLINE = { top: 8, right: 20, bottom: 8, left: 0 }; // INLINE_PADDING
const PRICE_PADDING_RATIO = 0.08;
const CHART_CACHE_TTL = 5 * 60 * 1000; // app DEFAULT_CHART_REFETCH_MS
const CHART_GAP_MAX_DAYS = 365; // CoinGecko free tier max per request
const CHART_ZOOM_MS = 600; // TIMING.CHART_ZOOM
const CHART_DRAW_MS = 900; // useChartEntrance drawDuration
const CHART_FADE_MS = 300; // useChartEntrance opacityDuration
const CHART_SLIDE_MS = 600; // useChartEntrance slideDuration
const CHART_SLIDE_FROM = -40;
/** Dot fill texture — app chartConstants DOT_SPACING / DOT_RADIUS */
const DOT_SPACING = 8;
const DOT_RADIUS = 1;
/** easeOutCubic as CSS cubic-bezier (Reanimated Easing.out(Easing.cubic)) */
const EASE_OUT_CUBIC_CSS = 'cubic-bezier(0.215, 0.61, 0.355, 1)';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const DELTA_STALE_MS = 6 * 60 * 60 * 1000; // app chartDeltaService DELTA_STALE_MS

/** Latest prices — full market list (marquee uses first 9). */
let marqueePrices = []; // { id, sym, price, chg }
/** Layered chart result cache: key → { points, fetchedAt } */
const chartCache = {};
/** Bundled chart points cache: coinId → {t,c}[] */
const bundledChartCache = {};
/** Chart delta from Worker KV (layer 2.5). */
let chartDeltaCache = null; // { coins, fetchedAt } | null
let mmState = {
  coinId: 'bitcoin',
  period: '6m',
  loading: false,
  error: false,
  points: null, // full series for selected coin
  scrub: null,  // { i, x, y, price, t } while dragging
  chartGeom: null, // last render geometry for scrub hit-testing
  displayDays: 180, // animated visible window (period zoom)
  playEntrance: false, // one-shot draw/fade/slide after data lands
  zoomRaf: 0,
};

function formatUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(4);
}
function formatChg(v) {
  if (v == null || !isFinite(v)) return '';
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';
}
/** Tooltip price tiers — mirrors formatTooltipPrice in chartUtils.ts */
function formatTooltipPrice(price) {
  if (price == null || !isFinite(price)) return '—';
  const abs = Math.abs(price);
  let decimals;
  if (abs >= 1000) decimals = 0;
  else if (abs >= 100) decimals = 1;
  else if (abs >= 10) decimals = 2;
  else if (abs >= 1) decimals = 3;
  else decimals = 4;
  return price.toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  });
}
function formatTooltipDate(ts) {
  const d = new Date(ts);
  // UTC date to avoid timezone shift (CoinGecko timestamps are UTC midnight)
  const utc = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const locale = I18N.lang === 'en' ? 'en-US' : 'pt-BR';
  // Build day-first without locale "de" articles (pt-BR would yield "18 de dez. de 2025").
  // Result: "18 Dez. 2025" / "18 Dec 2025" — mirrors app chartUtils formatTooltipDate.
  let month = utc.toLocaleDateString(locale, { month: 'short' }).replace(/\.$/, '').trim();
  month = month.charAt(0).toUpperCase() + month.slice(1);
  if (I18N.lang !== 'en') month += '.';
  return `${utc.getDate()} ${month} ${utc.getFullYear()}`;
}
function coinAccent(id) {
  return COIN_COLORS[id] || '#F15B24'; // theme accent (BTC)
}

async function fetchPrices() {
  // Fetch the full market list (app useCryptoPrices CRYPTO_IDS), not just the marquee 9.
  const ids = MARKET_COINS.map((c) => c.id).join(',');
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}` +
    `&order=market_cap_desc&sparkline=false&price_change_percentage=24h`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  const rows = await res.json();
  const byId = {};
  rows.forEach((r) => { byId[r.id] = r; });
  return MARKET_COINS.map((c) => {
    const r = byId[c.id] || {};
    return { id: c.id, sym: c.sym, price: r.current_price, chg: r.price_change_percentage_24h };
  });
}
function marqueeItemHtml(c) {
  const dir = (c.chg ?? 0) >= 0 ? 'up' : 'down';
  return `<div class="marquee__item">
    <img class="marquee__icon" src="./assets/crypto/${c.sym}.webp" alt="" onerror="this.style.visibility='hidden'"/>
    <div class="marquee__info">
      <span class="marquee__sym">${c.sym}</span>
      <span class="marquee__pricerow">
        <span class="marquee__price">${formatUsd(c.price)}</span>
        <span class="marquee__chg ${dir}">${formatChg(c.chg)}</span>
      </span>
    </div>
  </div>`;
}
async function refreshMarquee() {
  try {
    marqueePrices = await fetchPrices();
    // Marquee only scrolls the first 9 (app MARQUEE_IDS).
    const items = marqueePrices.filter((c) => MARQUEE_ID_SET.has(c.id)).map(marqueeItemHtml).join('');
    $('marquee-track').innerHTML = items + items + items;
    if (isMarketModalOpen()) {
      renderMarketModalHeader();
      renderMarketModalGrid();
      // Live price updates the chart's last point
      if (mmState.points) renderMarketChart();
    }
  } catch (e) { /* keep previous prices */ }
}
function startMarquee() {
  const el = $('marquee');
  if (el) el.setAttribute('aria-label', I18N.t('marquee.aria'));
  refreshMarquee();
  // Warm chart delta (layer 2.5) so the first chart open is snappy.
  getChartDelta().catch(() => {});
  if (marqueeTimer) clearInterval(marqueeTimer);
  marqueeTimer = setInterval(refreshMarquee, 120000);
}

// ── Shared price chart engine (SVG port of LineChart + useChartEntrance) ──
function isMarketModalOpen() {
  return !$('market-modal').classList.contains('hidden');
}

/** easeOutCubic — matches Reanimated Easing.out(Easing.cubic). */
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/** Animate a numeric value over `ms` with easeOutCubic. Returns cancel fn. */
function animateValue(from, to, ms, onUpdate, onDone) {
  const t0 = performance.now();
  let raf = 0;
  let cancelled = false;
  const tick = (now) => {
    if (cancelled) return;
    const p = Math.min(1, (now - t0) / ms);
    onUpdate(from + (to - from) * easeOutCubic(p));
    if (p < 1) raf = requestAnimationFrame(tick);
    else if (onDone) onDone();
  };
  raf = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(raf); };
}

/** Monotone cubic hermite — mirrors chartUtils.monotoneCubicPath (SVG path string). */
function monotoneCubicPath(points) {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M${points[0].x},${points[0].y} L${points[1].x},${points[1].y}`;
  }
  const n = points.length;
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1].x - points[i].x);
    dy.push(points[i + 1].y - points[i].y);
    m.push(dy[i] / (dx[i] || 1e-9));
  }
  const tangents = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    tangents.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  }
  tangents.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(m[i]) < 1e-10) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
    } else {
      const alpha = tangents[i] / m[i];
      const beta = tangents[i + 1] / m[i];
      const s = alpha * alpha + beta * beta;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        tangents[i] = tau * alpha * m[i];
        tangents[i + 1] = tau * beta * m[i];
      }
    }
  }
  let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const d = dx[i] / 3;
    const cp1x = points[i].x + d;
    const cp1y = points[i].y + tangents[i] * d;
    const cp2x = points[i + 1].x - d;
    const cp2y = points[i + 1].y - tangents[i + 1] * d;
    path += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${points[i + 1].x.toFixed(2)},${points[i + 1].y.toFixed(2)}`;
  }
  return path;
}

/** Resolve `time:6m` / `45d` / `2y` → days. Bundle covers multi-year; no hard 365 cap. */
function resolveTimeRangeDays(range) {
  if (!range) return 90;
  const legacy = { '1d': 1, '1w': 7, '1m': 30, '3m': 90, '6m': 180, '1y': 365, '2y': 730, '3y': 1095 };
  const key = String(range).toLowerCase();
  let days = legacy[key];
  if (days == null) {
    const m = key.match(/^(\d+)([dwmy])$/i);
    if (!m) return 90;
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase();
    days = u === 'd' ? n : u === 'w' ? n * 7 : u === 'm' ? n * 30 : n * 365;
  }
  return Math.min(Math.max(days, 1), 6000); // app MAX_CHART_DAYS
}

function normalizeToMidnightUTC(timestamp) {
  return Math.floor(timestamp / ONE_DAY_MS) * ONE_DAY_MS;
}

/** Merge two series, dedup by UTC day (overlay wins) — app chartDataService.mergeAndDedup. */
function mergeAndDedup(base, overlay) {
  const byDay = new Map();
  for (const p of base || []) byDay.set(normalizeToMidnightUTC(p.t), p);
  for (const p of overlay || []) byDay.set(normalizeToMidnightUTC(p.t), p);
  return Array.from(byDay.values()).sort((a, b) => a.t - b.t);
}

function filterToLastNDays(points, days) {
  const cutoff = Date.now() - days * ONE_DAY_MS;
  return (points || []).filter((p) => p.t >= cutoff);
}

/** Layer 1: bundled columnar JSON (same files as app src/data/charts). */
async function loadBundledChart(coinId) {
  if (bundledChartCache[coinId]) return bundledChartCache[coinId];
  try {
    const res = await fetch(`./data/charts/${encodeURIComponent(coinId)}.json`);
    if (!res.ok) {
      bundledChartCache[coinId] = { points: [], lastDate: null };
      return bundledChartCache[coinId];
    }
    const col = await res.json();
    // Columnar → {t,c}[] (app columnarToRowBased + bundledDailyToPoints)
    const points = [];
    const ts = col.daily_t || [];
    const cs = col.daily_c || [];
    for (let i = 0; i < ts.length; i++) {
      if (isFinite(ts[i]) && isFinite(cs[i])) points.push({ t: ts[i], c: cs[i] });
    }
    points.sort((a, b) => a.t - b.t);
    const entry = { points, lastDate: col.lastDate || null };
    bundledChartCache[coinId] = entry;
    return entry;
  } catch (e) {
    bundledChartCache[coinId] = { points: [], lastDate: null };
    return bundledChartCache[coinId];
  }
}

/** Layer 2.5: Worker KV delta (app chartDeltaService → GET /chart-delta). */
async function getChartDelta() {
  if (chartDeltaCache && Date.now() - chartDeltaCache.fetchedAt < DELTA_STALE_MS) {
    return chartDeltaCache.data;
  }
  try {
    const res = await fetch(`${CONFIG.workerBase}/chart-delta`);
    if (!res.ok) return chartDeltaCache ? chartDeltaCache.data : null;
    const data = await res.json();
    chartDeltaCache = { data, fetchedAt: Date.now() };
    return data;
  } catch (e) {
    return chartDeltaCache ? chartDeltaCache.data : null;
  }
}

function deltaPointsForCoin(delta, coinId) {
  const daily = delta && delta.coins && delta.coins[coinId] && delta.coins[coinId].daily;
  if (!daily || !daily.length) return [];
  return daily.map((d) => ({ t: d.t, c: d.c })).filter((p) => isFinite(p.t) && isFinite(p.c));
}

/** Layer 3: CoinGecko gap-fill — same endpoint as app fetchGapFromApi. */
async function fetchGapFromApi(coinId, gapDays) {
  const fetchDays = Math.min(gapDays + 1, CHART_GAP_MAX_DAYS);
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart` +
    `?vs_currency=usd&days=${fetchDays}`;
  const res = await fetch(url);
  if (res.status === 429) throw new Error('rate_limit');
  if (!res.ok) throw new Error(`chart ${res.status}`);
  const json = await res.json();
  return (json.prices || [])
    .map(([t, c]) => ({ t, c }))
    .filter((p) => isFinite(p.t) && isFinite(p.c))
    .sort((a, b) => a.t - b.t);
}

function periodDays(key) {
  const p = CHART_PERIODS.find((x) => x.key === key);
  return p ? p.days : 180;
}

function sliceChartPoints(points, days, livePrice) {
  if (!points || points.length === 0) return [];
  const ref = points[points.length - 1].t;
  const cutoff = ref - days * 24 * 60 * 60 * 1000;
  let sliced = points.filter((p) => p.t >= cutoff);
  if (sliced.length < 2) sliced = points.slice(-2);
  if (livePrice != null && isFinite(livePrice) && sliced.length > 0) {
    sliced = sliced.map((p, i) => (i === sliced.length - 1 ? { t: p.t, c: livePrice } : p));
  }
  return sliced;
}

function periodChangePct(points, days, livePrice) {
  const sliced = sliceChartPoints(points, days, null);
  if (sliced.length < 2) return null;
  const first = sliced[0].c;
  const last = (livePrice != null && isFinite(livePrice)) ? livePrice : sliced[sliced.length - 1].c;
  if (!first) return null;
  return ((last - first) / first) * 100;
}

function chartCacheKey(coinId, days, endDate) {
  return `${coinId}|${days}|${endDate || 'now'}`;
}

/**
 * Live chart series — mirrors app getLayeredChartData:
 *   bundle → delta (/chart-delta) → CoinGecko gap-fill.
 * @param {string} coinId
 * @param {number} days
 */
async function getLayeredChartData(coinId, days) {
  days = Math.min(Math.max(days || 365, 1), 6000);
  const key = chartCacheKey(coinId, days, null);
  const cached = chartCache[key];
  if (cached && Date.now() - cached.fetchedAt < CHART_CACHE_TTL) return cached.points;

  const bundled = await loadBundledChart(coinId);
  const bundledPoints = bundled.points || [];
  const delta = await getChartDelta();
  const deltaPts = deltaPointsForCoin(delta, coinId);
  let localPoints = mergeAndDedup(bundledPoints, deltaPts);

  const lastKnownTs = localPoints.length ? localPoints[localPoints.length - 1].t : 0;
  const gapDays = Math.ceil((Date.now() - lastKnownTs) / ONE_DAY_MS);

  // Layer 3: only if missing more than 1 day (app chartDataService)
  if (gapDays > 1) {
    try {
      const fresh = await fetchGapFromApi(coinId, gapDays);
      localPoints = mergeAndDedup(localPoints, fresh);
    } catch (e) {
      if (!localPoints.length) throw e;
      // keep local on API failure / rate limit
    }
  }

  const points = filterToLastNDays(localPoints, days);
  if (points.length < 2) throw new Error('empty chart');
  chartCache[key] = { points, fetchedAt: Date.now() };
  // Alias coinId for modal quick lookup of the longest series we have
  chartCache[coinId] = chartCache[key];
  return points;
}

/**
 * Frozen historical series — mirrors app getFrozenChartData:
 * prefer local (bundle+delta), fall back to CoinGecko range.
 */
async function getFrozenChartData(coinId, days, endDate) {
  days = Math.min(Math.max(days || 90, 1), 6000);
  const key = chartCacheKey(coinId, days, endDate);
  const cached = chartCache[key];
  if (cached && Date.now() - cached.fetchedAt < CHART_CACHE_TTL) return cached.points;

  const endMs = new Date(endDate + 'T00:00:00Z').getTime() + ONE_DAY_MS - 1;
  const startMs = endMs - days * ONE_DAY_MS;

  const bundled = await loadBundledChart(coinId);
  const delta = await getChartDelta();
  let local = mergeAndDedup(bundled.points || [], deltaPointsForCoin(delta, coinId));
  local = local.filter((p) => p.t >= startMs && p.t <= endMs);

  if (local.length >= 2) {
    chartCache[key] = { points: local, fetchedAt: Date.now() };
    return local;
  }

  // Fall back to CoinGecko range (app useBtcOhlc frozen path)
  const url = `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart/range` +
    `?vs_currency=usd&from=${Math.floor(startMs / 1000)}&to=${Math.floor(endMs / 1000)}`;
  const res = await fetch(url);
  if (res.status === 429) throw new Error('rate_limit');
  if (!res.ok) throw new Error(`chart ${res.status}`);
  const json = await res.json();
  const points = (json.prices || [])
    .map(([t, c]) => ({ t, c }))
    .filter((p) => isFinite(p.t) && isFinite(p.c) && p.t >= startMs && p.t <= endMs)
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) throw new Error('empty chart');
  chartCache[key] = { points, fetchedAt: Date.now() };
  return points;
}

/** Unified entry used by modal + inline embeds. */
async function fetchCoinChart(coinId, days = 365, endDate = null) {
  if (endDate && endDate !== 'now') return getFrozenChartData(coinId, days, endDate);
  return getLayeredChartData(coinId, days);
}

function buildChartGeometry(sliced, width, height, pad) {
  const P = pad || CHART_PAD;
  const chartW = Math.max(1, width - P.left - P.right);
  const chartH = Math.max(1, height - P.top - P.bottom);
  let minP = Infinity, maxP = -Infinity;
  for (const p of sliced) {
    if (p.c < minP) minP = p.c;
    if (p.c > maxP) maxP = p.c;
  }
  const yPad = (maxP - minP || 1) * PRICE_PADDING_RATIO;
  const paddedMin = minP - yPad;
  const paddedMax = maxP + yPad;
  const range = paddedMax - paddedMin || 1;
  const pts = sliced.map((p, i) => ({
    x: P.left + (i / (sliced.length - 1)) * chartW,
    y: P.top + chartH - ((p.c - paddedMin) / range) * chartH,
    c: p.c,
    t: p.t,
  }));
  return { pts, chartW, chartH, paddedMin, paddedMax, P, width, height };
}

/**
 * Paint a price line chart into `host`.
 * Fill uses accent-tinted dots + vertical fade (app LineChart ImageShader dots).
 * opts: { points, days, currentPrice, accent, height, pad, scrub, uid,
 *         playEntrance, withSlide, liveDot }
 * Returns geometry for scrub hit-testing.
 */
function paintPriceChart(host, tipEl, opts) {
  const {
    points, days, currentPrice, accent, height = CHART_HEIGHT,
    pad = CHART_PAD, scrub = null, uid = 'pc',
    playEntrance = false, withSlide = false, liveDot = true,
  } = opts;
  const width = host.clientWidth || host.parentElement?.clientWidth || 360;
  const sliced = sliceChartPoints(points, days, currentPrice);
  if (sliced.length < 2) {
    host.innerHTML = `<div class="pc__fallback">${I18N.t('widget.chartError')}</div>`;
    if (tipEl) tipEl.classList.add('hidden');
    return null;
  }
  const geom = buildChartGeometry(sliced, width, height, pad);
  const { pts, chartH, P } = geom;
  const linePath = monotoneCubicPath(pts);
  const last = pts[pts.length - 1];
  const fillPath = linePath +
    ` L${last.x.toFixed(2)},${(P.top + chartH).toFixed(2)}` +
    ` L${pts[0].x.toFixed(2)},${(P.top + chartH).toFixed(2)} Z`;
  const dark = isDark();
  const crosshair = dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)';
  const innerDot = dark ? '#000000' : '#FFFFFF';
  const dotsId = `${uid}-dots`;
  const fadeId = `${uid}-fade`;
  const fadeMaskId = `${uid}-fade-mask`;
  const fillClipId = `${uid}-fill-clip`;
  const crossId = `${uid}-cross`;
  const drawClipId = `${uid}-draw`;

  let scrubDefs = '';
  let scrubSvg = '';
  if (scrub && tipEl) {
    scrubDefs =
      `<linearGradient id="${crossId}" x1="0" y1="${P.top}" x2="0" y2="${P.top + chartH}" gradientUnits="userSpaceOnUse">` +
        `<stop offset="0%" stop-color="${crosshair}" stop-opacity="0"/>` +
        `<stop offset="12%" stop-color="${crosshair}" stop-opacity="1"/>` +
        `<stop offset="88%" stop-color="${crosshair}" stop-opacity="1"/>` +
        `<stop offset="100%" stop-color="${crosshair}" stop-opacity="0"/>` +
      `</linearGradient>`;
    scrubSvg =
      `<rect x="${(scrub.x - 0.5).toFixed(2)}" y="${P.top}" width="1" height="${chartH}" fill="url(#${crossId})"/>` +
      `<circle cx="${scrub.x.toFixed(2)}" cy="${scrub.y.toFixed(2)}" r="5" fill="${accent}"/>` +
      `<circle cx="${scrub.x.toFixed(2)}" cy="${scrub.y.toFixed(2)}" r="2" fill="${innerDot}"/>`;
    tipEl.innerHTML =
      `<div class="mm__tooltip-price">${formatTooltipPrice(scrub.price)}</div>` +
      `<div class="mm__tooltip-date">${formatTooltipDate(scrub.t)}</div>`;
    tipEl.classList.remove('hidden');
    const tipW = tipEl.offsetWidth || 100;
    let left = scrub.x + 8;
    if (left + tipW > width - 8) left = scrub.x - tipW - 8;
    tipEl.style.left = `${Math.max(8, left)}px`;
    tipEl.style.top = `${Math.max(4, scrub.y - 40)}px`;
  } else if (tipEl) {
    tipEl.classList.add('hidden');
  }

  const stageClass = 'pc__stage' + (playEntrance ? (withSlide ? ' pc__stage--slide' : '') : ' is-in');
  // Left→right reveal via clipPath (proxy for Skia Path start/end = drawProgress).
  const clipW = playEntrance ? 0 : width;
  // Dot pattern: 8×8 tile, r=1, centered (app DOT_SPACING / DOT_RADIUS)
  const half = DOT_SPACING / 2;

  host.innerHTML =
    `<div class="${stageClass}" data-pc-stage>` +
      `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none">` +
        `<defs>` +
          // Accent-tinted dots (app: white tile → srcIn accent)
          `<pattern id="${dotsId}" width="${DOT_SPACING}" height="${DOT_SPACING}" patternUnits="userSpaceOnUse">` +
            `<circle cx="${half}" cy="${half}" r="${DOT_RADIUS}" fill="${accent}"/>` +
          `</pattern>` +
          // Vertical fade 0.5 → 0 over the chart body (app LinearGradient dstIn)
          `<linearGradient id="${fadeId}" x1="0" y1="${P.top}" x2="0" y2="${P.top + chartH}" gradientUnits="userSpaceOnUse">` +
            `<stop offset="0%" stop-color="#fff" stop-opacity="0.5"/>` +
            `<stop offset="100%" stop-color="#fff" stop-opacity="0"/>` +
          `</linearGradient>` +
          `<mask id="${fadeMaskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}">` +
            `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#${fadeId})"/>` +
          `</mask>` +
          `<clipPath id="${fillClipId}"><path d="${fillPath}"/></clipPath>` +
          scrubDefs +
          `<clipPath id="${drawClipId}"><rect data-pc-clip x="0" y="0" width="${clipW}" height="${height}"/></clipPath>` +
        `</defs>` +
        `<g clip-path="url(#${drawClipId})">` +
          // Dots fill under the line, clipped to area + faded top→bottom
          `<g clip-path="url(#${fillClipId})" mask="url(#${fadeMaskId})">` +
            `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#${dotsId})"/>` +
          `</g>` +
          `<path d="${linePath}" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
          (liveDot && currentPrice != null
            ? `<circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="3.5" fill="${accent}"/>` +
              `<circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="2" fill="${innerDot}"/>`
            : `<circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="3" fill="${accent}"/>`) +
        `</g>` +
        scrubSvg +
      `</svg>` +
    `</div>`;

  if (playEntrance) {
    // Double-rAF anti-blink (useChartEntrance), then fade/slide + draw with easeOutCubic.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const stage = host.querySelector('[data-pc-stage]');
        const clip = host.querySelector('[data-pc-clip]');
        if (stage) stage.classList.add('is-in');
        // Animate draw clip width with the same easeOutCubic as Reanimated
        // (CSS transitions on SVG width attrs are unreliable across browsers).
        if (clip) {
          animateValue(0, width, CHART_DRAW_MS, (w) => {
            clip.setAttribute('width', String(Math.max(0, w)));
          }, () => {
            clip.setAttribute('width', String(width));
          });
        }
      });
    });
  }

  return geom;
}

// ── Market modal (chart) ──────────────────────────────────────────────

function selectedMarqueeCoin() {
  return marqueePrices.find((c) => c.id === mmState.coinId)
    || MARKET_COINS.find((c) => c.id === mmState.coinId)
    || MARKET_COINS[0];
}

function renderMarketModalHeader() {
  const coin = selectedMarqueeCoin();
  const periodChg = periodChangePct(mmState.points, periodDays(mmState.period), coin.price);
  const chg24 = coin.chg;
  const periodHtml = periodChg == null ? '' :
    `<span class="mm__coin-chg ${periodChg >= 0 ? 'up' : 'down'}">${formatChg(periodChg)}</span>` +
    `<span class="mm__coin-dot">•</span>`;
  const chg24Html = chg24 == null ? '' :
    `<span class="mm__coin-chg ${chg24 >= 0 ? 'up' : 'down'}">${formatChg(chg24)}</span>` +
    `<span class="mm__coin-24h">(24h)</span>`;

  $('mm-header').innerHTML =
    `<img class="mm__coin-icon" src="./assets/crypto/${coin.sym}.webp" alt="" onerror="this.style.visibility='hidden'"/>` +
    `<div class="mm__coin-info">` +
      `<div class="mm__coin-sym">${coin.sym}</div>` +
      `<div class="mm__coin-pricerow">` +
        `<span class="mm__coin-price">${formatUsd(coin.price)}</span>` +
        periodHtml + chg24Html +
      `</div>` +
    `</div>`;
}

/** Apply coin accent CSS vars for period seg + selected pill (app COIN_COLOR_VARIANTS). */
function applyCoinAccentVars() {
  const seg = COIN_SEG_COLORS[mmState.coinId];
  const panel = document.querySelector('#market-modal .mm__panel');
  const targets = [$('mm-periods'), $('mm-grid'), panel].filter(Boolean);
  for (const el of targets) {
    if (seg) {
      el.style.setProperty('--mm-seg-bg', seg.bg);
      el.style.setProperty('--mm-seg-fg', seg.fg);
    } else {
      el.style.removeProperty('--mm-seg-bg');
      el.style.removeProperty('--mm-seg-fg');
    }
  }
}

function renderMarketModalPeriods() {
  applyCoinAccentVars();
  const host = $('mm-periods');
  host.innerHTML = `<div class="mm__seg" role="tablist">` +
    CHART_PERIODS.map((p) =>
      `<button type="button" role="tab" data-period="${p.key}"` +
      ` aria-selected="${p.key === mmState.period}"` +
      ` class="${p.key === mmState.period ? 'active' : ''}">${p.label}</button>`
    ).join('') +
    `</div>`;
}

function renderMarketModalGrid() {
  // Full market list — same layout as app CryptoGridItem (icon + sym + price, radius 20).
  applyCoinAccentVars();
  const byId = {};
  marqueePrices.forEach((c) => { byId[c.id] = c; });
  const list = MARKET_COINS.map((c) => {
    const live = byId[c.id];
    return { id: c.id, sym: c.sym, price: live ? live.price : null };
  });
  $('mm-grid').innerHTML = list.map((c) => {
    const sel = c.id === mmState.coinId;
    return `<button type="button" class="mm__grid-item${sel ? ' selected' : ''}"` +
      ` data-coin="${c.id}" aria-pressed="${sel}"` +
      `${sel ? ' disabled' : ''}>` +
      `<img class="mm__grid-icon" src="./assets/crypto/${c.sym}.webp" alt="" onerror="this.style.visibility='hidden'"/>` +
      `<span class="mm__grid-info">` +
        `<span class="mm__grid-sym">${c.sym}</span>` +
        `<span class="mm__grid-price">${formatUsd(c.price)}</span>` +
      `</span></button>`;
  }).join('');
}

function renderMarketChart(opts = {}) {
  const host = $('mm-chart');
  const tip = $('mm-tooltip');
  const coin = selectedMarqueeCoin();
  const accent = coinAccent(mmState.coinId);

  if (mmState.loading) {
    mmState.chartGeom = null;
    tip.classList.add('hidden');
    host.innerHTML = `<div class="mm__chart-sk"></div>`;
    return;
  }
  if (mmState.error || !mmState.points) {
    mmState.chartGeom = null;
    tip.classList.add('hidden');
    host.innerHTML =
      `<div class="mm__chart-fallback">` +
        `<span>${I18N.t('marketModal.chartError')}</span>` +
        `<button type="button" id="mm-retry">${I18N.t('marketModal.retry')}</button>` +
      `</div>`;
    return;
  }

  const playEntrance = !!(opts.playEntrance || mmState.playEntrance) && !mmState.scrub;
  if (playEntrance) mmState.playEntrance = false;

  mmState.chartGeom = paintPriceChart(host, tip, {
    points: mmState.points,
    days: mmState.displayDays,
    currentPrice: coin.price,
    accent,
    height: CHART_HEIGHT,
    pad: CHART_PAD,
    scrub: mmState.scrub,
    uid: 'mm-' + mmState.coinId.replace(/[^a-z0-9]/gi, ''),
    playEntrance,
    withSlide: true, // modal charts slide in (useChartEntrance withSlide: !inline)
    liveDot: true,
  });
}

/** Modal always loads ≥1y so all period tabs can zoom over the same series. */
const MODAL_SERIES_DAYS = 365;

async function loadMarketChart(force) {
  const coinId = mmState.coinId;
  mmState.error = false;
  mmState.scrub = null;
  if (force) {
    delete chartCache[coinId];
    delete chartCache[chartCacheKey(coinId, MODAL_SERIES_DAYS, null)];
    // Force re-fetch of delta next time if needed
    chartDeltaCache = null;
  }

  // Serve cache instantly (no skeleton flash) when still fresh.
  const cached = chartCache[coinId] || chartCache[chartCacheKey(coinId, MODAL_SERIES_DAYS, null)];
  if (cached && Date.now() - cached.fetchedAt < CHART_CACHE_TTL) {
    mmState.points = cached.points;
    mmState.loading = false;
    mmState.playEntrance = true;
    renderMarketModalHeader();
    renderMarketChart({ playEntrance: true });
    return;
  }

  mmState.loading = true;
  renderMarketChart();
  try {
    // Layered: bundle + /chart-delta + CoinGecko gap (app getLayeredChartData)
    mmState.points = await fetchCoinChart(coinId, MODAL_SERIES_DAYS, null);
    // Ignore stale responses if the user switched coins mid-flight
    if (mmState.coinId !== coinId) return;
    mmState.loading = false;
    mmState.error = false;
    mmState.playEntrance = true;
  } catch (e) {
    if (mmState.coinId !== coinId) return;
    mmState.loading = false;
    mmState.error = true;
    mmState.points = null;
  }
  renderMarketModalHeader();
  renderMarketChart({ playEntrance: !!mmState.points });
}

function openMarketModal() {
  // Always open on BTC (whole-marquee interaction, same as app card tap).
  if (typeof mmState.zoomRaf === 'function') mmState.zoomRaf();
  mmState.coinId = 'bitcoin';
  mmState.period = '6m';
  mmState.displayDays = periodDays('6m');
  mmState.scrub = null;
  mmState.points = chartCache.bitcoin?.points
    || chartCache[chartCacheKey('bitcoin', MODAL_SERIES_DAYS, null)]?.points
    || null;
  mmState.error = false;
  mmState.playEntrance = true;

  $('market-modal-close').setAttribute('aria-label', I18N.t('marketModal.close'));
  renderMarketModalHeader();
  renderMarketModalPeriods();
  renderMarketModalGrid();
  openOverlay($('market-modal'));
  try { $('market-modal-close').focus({ preventScroll: true }); } catch (e) {}

  loadMarketChart(false);
}

function closeMarketModal() {
  const root = $('market-modal');
  if (root.classList.contains('hidden') || root.classList.contains('is-closing')) return;
  animateOverlayClose(root, '.mm__panel', () => {
    mmState.scrub = null;
    if (typeof mmState.zoomRaf === 'function') mmState.zoomRaf();
    unlockBodyScrollIfIdle();
  });
}

function selectMarketCoin(coinId) {
  if (!coinId || coinId === mmState.coinId) return;
  if (typeof mmState.zoomRaf === 'function') mmState.zoomRaf();
  mmState.coinId = coinId;
  mmState.scrub = null;
  mmState.displayDays = periodDays(mmState.period);
  mmState.points = chartCache[coinId]?.points
    || chartCache[chartCacheKey(coinId, MODAL_SERIES_DAYS, null)]?.points
    || null;
  mmState.playEntrance = true;
  renderMarketModalHeader();
  renderMarketModalPeriods();
  renderMarketModalGrid();
  loadMarketChart(false);
}

function selectMarketPeriod(period) {
  if (!period || period === mmState.period) return;
  mmState.period = period;
  mmState.scrub = null;
  const target = periodDays(period);
  renderMarketModalHeader();
  renderMarketModalPeriods();
  // Zoom animation (LineChart displayDays withTiming 600ms) — re-slice each frame.
  if (typeof mmState.zoomRaf === 'function') mmState.zoomRaf();
  const from = mmState.displayDays;
  mmState.zoomRaf = animateValue(from, target, CHART_ZOOM_MS, (v) => {
    mmState.displayDays = v;
    renderMarketChart();
  }, () => {
    mmState.displayDays = target;
    mmState.zoomRaf = 0;
    renderMarketChart();
  });
}

/** Map pointer X → nearest chart point for scrub/tooltip. */
function scrubAtClientX(clientX) {
  const geom = mmState.chartGeom;
  if (!geom || !geom.pts.length) return;
  const wrap = $('mm-chart-wrap');
  const rect = wrap.getBoundingClientRect();
  const x = clientX - rect.left;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < geom.pts.length; i++) {
    const d = Math.abs(geom.pts[i].x - x);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  const p = geom.pts[best];
  mmState.scrub = { i: best, x: p.x, y: p.y, price: p.c, t: p.t };
  renderMarketChart();
}
function endScrub() {
  if (!mmState.scrub) return;
  mmState.scrub = null;
  renderMarketChart();
}

// ── Notion widget embeds ({{chart:…}} / {{price:…}}) ─────────────────
// Mirrors app transforms.ts parseWidgetKeyValues + parseChartFromKV / parsePriceFromKV.
const WIDGET_DETECT_RE = /^\{\{([a-zA-Z_]+):(.+)\}\}$/s;

function normalizeWidgetSyntax(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .join('');
}

function parseWidgetKeyValues(content) {
  const segments = content.split(';');
  if (!segments.length || !segments[0]) return null;
  const asset = segments[0].trim();
  if (!/^[A-Za-z]+$/.test(asset)) return null;
  const params = {};
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const colonIdx = seg.indexOf(':');
    if (colonIdx > 0) {
      params[seg.substring(0, colonIdx).toLowerCase()] = seg.substring(colonIdx + 1);
    }
  }
  return { asset: asset.toUpperCase(), params };
}

function parseChartFromKV(asset, kv) {
  const date = kv.date;
  const chartType = kv.type;
  if (!date || !chartType) return null;
  if (!['line', 'candle', 'rsi', 'fng', 'cycle'].includes(chartType)) return null;
  if (!/^(now|\d{4}-\d{2}-\d{2})$/.test(date)) return null;
  const timeRange = kv.time;
  const fromDate = kv.from;
  if (chartType !== 'cycle') {
    if (!timeRange && !fromDate) return null;
  }
  if (timeRange && !/^\d+[wmyd]$/i.test(timeRange)) return null;
  if (fromDate && !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return null;
  const out = {
    asset,
    date,
    chartType,
    size: kv.size === 'half' ? 'half' : 'full',
  };
  if (timeRange) out.timeRange = timeRange;
  else if (fromDate) out.fromDate = fromDate;
  return out;
}

function parsePriceFromKV(asset, kv) {
  const date = kv.date;
  if (!date || !/^(now|\d{4}-\d{2}-\d{2})$/.test(date)) return null;
  return { asset, date };
}

/** Parse a full plain-text paragraph/code into a widget descriptor, or null. */
function tryParseWidget(rawText) {
  const full = normalizeWidgetSyntax(rawText).trim();
  const m = full.match(WIDGET_DETECT_RE);
  if (!m) return null;
  const widgetType = m[1].toLowerCase();
  const content = m[2];
  if (widgetType === 'chart') {
    const parsed = parseWidgetKeyValues(content);
    if (!parsed) return { kind: 'unsupported' };
    const chartParams = parseChartFromKV(parsed.asset, parsed.params);
    if (!chartParams) return { kind: 'unsupported' };
    return { kind: 'chart', params: chartParams };
  }
  if (widgetType === 'price') {
    const parsed = parseWidgetKeyValues(content);
    if (!parsed) return { kind: 'unsupported' };
    const priceParams = parsePriceFromKV(parsed.asset, parsed.params);
    if (!priceParams) return { kind: 'unsupported' };
    return { kind: 'price', params: priceParams };
  }
  // Unknown future widget type
  return { kind: 'unsupported' };
}

function unsupportedWidgetHtml() {
  return `<div class="nb-widget-unsupported" role="note">` +
    `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">` +
    `<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>` +
    `<span>${I18N.t('widget.unsupported')}</span></div>`;
}

function chartEmbedPlaceholder(params) {
  // Only line charts are painted on the web for now; other types get unsupported.
  if (params.chartType !== 'line') return unsupportedWidgetHtml();
  const coinId = SYMBOL_TO_COINGECKO[params.asset];
  if (!coinId) return unsupportedWidgetHtml();
  const payload = escapeHtml(JSON.stringify(params));
  // size:half is paired into .nb-half-row by renderBlocks (class kept for debugging).
  const half = params.size === 'half' ? ' nb-chart--half' : '';
  return `<div class="nb-chart${half}" data-nb-chart="${payload}" role="img" aria-label="${escapeHtml(params.asset)} chart">` +
    `<div class="nb-chart__sk"></div></div>`;
}

/** App NotionRenderer groupHalfCharts: price widgets always half; charts when size:half. */
function isHalfWidthWidget(kind, params) {
  if (kind === 'price') return true;
  if (kind === 'chart') return !!(params && params.size === 'half');
  return false;
}

function priceWidgetPlaceholder(params) {
  const coinId = SYMBOL_TO_COINGECKO[params.asset];
  if (!coinId) {
    return `<div class="nb-price"><span class="nb-price__unknown">${I18N.t('widget.unknownAsset')}: ${escapeHtml(params.asset)}</span></div>`;
  }
  const payload = escapeHtml(JSON.stringify(params));
  return `<div class="nb-price" data-nb-price="${payload}">` +
    `<div class="nb-price__card">` +
      `<div class="nb-price__sk-icon"></div>` +
      `<div class="nb-price__sk-text"><div class="nb-price__sk-line"></div><div class="nb-price__sk-line short"></div></div>` +
    `</div></div>`;
}

function plainFromBlock(b) {
  if (!b) return '';
  if (b.type === 'paragraph' && b.paragraph) {
    return (b.paragraph.rich_text || []).map((r) => r.plain_text || '').join('');
  }
  if (b.type === 'code' && b.code) {
    return (b.code.rich_text || []).map((r) => r.plain_text || '').join('');
  }
  // Transformed blocks (if API ever pre-parses)
  if (b.type === 'chart_embed' && b.chartParams) return null; // handled separately
  return '';
}

function daysForChartParams(params) {
  if (params.fromDate) {
    const fromMs = new Date(params.fromDate + 'T00:00:00Z').getTime();
    const endMs = params.date !== 'now'
      ? new Date(params.date + 'T00:00:00Z').getTime()
      : Date.now();
    return Math.min(Math.max(Math.ceil((endMs - fromMs) / 86400000), 1), 6000);
  }
  return resolveTimeRangeDays(params.timeRange || '3m');
}

async function mountInlineChart(el) {
  if (!el || el.dataset.mounted === '1') return;
  el.dataset.mounted = '1';
  let params;
  try { params = JSON.parse(el.getAttribute('data-nb-chart') || '{}'); } catch (e) { return; }
  const coinId = SYMBOL_TO_COINGECKO[params.asset];
  if (!coinId || params.chartType !== 'line') {
    el.outerHTML = unsupportedWidgetHtml();
    return;
  }
  const days = daysForChartParams(params);
  const endDate = params.date !== 'now' ? params.date : null;
  const accent = coinAccent(coinId);
  const live = params.date === 'now';
  const height = CHART_HEIGHT_INLINE;

  try {
    const points = await fetchCoinChart(coinId, Math.max(days, 30), endDate);
    // Drop if node was removed (modal closed / content replaced)
    if (!el.isConnected) return;
    let currentPrice = null;
    if (live) {
      const m = marqueePrices.find((c) => c.id === coinId);
      if (m && m.price != null) currentPrice = m.price;
      else if (points.length) currentPrice = points[points.length - 1].c;
    }
    // Ensure host structure for paint + optional tip
    el.innerHTML = `<div class="nb-chart__canvas"></div><div class="mm__tooltip nb-chart__tip hidden"></div>`;
    const canvas = el.querySelector('.nb-chart__canvas');
    const tip = el.querySelector('.nb-chart__tip');
    // Wait a frame so clientWidth is correct after skeleton → canvas swap
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      paintPriceChart(canvas, tip, {
        points,
        days,
        currentPrice: live ? currentPrice : null,
        accent,
        height,
        pad: CHART_PAD_INLINE,
        scrub: null,
        uid: 'nb-' + (el.dataset.uid || Math.random().toString(36).slice(2, 8)),
        playEntrance: true,
        withSlide: false, // inline charts: no slide (app withSlide: !inline)
        liveDot: live,
      });
    });
  } catch (e) {
    if (!el.isConnected) return;
    el.innerHTML = `<div class="pc__fallback">${I18N.t('widget.chartError')}</div>`;
  }
}

async function mountInlinePrice(el) {
  if (!el || el.dataset.mounted === '1') return;
  el.dataset.mounted = '1';
  let params;
  try { params = JSON.parse(el.getAttribute('data-nb-price') || '{}'); } catch (e) { return; }
  const coinId = SYMBOL_TO_COINGECKO[params.asset];
  if (!coinId) {
    el.innerHTML = `<div class="nb-price__card"><span class="nb-price__unknown">${I18N.t('widget.unknownAsset')}: ${escapeHtml(params.asset)}</span></div>`;
    return;
  }
  const live = params.date === 'now';
  let price = null;
  let chg = null;
  try {
    if (live) {
      const m = marqueePrices.find((c) => c.id === coinId);
      if (m && m.price != null) {
        price = m.price;
        chg = m.chg;
      } else {
        const res = await fetch(
          `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coinId}&price_change_percentage=24h`,
        );
        if (res.ok) {
          const rows = await res.json();
          if (rows[0]) {
            price = rows[0].current_price;
            chg = rows[0].price_change_percentage_24h;
          }
        }
      }
    } else {
      // Frozen: CoinGecko history endpoint expects dd-mm-yyyy
      const [y, mo, d] = params.date.split('-');
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/${coinId}/history?date=${d}-${mo}-${y}&localization=false`,
      );
      if (res.ok) {
        const json = await res.json();
        price = json?.market_data?.current_price?.usd ?? null;
      }
    }
  } catch (e) { /* leave price null */ }
  if (!el.isConnected) return;
  const icon = `./assets/crypto/${params.asset}.webp`;
  const chgHtml = (live && chg != null)
    ? `<span class="nb-price__chg ${chg >= 0 ? 'up' : 'down'}">${formatChg(chg)}</span>`
    : '';
  el.innerHTML =
    `<div class="nb-price__card">` +
      `<img class="nb-price__icon" src="${icon}" alt="" onerror="this.style.visibility='hidden'"/>` +
      `<div class="nb-price__info">` +
        `<div class="nb-price__sym">${escapeHtml(params.asset)}</div>` +
        `<div class="nb-price__row">` +
          `<span class="nb-price__val">${formatUsd(price)}</span>${chgHtml}` +
        `</div>` +
      `</div>` +
    `</div>`;
}

function hydrateWidgets(root) {
  if (!root) return;
  root.querySelectorAll('[data-nb-chart]').forEach((el) => { mountInlineChart(el); });
  root.querySelectorAll('[data-nb-price]').forEach((el) => { mountInlinePrice(el); });
}

// ── Market widget (Fear & Greed + MVRV) ───────────────────────────────
// Mirrors FearGreedWidget.tsx + gaugeConstants.ts from the app (source of truth).
// Equal visual zone weights, non-linear marker mapping, progressive arc fill,
// theme-aware black/white marker.
const GAUGE = {
  size: 32,
  stroke: 4,
  radius: 14, // (32 - 4) / 2
  circ: 2 * Math.PI * 14,
  arcFrac: 0.75,
  arcLen: 2 * Math.PI * 14 * 0.75,
  rotation: 135,
  gap: 5,
  dimOpacity: 0.28,
};

/** Mid-range tones from fngConstants INDICATOR_COLORS; extremes use theme success/error. */
const INDICATOR_MID = { fear: '#F7931A', neutral: '#B0B0B0', greed: '#93C47D' };

function indicatorColors() {
  // --error / --success are fixed hexes in both themes (same as app colors.error/success)
  const err = '#EF4444';
  const ok = '#22C55E';
  return {
    fearGreed: {
      extremeFear: err, fear: INDICATOR_MID.fear, neutral: INDICATOR_MID.neutral,
      greed: INDICATOR_MID.greed, extremeGreed: ok,
    },
    mvrv: {
      extremeUndervalued: ok, undervalued: INDICATOR_MID.greed, fairValue: INDICATOR_MID.neutral,
      overvalued: INDICATOR_MID.fear, extremeOvervalued: err,
    },
  };
}

// Zone boundaries mirror getFearGreedColor / getMVRVColor. Every zone gets equal visual
// weight so the arc reads symmetric; valueToVisual moves the marker non-linearly within
// each zone (wide value range over a fixed arc = slower marker, and vice-versa).
function fearGreedZones(c) {
  return [
    { start: 0, end: 25, key: 'extremeFear', color: c.extremeFear, weight: 1 },
    { start: 25, end: 45, key: 'fear', color: c.fear, weight: 1 },
    { start: 45, end: 55, key: 'neutral', color: c.neutral, weight: 1 },
    { start: 55, end: 75, key: 'greed', color: c.greed, weight: 1 },
    { start: 75, end: 100, key: 'extremeGreed', color: c.extremeGreed, weight: 1 },
  ];
}
function mvrvZones(c) {
  // MVRV thresholds 1.0 / 1.5 / 2.4 / 3.5 on a 0–5 scale, normalized (÷5·100).
  return [
    { start: 0, end: 20, key: 'extremeUndervalued', color: c.extremeUndervalued, weight: 1 },
    { start: 20, end: 30, key: 'undervalued', color: c.undervalued, weight: 1 },
    { start: 30, end: 48, key: 'fairValue', color: c.fairValue, weight: 1 },
    { start: 48, end: 70, key: 'overvalued', color: c.overvalued, weight: 1 },
    { start: 70, end: 100, key: 'extremeOvervalued', color: c.extremeOvervalued, weight: 1 },
  ];
}

/** Distribute zones along the arc by visual weight (defaults to value range). */
function layoutZones(zones) {
  const total = zones.reduce((sum, z) => sum + (z.weight ?? z.end - z.start), 0);
  let acc = 0;
  return zones.map((z) => {
    const vStart = (acc / total) * 100;
    acc += z.weight ?? z.end - z.start;
    return { ...z, vStart, vEnd: (acc / total) * 100 };
  });
}

/** Map a value-space position (0–100) to its visual arc position (0–100). */
function valueToVisual(value, laid) {
  for (const z of laid) {
    if (value <= z.end) {
      const frac = z.end === z.start ? 0 : (value - z.start) / (z.end - z.start);
      return z.vStart + Math.min(1, Math.max(0, frac)) * (z.vEnd - z.vStart);
    }
  }
  return 100;
}

function fngClassification(value) {
  if (value <= 25) return 'extremeFear';
  if (value <= 45) return 'fear';
  if (value <= 55) return 'neutral';
  if (value <= 75) return 'greed';
  return 'extremeGreed';
}
function mvrvClassification(value) {
  // App uses strict < (useMVRV getClassificationKey)
  if (value < 1.0) return 'extremeUndervalued';
  if (value < 1.5) return 'undervalued';
  if (value < 2.4) return 'fairValue';
  if (value < 3.5) return 'overvalued';
  return 'extremeOvervalued';
}
function mvrvProgress(value) {
  return Math.max(0, Math.min(100, (value / 5) * 100));
}

function buildGauge(zones, progress /* 0–100 in value space */) {
  const { size, stroke, radius, circ, arcLen, rotation, gap, dimOpacity } = GAUGE;
  const center = size / 2;
  const laid = layoutZones(zones);
  const markerVisual = valueToVisual(progress, laid);
  const markerT = markerVisual / 100;

  let segs = '';
  for (let i = 0; i < laid.length; i++) {
    const zone = laid[i];
    // Inset only internal boundaries so the arc's outer tips stay put.
    const startInset = i === 0 ? 0 : gap / 2;
    const endInset = i === laid.length - 1 ? 0 : gap / 2;
    const startDist = (zone.vStart / 100) * arcLen + startInset;
    const segLength = Math.max(0.1, ((zone.vEnd - zone.vStart) / 100) * arcLen - startInset - endInset);
    // Progressive fill: zones the marker has reached stay full opacity.
    const opacity = zone.vStart < markerVisual ? 1 : dimOpacity;
    segs += `<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${zone.color}"` +
      ` stroke-width="${stroke}" stroke-linecap="round"` +
      ` stroke-dasharray="${segLength.toFixed(2)} ${circ.toFixed(2)}"` +
      ` stroke-dashoffset="${(-startDist).toFixed(2)}" stroke-opacity="${opacity}"/>`;
  }

  const theta = ((rotation + markerT * 270) * Math.PI) / 180;
  const mx = center + radius * Math.cos(theta);
  const my = center + radius * Math.sin(theta);
  // App: white marker on dark theme, black on light (not zone-colored).
  const markerFill = isDark() ? '#FFFFFF' : '#000000';
  const marker = `<circle class="gauge-marker" cx="${mx.toFixed(2)}" cy="${my.toFixed(2)}"` +
    ` r="${stroke / 2 + 1}" fill="${markerFill}" stroke-width="1.5"/>`;

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<g transform="rotate(${rotation} ${center} ${center})">${segs}</g>${marker}</svg>`;
}

function sectionHtml(titleKey, labelPrefix, value, valueText, zones, progress, colorForValue) {
  if (value == null) {
    return `<div class="market__section"><div class="market__title">${I18N.t(titleKey)}</div>
      <div class="market__value" style="color:var(--text-tertiary)">—</div>
      <div class="market__label" style="color:var(--text-tertiary)">${I18N.t('market.unavailable')}</div></div>`;
  }
  const color = colorForValue(value);
  const key = labelPrefix === 'fng' ? fngClassification(value) : mvrvClassification(value);
  const label = I18N.t(labelPrefix + '.' + key);
  return `<div class="market__section"><div class="market__title">${I18N.t(titleKey)}</div>
    <div class="gauge-row">${buildGauge(zones, progress)}<span class="market__value" style="color:${color}">${valueText}</span></div>
    <div class="market__label" style="color:${color}">${label}</div></div>`;
}

const MARKET_INFO_ICON =
  `<span class="market__info" aria-hidden="true">` +
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  `<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg></span>`;

function renderMarket() {
  const fng = marketData.fng;
  const mvrv = marketData.mvrv;
  const colors = indicatorColors();
  const fngZ = fearGreedZones(colors.fearGreed);
  const mvrvZ = mvrvZones(colors.mvrv);
  const fngColor = (v) => colors.fearGreed[fngClassification(v)];
  const mvrvColor = (v) => colors.mvrv[mvrvClassification(v)];

  const el = $('market');
  el.setAttribute('aria-label', I18N.t('market.infoAria'));
  el.innerHTML =
    MARKET_INFO_ICON +
    `<div class="market__sections">` +
    sectionHtml('market.fearGreed', 'fng', fng, fng == null ? '' : String(fng), fngZ, fng ?? 0, fngColor) +
    `<div class="market__divider"></div>` +
    sectionHtml('market.mvrv', 'mvrv', mvrv, mvrv == null ? '' : mvrv.toFixed(2), mvrvZ, mvrv == null ? 0 : mvrvProgress(mvrv), mvrvColor) +
    `</div>`;

  // Keep the open info modal in sync with theme / language / fresh data.
  if (!$('indicator-modal').classList.contains('hidden')) renderIndicatorModalContent();
}

async function loadMarket() {
  renderMarket();
  fetch(`${CONFIG.workerBase}/web/fng`).then((r) => r.json())
    .then((d) => {
      if (typeof d.value === 'number') {
        marketData.fng = d.value;
        marketData.fngAt = Date.now();
        renderMarket();
      }
    }).catch(() => {});
  fetch(`${CONFIG.workerBase}/web/mvrv`).then((r) => r.json())
    .then((d) => {
      if (typeof d.value === 'number') {
        marketData.mvrv = d.value;
        marketData.mvrvAt = Date.now();
        renderMarket();
      }
    }).catch(() => {});
}

// ── Indicator info modal (parity with app/indicator-info.tsx) ─────────
function formatIndicatorTimestamp(ms) {
  if (!ms) return I18N.t('indicatorModal.unavailable');
  const d = new Date(ms);
  const locale = I18N.lang === 'en' ? 'en-US' : 'pt-BR';
  // App: "d MMM, HH:mm" with title-cased month (e.g. "8 Ago, 14:30")
  const datePart = d.toLocaleDateString(locale, { day: 'numeric', month: 'short' });
  const timePart = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
  const titled = datePart.replace(/\b\w/g, (c) => c.toUpperCase());
  return `${titled}, ${timePart}`;
}

function indicatorSourceLine(ms, source) {
  return `${I18N.t('indicatorModal.dataSource')} ${formatIndicatorTimestamp(ms)} (${source})`;
}

function rangeRows(prefix, colorMap, keys) {
  return keys.map((key) => {
    const color = colorMap[key];
    const label = I18N.t(`indicatorModal.${prefix}.${key}`);
    return `<div class="imodal__range">` +
      `<span class="imodal__dot" style="background:${color}"></span>` +
      `<span class="imodal__range-label">${label}</span></div>`;
  }).join('');
}

function renderIndicatorModalContent() {
  const colors = indicatorColors();
  const fngKeys = ['extremeFear', 'fear', 'neutral', 'greed', 'extremeGreed'];
  const mvrvKeys = ['extremeUndervalued', 'undervalued', 'fairValue', 'overvalued', 'extremeOvervalued'];

  $('indicator-modal-title').textContent = I18N.t('indicatorModal.title');
  $('indicator-modal-close').setAttribute('aria-label', I18N.t('indicatorModal.close'));

  $('indicator-modal-content').innerHTML =
    `<section class="imodal__section">` +
      `<h3 class="imodal__section-title">${I18N.t('indicatorModal.fng.title')}</h3>` +
      `<p class="imodal__source">${indicatorSourceLine(marketData.fngAt, 'Alternative.me')}</p>` +
      `<p class="imodal__desc">${I18N.t('indicatorModal.fng.description')}</p>` +
      `<div class="imodal__ranges">${rangeRows('fng', colors.fearGreed, fngKeys)}</div>` +
    `</section>` +
    `<div class="imodal__divider"></div>` +
    `<section class="imodal__section">` +
      `<h3 class="imodal__section-title">${I18N.t('indicatorModal.mvrv.title')}</h3>` +
      `<p class="imodal__source">${indicatorSourceLine(marketData.mvrvAt, 'CoinMetrics')}</p>` +
      `<p class="imodal__desc">${I18N.t('indicatorModal.mvrv.description')}</p>` +
      `<div class="imodal__ranges">${rangeRows('mvrv', colors.mvrv, mvrvKeys)}</div>` +
    `</section>` +
    `<p class="imodal__disclaimer">${I18N.t('indicatorModal.disclaimer')}</p>`;
}

function openIndicatorModal() {
  renderIndicatorModalContent();
  openOverlay($('indicator-modal'));
  // Focus close for a11y; Escape handled globally below.
  try { $('indicator-modal-close').focus({ preventScroll: true }); } catch (e) {}
}

function closeIndicatorModal() {
  const root = $('indicator-modal');
  if (root.classList.contains('hidden') || root.classList.contains('is-closing')) return;
  animateOverlayClose(root, '.imodal__panel', () => {
    unlockBodyScrollIfIdle();
  });
}

// ── Notion colors ─────────────────────────────────────────────────────
//
// Mirrors NOTION_TEXT_COLORS in the app (src/theme/notionColors.ts). Every Notion color
// has a light AND a dark value: the dark ones are deliberately brighter so they read on
// black, which makes them washed out and low-contrast on a white background. This map
// used to hold only the dark set, so light mode rendered coloured text, highlights and
// the selected tag pill in dark-mode hexes.
//
// `default` is the accent (not the app's text default) because the only thing that asks
// for it is the "all" tag pill — rich text skips colour === 'default' entirely.
const NOTION_COLORS = {
  default: { light: '#F15B24', dark: '#F15B24' },
  gray: { light: '#787774', dark: '#9B9B9B' },
  brown: { light: '#9F6B53', dark: '#BA856F' },
  orange: { light: '#D9730D', dark: '#FFA344' },
  yellow: { light: '#CB912F', dark: '#FFDC49' },
  green: { light: '#448361', dark: '#6DB87E' },
  blue: { light: '#337EA9', dark: '#529CCA' },
  purple: { light: '#9065B0', dark: '#A475C2' },
  pink: { light: '#C14C8A', dark: '#E255A1' },
  red: { light: '#D44C47', dark: '#FF7369' },
};

// Solid backgrounds for highlighted text AND callouts — NOTION_BACKGROUND_COLORS in the
// app. These are their own colours, NOT a translucent wash of the text colour: green on
// light is #EDF3EC, which no opacity of #448361 reproduces.
const NOTION_BG_COLORS = {
  gray: { light: '#F1F1EF', dark: '#454B4E' },
  brown: { light: '#F4EEEE', dark: '#4D3D3A' },
  orange: { light: '#FBECDD', dark: '#5C3C1E' },
  yellow: { light: '#FBF3DB', dark: '#564328' },
  green: { light: '#EDF3EC', dark: '#364A3F' },
  blue: { light: '#E7F3F8', dark: '#264653' },
  purple: { light: '#F4F0F7', dark: '#443D56' },
  pink: { light: '#F9F0F3', dark: '#533245' },
  red: { light: '#FDEBEB', dark: '#593938' },
  default: { light: '#F7F6F3', dark: '#2F2F2F' }, // callout with no colour
};

// Callout TEXT — NOTION_CALLOUT_COLORS in the app. Mostly the text palette, but `default`
// and `brown` (dark) have their own values.
const NOTION_CALLOUT_TEXT = {
  default: { light: '#37352F', dark: '#FFFFFF' },
  gray: { light: '#787774', dark: '#9B9B9B' },
  brown: { light: '#64473A', dark: '#D4B9A9' },
  orange: { light: '#D9730D', dark: '#FFA344' },
  yellow: { light: '#CB912F', dark: '#FFDC49' },
  green: { light: '#448361', dark: '#6DB87E' },
  blue: { light: '#337EA9', dark: '#529CCA' },
  purple: { light: '#9065B0', dark: '#A475C2' },
  pink: { light: '#C14C8A', dark: '#E255A1' },
  red: { light: '#D44C47', dark: '#FF7369' },
};

// Tag pills use a DIFFERENT brown from body text — the app's NOTION_SELECTED_COLORS says
// #64473A where NOTION_TEXT_COLORS says #9F6B53. Brown is the only colour that disagrees.
const NOTION_PILL_OVERRIDES = { brown: { light: '#64473A', dark: '#BA856F' } };

const isDark = () => document.documentElement.getAttribute('data-theme') !== 'light';

const themed = (pair) => (isDark() ? pair.dark : pair.light);

/** Notion colour name → text hex for the CURRENT theme. */
function notionHex(color) {
  return themed(NOTION_COLORS[color] || NOTION_COLORS.default);
}
/** Notion colour name → tag-pill hex for the CURRENT theme. */
function pillHex(color) {
  return themed(NOTION_PILL_OVERRIDES[color] || NOTION_COLORS[color] || NOTION_COLORS.default);
}
/** Notion colour name (bare, no "_background") → solid background for the CURRENT theme. */
function notionBgHex(color) {
  return themed(NOTION_BG_COLORS[color] || NOTION_BG_COLORS.default);
}
/** Notion callout colour ("gray_background" | "default") → { bg, text } for the CURRENT theme. */
function calloutColors(color) {
  const key = (color || 'default').replace('_background', '');
  return {
    bg: notionBgHex(key),
    text: themed(NOTION_CALLOUT_TEXT[key] || NOTION_CALLOUT_TEXT.default),
  };
}
// Category tag labels hardcoded per language (keyed by the PT Notion value, like the app's feed.json).
const TAG_LABELS = {
  'Notícias': { pt: 'Notícias', en: 'News' },
  'Análises': { pt: 'Análises', en: 'Analysis' },
  'Trade': { pt: 'Trade', en: 'Trade' },
  'Bitcoin': { pt: 'Bitcoin', en: 'Bitcoin' },
  'Altcoins': { pt: 'Altcoins', en: 'Altcoins' },
  'Stablecoins': { pt: 'Stablecoins', en: 'Stablecoins' },
  'Educação': { pt: 'Educação', en: 'Education' },
  'DeFi': { pt: 'DeFi', en: 'DeFi' },
  'NFT': { pt: 'NFT', en: 'NFT' },
};
function tagLabel(name) { const m = TAG_LABELS[name]; return m ? m[I18N.lang] || m.pt : name; }
// Sidebar nav icons.
// Idle = solid light-gray; selected = solid orange (CSS .sidebar__item.active color).
// Feed: app icon font (cryptobros-icons.ttf) — always filled glyph.
// Glossário: Flowbite Icons `book` (same as app MaisScreen SectionItem flowbiteIcon="book").
// Rest: Ionicons solid (ionicons@7.4.0, viewBox 512).
const FEED_ICON = '<i class="cbi cbi--btc" aria-hidden="true"></i>';
const LESSONS_ICON =
  '<svg class="ion ion--book" viewBox="0 0 512 512" aria-hidden="true">' +
  '<path fill="currentColor" d="M202.24 74C166.11 56.75 115.61 48.3 48 48a31.36 31.36 0 0 0-17.92 5.33A32 32 0 0 0 16 79.9V366c0 19.34 13.76 33.93 32 33.93 71.07 0 142.36 6.64 185.06 47a4.11 4.11 0 0 0 6.94-3V106.82a15.89 15.89 0 0 0-5.46-12A143 143 0 0 0 202.24 74zM481.92 53.3A31.33 31.33 0 0 0 464 48c-67.61.3-118.11 8.71-154.24 26a143.31 143.31 0 0 0-32.31 20.78 15.93 15.93 0 0 0-5.45 12v337.13a3.93 3.93 0 0 0 6.68 2.81c25.67-25.5 70.4-46.81 185.36-46.81a32 32 0 0 0 32-32v-288a32 32 0 0 0-14.12-26.61z"/>' +
  '</svg>';
// Flowbite Icons MIT — path from app src/components/ui/FlowbiteIcon.tsx (`book`).
const GLOSSARY_ICON =
  '<svg class="fb fb--book" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M6 2a2 2 0 0 0-2 2v15a3 3 0 0 0 3 3h12a1 1 0 1 0 0-2h-2v-2h2a1 1 0 0 0 1-1V4a2 2 0 0 0-2-2h-8v16h5v2H7a1 1 0 1 1 0-2h1V2H6Z"/>' +
  '</svg>';
// Ionicons trending-up (outline path — Ionicons has no separate solid for this glyph).
const DCA_ICON =
  '<svg class="ion ion--trending" viewBox="0 0 512 512" aria-hidden="true">' +
  '<path fill="none" stroke="currentColor" stroke-width="40" stroke-linecap="round" stroke-linejoin="round" d="M352 144h112v112"/>' +
  '<path fill="none" stroke="currentColor" stroke-width="40" stroke-linecap="round" stroke-linejoin="round" d="M48 368l121.37-121.37a32 32 0 0145.26 0l50.74 50.74a32 32 0 0045.26 0L448 160"/>' +
  '</svg>';
// Ionicons calculator (solid).
const POS_ICON =
  '<svg class="ion ion--calculator" viewBox="0 0 512 512" aria-hidden="true">' +
  '<path fill="currentColor" d="M416 80a48.05 48.05 0 00-48-48H144a48.05 48.05 0 00-48 48v352a48.05 48.05 0 0048 48h224a48.05 48.05 0 0048-48zM168 432a24 24 0 1124-24 24 24 0 01-24 24zm0-80a24 24 0 1124-24 24 24 0 01-24 24zm0-80a24 24 0 1124-24 24 24 0 01-24 24zm88 160a24 24 0 1124-24 24 24 0 01-24 24zm0-80a24 24 0 1124-24 24 24 0 01-24 24zm0-80a24 24 0 1124-24 24 24 0 01-24 24zm112 136a24 24 0 01-48 0v-80a24 24 0 0148 0zm-24-136a24 24 0 1124-24 24 24 0 01-24 24zm19.31-100.69A16 16 0 01352 176H160a16 16 0 01-16-16V96a16 16 0 0116-16h192a16 16 0 0116 16v64a16 16 0 01-4.69 11.31z"/>' +
  '</svg>';

// ── Ticker SVGs (assets/tickers/{SYM}.svg) ────────────────────────────
// Imported brand marks for coins/stocks. Reuse via tickerUrl / tickerIcon
// anywhere (filter pills, marquee, menu, widgets…).
const TICKER_BASE = './assets/tickers/';
/** Filenames that are not ALLCAPS (composite / special marks). */
const TICKER_FILE_OVERRIDES = {
  Altcoins: 'Altcoins',
  altcoins: 'Altcoins',
};
/**
 * Stablecoins share the USDT mark (assets/tickers/USDT.svg).
 * Includes both tickers (USDC, DAI…) and category labels (Stablecoins).
 */
const STABLECOIN_SYMS = new Set([
  'USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDD', 'FDUSD', 'USDE',
  'PYUSD', 'FRAX', 'GUSD', 'LUSD', 'SUSD', 'USD', 'USDP', 'EURC',
  'RLUSD', 'USDS', 'USDY', 'EURT',
]);

function isStablecoinRef(sym) {
  if (!sym) return false;
  const key = String(sym);
  const up = key.toUpperCase();
  if (STABLECOIN_SYMS.has(up)) return true;
  // Category filter names from Notion: "Stablecoins", "Stablecoin", "Stable".
  if (/^stables?(coins?)?$/i.test(key.trim())) return true;
  return false;
}

/** Canonical filename for a ticker symbol (e.g. USDC → USDT, Altcoins → Altcoins). */
function tickerFile(sym) {
  if (!sym) return null;
  const key = String(sym);
  if (TICKER_FILE_OVERRIDES[key]) return TICKER_FILE_OVERRIDES[key];
  if (isStablecoinRef(key)) return 'USDT';
  return key.toUpperCase();
}

/** Resolve `BTC` → `./assets/tickers/BTC.svg` (stablecoins → USDT, Altcoins special-case). */
function tickerUrl(sym) {
  const file = tickerFile(sym);
  if (!file) return null;
  return `${TICKER_BASE}${encodeURIComponent(file)}.svg`;
}

/**
 * <img> for a ticker mark. Safe to call from any UI surface.
 * @param {string} sym - ticker id matching the SVG filename (e.g. 'BTC', 'Altcoins')
 * @param {{ className?: string, size?: number, alt?: string }} [opts]
 */
function tickerIcon(sym, opts) {
  const url = tickerUrl(sym);
  if (!url) return '';
  const cls = (opts && opts.className) || 'ticker-icon';
  const size = (opts && opts.size) || 16;
  const alt = (opts && opts.alt != null) ? opts.alt : '';
  return `<img class="${cls}" src="${url}" alt="${escapeHtml(alt)}" width="${size}" height="${size}" decoding="async" loading="lazy"/>`;
}

/** Legacy webp marks (marquee / menu still use these). Prefer tickerIcon for new UI. */
function coinIcon(sym, opts) {
  const url = `./assets/crypto/${encodeURIComponent(sym)}.webp`;
  if (opts && opts.tint) {
    return `<span class="tag-pill__coin tag-pill__coin--tint" style="--coin:url('${url}')" aria-hidden="true"></span>`;
  }
  return `<img class="tag-pill__coin" src="${url}" alt="" width="16" height="16" decoding="async"/>`;
}

// Solid Ionicons (fill currentColor) — painted with the category colour on pills.
const ionSolid = (paths) =>
  `<svg viewBox="0 0 512 512" aria-hidden="true" fill="currentColor">${paths}</svg>`;

const ION = {
  // apps
  apps: ionSolid(
    '<path d="M104 160a56 56 0 1156-56 56.06 56.06 0 01-56 56zM256 160a56 56 0 1156-56 56.06 56.06 0 01-56 56zM408 160a56 56 0 1156-56 56.06 56.06 0 01-56 56zM104 312a56 56 0 1156-56 56.06 56.06 0 01-56 56zM256 312a56 56 0 1156-56 56.06 56.06 0 01-56 56zM408 312a56 56 0 1156-56 56.06 56.06 0 01-56 56zM104 464a56 56 0 1156-56 56.06 56.06 0 01-56 56zM256 464a56 56 0 1156-56 56.06 56.06 0 01-56 56zM408 464a56 56 0 1156-56 56.06 56.06 0 01-56 56z"/>'
  ),
  // newspaper
  newspaper: ionSolid(
    '<path d="M439.91 112h-23.82a.09.09 0 00-.09.09V416a32 32 0 0032 32 32 32 0 0032-32V152.09A40.09 40.09 0 00439.91 112z"/>' +
    '<path d="M384 416V72a40 40 0 00-40-40H72a40 40 0 00-40 40v352a56 56 0 0056 56h342.85a1.14 1.14 0 001.15-1.15 1.14 1.14 0 00-.85-1.1A64.11 64.11 0 01384 416zM96 128a16 16 0 0116-16h64a16 16 0 0116 16v64a16 16 0 01-16 16h-64a16 16 0 01-16-16zm208 272H112.45c-8.61 0-16-6.62-16.43-15.23A16 16 0 01112 368h191.55c8.61 0 16 6.62 16.43 15.23A16 16 0 01304 400zm0-64H112.45c-8.61 0-16-6.62-16.43-15.23A16 16 0 01112 304h191.55c8.61 0 16 6.62 16.43 15.23A16 16 0 01304 336zm0-64H112.45c-8.61 0-16-6.62-16.43-15.23A16 16 0 01112 240h191.55c8.61 0 16 6.62 16.43 15.23A16 16 0 01304 272zm0-64h-63.55c-8.61 0-16-6.62-16.43-15.23A16 16 0 01240 176h63.55c8.61 0 16 6.62 16.43 15.23A16 16 0 01304 208zm0-64h-63.55c-8.61 0-16-6.62-16.43-15.23A16 16 0 01240 112h63.55c8.61 0 16 6.62 16.43 15.23A16 16 0 01304 144z"/>'
  ),
  // stats-chart
  statsChart: ionSolid(
    '<path d="M104 496H72a24 24 0 01-24-24V328a24 24 0 0124-24h32a24 24 0 0124 24v144a24 24 0 01-24 24zM328 496h-32a24 24 0 01-24-24V232a24 24 0 0124-24h32a24 24 0 0124 24v240a24 24 0 01-24 24zM440 496h-32a24 24 0 01-24-24V120a24 24 0 0124-24h32a24 24 0 0124 24v352a24 24 0 01-24 24zM216 496h-32a24 24 0 01-24-24V40a24 24 0 0124-24h32a24 24 0 0124 24v432a24 24 0 01-24 24z"/>'
  ),
  // pulse — market activity stand-in for Trade (trending-up has no solid glyph)
  pulse: ionSolid(
    '<path d="M432 272a48.09 48.09 0 00-45.25 32h-39.22l-28.35-85.06a16 16 0 00-30.56.66l-44.51 155.76-52.33-314a16 16 0 00-31.3-1.25L99.51 304H48a16 16 0 000 32h64a16 16 0 0015.52-12.12l45.34-181.37 51.36 308.12A16 16 0 00239.1 464h.91a16 16 0 0015.37-11.6l49.8-174.28 15.64 46.94A16 16 0 00336 336h50.75A48 48 0 10432 272z"/>'
  ),
  // school
  school: ionSolid(
    '<path d="M256 368a16 16 0 01-7.94-2.11L108 285.84a8 8 0 00-12 6.94V368a16 16 0 008.23 14l144 80a16 16 0 0015.54 0l144-80a16 16 0 008.23-14v-75.22a8 8 0 00-12-6.94l-140.06 80.05A16 16 0 01256 368z"/>' +
    '<path d="M495.92 190.5v-.11a16 16 0 00-8-12.28l-224-128a16 16 0 00-15.88 0l-224 128a16 16 0 000 27.78l224 128a16 16 0 0015.88 0L461 221.28a2 2 0 013 1.74v144.53c0 8.61 6.62 16 15.23 16.43A16 16 0 00496 368V192a14.76 14.76 0 00-.08-1.5z"/>'
  ),
  // images
  images: ionSolid(
    '<path d="M450.29 112H142c-34 0-62 27.51-62 61.33v245.34c0 33.82 28 61.33 62 61.33h308c34 0 62-26.18 62-60V173.33c0-33.82-27.68-61.33-61.71-61.33zm-77.15 61.34a46 46 0 11-46.28 46 46.19 46.19 0 0146.28-46.01zm-231.55 276c-17 0-29.86-13.75-29.86-30.66v-64.83l90.46-80.79a46.54 46.54 0 0163.44 1.83L328.27 337l-113 112.33zM480 418.67a30.67 30.67 0 01-30.71 30.66H259L376.08 333a46.24 46.24 0 0159.44-.16L480 370.59z"/>' +
    '<path d="M384 32H64A64 64 0 000 96v256a64.11 64.11 0 0048 62V152a72 72 0 0172-72h326a64.11 64.11 0 00-62-48z"/>'
  ),
  // layers — category glyph for DeFi (never a coin logo)
  layers: ionSolid(
    '<path d="M256 256c-13.47 0-26.94-2.39-37.44-7.17l-148-67.49C63.79 178.26 48 169.25 48 152.24s15.79-26 22.58-29.12l149.28-68.07c20.57-9.4 51.61-9.4 72.19 0l149.37 68.07c6.79 3.09 22.58 12.1 22.58 29.12s-15.79 26-22.58 29.11l-148 67.48C282.94 253.61 269.47 256 256 256zm176.76-100.86z"/>' +
    '<path d="M441.36 226.81L426.27 220l-38.77 17.74-94 43c-10.5 4.8-24 7.19-37.44 7.19s-26.93-2.39-37.42-7.19l-94.07-43L85.79 220l-15.22 6.84C63.79 229.93 48 239 48 256s15.79 26.08 22.56 29.17l148 67.63C229 357.6 242.49 360 256 360s26.94-2.4 37.44-7.19l147.87-67.61c6.81-3.09 22.69-12.11 22.69-29.2s-15.77-26.07-22.64-29.19z"/>' +
    '<path d="M441.36 330.8l-15.09-6.8-38.77 17.73-94 42.95c-10.5 4.78-24 7.18-37.44 7.18s-26.93-2.39-37.42-7.18l-94.07-43L85.79 324l-15.22 6.84C63.79 333.93 48 343 48 360s15.79 26.07 22.56 29.15l148 67.59C229 461.52 242.54 464 256 464s26.88-2.48 37.38-7.27l147.92-67.57c6.82-3.08 22.7-12.1 22.7-29.16s-15.77-26.07-22.64-29.2z"/>'
  ),
  // pricetag
  pricetag: ionSolid(
    '<path d="M467 45.2A44.45 44.45 0 00435.29 32H312.36a30.63 30.63 0 00-21.52 8.89L45.09 286.59a44.82 44.82 0 000 63.32l117 117a44.83 44.83 0 0063.34 0l245.65-245.6A30.6 30.6 0 00480 199.8v-123a44.24 44.24 0 00-13-31.6zM384 160a32 32 0 1132-32 32 32 0 01-32 32z"/>'
  ),
};

/**
 * Filter-pill icon spec.
 * - ticker: brand SVG from assets/tickers
 * - glyph: solid Ionicons, painted with the Notion category colour
 *
 * Coin-named tags (BTC/ETH/SOL/…) and stablecoins are resolved in tagIconSpec()
 * so a Notion tag like "ETH" or "USDT" picks up the right mark automatically.
 */
const TAG_ICON_SPEC = {
  all: { type: 'glyph', svg: ION.apps },
  'Notícias': { type: 'glyph', svg: ION.newspaper },
  'Análises': { type: 'glyph', svg: ION.statsChart },
  'Trade': { type: 'glyph', svg: ION.pulse },
  'Bitcoin': { type: 'ticker', sym: 'BTC' },
  'BTC': { type: 'ticker', sym: 'BTC' },
  'Ethereum': { type: 'ticker', sym: 'ETH' },
  'ETH': { type: 'ticker', sym: 'ETH' },
  'Solana': { type: 'ticker', sym: 'SOL' },
  'SOL': { type: 'ticker', sym: 'SOL' },
  'XRP': { type: 'ticker', sym: 'XRP' },
  'Litecoin': { type: 'ticker', sym: 'LTC' },
  'LTC': { type: 'ticker', sym: 'LTC' },
  'Altcoins': { type: 'ticker', sym: 'Altcoins' },
  // Category filter "Stablecoins" (and aliases) → USDT brand mark.
  'Stablecoins': { type: 'ticker', sym: 'USDT' },
  'Stablecoin': { type: 'ticker', sym: 'USDT' },
  'Stable': { type: 'ticker', sym: 'USDT' },
  'USDT': { type: 'ticker', sym: 'USDT' },
  'USDC': { type: 'ticker', sym: 'USDT' },
  'DAI': { type: 'ticker', sym: 'USDT' },
  'Educação': { type: 'glyph', svg: ION.school },
  // DeFi is a category — never a coin logo.
  'DeFi': { type: 'glyph', svg: ION.layers },
  'NFT': { type: 'glyph', svg: ION.images },
  _default: { type: 'glyph', svg: ION.pricetag },
};

/** Tags that must stay as category glyphs even if they look like a ticker symbol. */
const TAG_GLYPH_ONLY = new Set(['DeFi', 'NFT', 'Trade', 'Notícias', 'Análises', 'Educação']);

function tagIconSpec(name) {
  if (TAG_ICON_SPEC[name]) return TAG_ICON_SPEC[name];
  // Stablecoins category + USDT/USDC/DAI/… → assets/tickers/USDT.svg
  if (isStablecoinRef(name)) {
    return { type: 'ticker', sym: 'USDT' };
  }
  // Unknown uppercase ticker-like tag → try assets/tickers/{SYM}.svg
  // e.g. "ETH", "SOL", "XRP", "LTC", "BNB" when they appear as Notion filters.
  if (!TAG_GLYPH_ONLY.has(name)) {
    const up = String(name).toUpperCase();
    if (/^[A-Z0-9]{2,10}$/.test(up) && !TICKER_FILE_OVERRIDES[name]) {
      return { type: 'ticker', sym: up };
    }
  }
  return TAG_ICON_SPEC._default;
}

/** HTML for a filter-pill leading icon. Glyphs get `colorHex` so they keep category colour when unselected. */
function tagIconHtml(name, colorHex) {
  const spec = tagIconSpec(name);
  if (spec.type === 'ticker') {
    return tickerIcon(spec.sym, { className: 'ticker-icon tag-pill__ticker', size: 16 });
  }
  const color = colorHex || 'currentColor';
  return `<span class="tag-pill__glyph" style="color:${color}" aria-hidden="true">${spec.svg}</span>`;
}

// Ionicons "sad-outline" — EmptyState icon for filtered feed with no results (app parity).
const SAD_OUTLINE_ICON =
  '<svg viewBox="0 0 512 512" aria-hidden="true" fill="currentColor">' +
  '<circle cx="184" cy="232" r="24"/>' +
  '<path d="M256 288c45.42 0 83.62 29.53 95.71 69.83a8 8 0 01-7.87 10.17H168.15a8 8 0 01-7.82-10.17C172.32 317.53 210.53 288 256 288z"/>' +
  '<circle cx="328" cy="232" r="24"/>' +
  '<circle cx="256" cy="256" r="208" fill="none" stroke="currentColor" stroke-miterlimit="10" stroke-width="32"/>' +
  '</svg>';

/** Sync edge fades + prev/next disabled state with the tag bar scroll position. */
function syncTagbarEdges() {
  const bar = $('tagbar');
  const wrap = $('tagbar-wrap');
  const prev = $('tagbar-prev');
  const next = $('tagbar-next');
  if (!bar || !wrap) return;
  const max = Math.max(0, bar.scrollWidth - bar.clientWidth);
  const scrollable = max > 2;
  const atStart = !scrollable || bar.scrollLeft <= 1;
  const atEnd = !scrollable || bar.scrollLeft >= max - 1;
  wrap.dataset.atStart = atStart ? '1' : '0';
  wrap.dataset.atEnd = atEnd ? '1' : '0';
  wrap.classList.toggle('is-scrollable', scrollable);
  if (prev) prev.disabled = atStart;
  if (next) next.disabled = atEnd;
}

function scrollTagbar(dir) {
  const bar = $('tagbar');
  if (!bar) return;
  // Page ~70% of the visible strip so consecutive clicks still show overlap.
  const delta = Math.max(bar.clientWidth * 0.7, 160) * dir;
  bar.scrollBy({ left: delta, behavior: 'smooth' });
}

let tagbarNavReady = false;
function ensureTagbarNav() {
  if (tagbarNavReady) return;
  const bar = $('tagbar');
  const prev = $('tagbar-prev');
  const next = $('tagbar-next');
  if (!bar) return;
  tagbarNavReady = true;
  bar.addEventListener('scroll', syncTagbarEdges, { passive: true });
  window.addEventListener('resize', syncTagbarEdges);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncTagbarEdges).observe(bar);
  }
  if (prev) prev.addEventListener('click', () => scrollTagbar(-1));
  if (next) next.addEventListener('click', () => scrollTagbar(1));
}

function renderTags() {
  const bar = $('tagbar');
  if (!bar) return;
  ensureTagbarNav();
  // Tags hidden from the filter bar (still valid on posts, just not offered as filters)
  const HIDDEN_TAGS = ['Adoção', 'Regulação'];
  const pills = [{ name: 'all', label: I18N.t('filters.all'), color: 'default' }]
    .concat(feedTags
      .filter((t) => !HIDDEN_TAGS.includes(t.name))
      .map((t) => ({ name: t.name, label: tagLabel(t.name), color: t.color })));
  bar.replaceChildren();
  pills.forEach((p) => {
    const btn = el('button', 'tag-pill');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.dataset.tag = p.name;
    btn.dataset.color = p.color;
    // Glyph icons always use the category colour; tickers keep brand colours.
    btn.innerHTML = `${tagIconHtml(p.name, pillHex(p.color))}<span>${escapeHtml(p.label)}</span>`;
    btn.addEventListener('click', () => selectTag(p.name));
    bar.appendChild(btn);
  });
  // Apply selection styles after mount so a later syncTagPills() can animate in place.
  syncTagPills();
  // After layout so scrollWidth is correct (fonts/icons may still settle — rAF covers it).
  requestAnimationFrame(syncTagbarEdges);
}

/** Toggle selected styles on existing pills — keeps DOM so CSS transitions can run. */
function syncTagPills() {
  const bar = $('tagbar');
  if (!bar) return;
  const dark = isDark();
  bar.querySelectorAll('.tag-pill').forEach((btn) => {
    const name = btn.dataset.tag;
    const selected = name === selectedTag;
    btn.classList.toggle('selected', selected);
    btn.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) {
      const hex = pillHex(btn.dataset.color || 'default');
      // Matches the app's NOTION_SELECTED_COLORS: rgba(hex, .15) light / .3 dark.
      btn.style.background = rgba(hex, dark ? 0.3 : 0.15);
      btn.style.color = hex;
    } else {
      btn.style.background = '';
      btn.style.color = '';
    }
  });
}

// ── Glossary matcher (port of app src/utils/glossaryMatcher.ts) ───────
function isWordChar(ch) {
  return /[\p{L}\p{N}_]/u.test(ch);
}
function isWordBoundary(textLower, start, end) {
  if (start > 0 && isWordChar(textLower[start - 1])) return false;
  if (end < textLower.length && isWordChar(textLower[end])) return false;
  return true;
}

/**
 * Builds a matcher that finds glossary terms (and Alt aliases) in plain text.
 * Longer matches win; non-overlapping; case-insensitive with word boundaries.
 */
function buildGlossaryMatcher(terms) {
  const entries = [];
  for (const term of terms || []) {
    if (term.termo && term.termo.trim()) {
      entries.push({ lower: term.termo.trim().toLowerCase(), term });
    }
    for (const alt of term.alt || []) {
      if (alt && alt.trim()) entries.push({ lower: alt.trim().toLowerCase(), term });
    }
  }
  // Longer first so "Mercado Futuros" wins over "Mercado".
  entries.sort((a, b) => b.lower.length - a.lower.length);

  return {
    splitText(text) {
      if (!text || !entries.length) return [{ text }];
      const textLower = text.toLowerCase();
      const matches = [];
      const claimed = new Set();

      for (const entry of entries) {
        const needle = entry.lower;
        let searchFrom = 0;
        while (searchFrom <= textLower.length - needle.length) {
          const idx = textLower.indexOf(needle, searchFrom);
          if (idx === -1) break;
          const end = idx + needle.length;
          let overlaps = false;
          for (let i = idx; i < end; i++) {
            if (claimed.has(i)) { overlaps = true; break; }
          }
          if (!overlaps && isWordBoundary(textLower, idx, end)) {
            matches.push({
              start: idx,
              end,
              term: entry.term,
              matchedText: text.slice(idx, end),
            });
            for (let i = idx; i < end; i++) claimed.add(i);
          }
          searchFrom = idx + 1;
        }
      }
      matches.sort((a, b) => a.start - b.start);
      if (!matches.length) return [{ text }];

      const segments = [];
      let cursor = 0;
      for (const m of matches) {
        if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start) });
        segments.push({ text: m.matchedText, glossaryTerm: m.term });
        cursor = m.end;
      }
      if (cursor < text.length) segments.push({ text: text.slice(cursor) });
      return segments;
    },
  };
}

function getGlossarySplitText(text) {
  if (!glossaryMatcher || !text) return [{ text: text || '' }];
  const cached = glossarySegmentsCache.get(text);
  if (cached) return cached;
  if (glossarySegmentsCache.size >= 200) glossarySegmentsCache.clear();
  const segments = glossaryMatcher.splitText(text);
  glossarySegmentsCache.set(text, segments);
  return segments;
}

/** Wrap matched glossary terms with hoverable spans (app dotted-underline). */
function applyGlossaryToPlainText(text) {
  if (!text) return '';
  if (!glossaryMatcher) return escapeHtml(text);
  const segments = getGlossarySplitText(text);
  if (segments.length === 1 && !segments[0].glossaryTerm) return escapeHtml(text);
  return segments.map((seg) => {
    const escaped = escapeHtml(seg.text);
    if (!seg.glossaryTerm) return escaped;
    const t = seg.glossaryTerm;
    const active = glossaryActiveTermId === t.id ? ' is-active' : '';
    const aria = escapeHtml(I18N.t('glossary.termAria', { term: t.termo }));
    // span + tabindex: hover on desktop, keyboard focus still works. No click-to-open.
    return (
      `<span class="glossary-term${active}" data-glossary-id="${escapeHtml(t.id)}" ` +
      `tabindex="0" role="button" aria-label="${aria}">${escaped}</span>`
    );
  }).join('');
}

function setGlossaryTerms(terms) {
  glossaryTerms = Array.isArray(terms) ? terms : [];
  glossaryMatcher = glossaryTerms.length ? buildGlossaryMatcher(glossaryTerms) : null;
  glossarySegmentsCache.clear();
  glossaryLoadedLang = I18N.notionLang;
}

async function ensureGlossaryLoaded(opts) {
  const force = opts && opts.force;
  // Already loaded for this language (including a successful empty result).
  if (!force && glossaryLoadedLang === I18N.notionLang) return;
  if (isPreview()) {
    setGlossaryTerms(mockGlossaryTerms());
    return;
  }
  try {
    const res = await authFetch(`/web/glossary?lang=${I18N.notionLang}`);
    if (!res) return; // session expired
    if (!res.ok) throw new Error('glossary fetch failed');
    const data = await res.json();
    setGlossaryTerms(data.terms || []);
  } catch (e) {
    // Do NOT mark as loaded — leave glossaryLoadedLang unset so the next open retries.
    // Keep any previous terms if we had them; otherwise show empty with retry on next visit.
    if (glossaryLoadedLang !== I18N.notionLang) {
      glossaryTerms = [];
      glossaryMatcher = null;
      glossarySegmentsCache.clear();
    }
  }
}

function mockGlossaryTerms() {
  return [
    {
      id: 'g-btc',
      termo: 'Bitcoin',
      definicao: 'A primeira e mais conhecida criptomoeda, criada em 2009 por Satoshi Nakamoto.',
      alt: ['BTC', 'bitcoin'],
    },
    {
      id: 'g-vol',
      termo: 'Volume',
      definicao: 'Quantidade de um ativo negociada em um período. Volume alto reforça a validade de um movimento de preço.',
      alt: ['volume'],
    },
    {
      id: 'g-liq',
      termo: 'Liquidez',
      definicao: 'Facilidade de comprar ou vender um ativo sem alterar significativamente o preço.',
      alt: ['liquidez'],
    },
    {
      id: 'g-amm',
      termo: 'AMM',
      definicao: 'Automated Market Maker — protocolo que usa pools de liquidez e fórmulas matemáticas em vez de um livro de ofertas.',
      alt: ['AMMs', 'Automated Market Maker'],
    },
    {
      id: 'g-sup',
      termo: 'Suporte',
      definicao: 'Nível de preço onde a demanda historicamente impede quedas maiores.',
      alt: ['suporte'],
    },
    {
      id: 'g-res',
      termo: 'Resistência',
      definicao: 'Nível de preço onde a oferta historicamente impede altas maiores.',
      alt: ['resistência', 'resistencia'],
    },
  ];
}

// ── Glossary tooltip (hover) ──────────────────────────────────────────
let glossaryTooltipHideTimer = 0;
let glossaryTooltipShowTimer = 0;
let glossaryHoverTermEl = null;

function glossaryTermById(id) {
  return glossaryTerms.find((t) => t.id === id) || null;
}

function hideGlossaryTooltip() {
  clearTimeout(glossaryTooltipShowTimer);
  clearTimeout(glossaryTooltipHideTimer);
  glossaryTooltipHideTimer = 0;
  glossaryTooltipShowTimer = 0;
  glossaryHoverTermEl = null;
  const root = $('glossary-tooltip-root');
  const tip = $('glossary-tooltip');
  if (!root || !tip) return;
  tip.classList.remove('is-visible');
  glossaryActiveTermId = null;
  document.querySelectorAll('.glossary-term.is-active').forEach((n) => n.classList.remove('is-active'));
  setTimeout(() => {
    if (!tip.classList.contains('is-visible')) root.hidden = true;
  }, 160);
}

function scheduleHideGlossaryTooltip(delayMs) {
  clearTimeout(glossaryTooltipHideTimer);
  glossaryTooltipHideTimer = setTimeout(() => {
    hideGlossaryTooltip();
  }, delayMs == null ? 80 : delayMs);
}

function showGlossaryTooltip(term, clientX, clientY, lineHeight) {
  const root = $('glossary-tooltip-root');
  const tip = $('glossary-tooltip');
  if (!root || !tip || !term) return;

  clearTimeout(glossaryTooltipHideTimer);
  glossaryTooltipHideTimer = 0;

  glossaryActiveTermId = term.id;
  document.querySelectorAll('.glossary-term.is-active').forEach((n) => n.classList.remove('is-active'));
  document.querySelectorAll(`.glossary-term[data-glossary-id="${CSS.escape(term.id)}"]`)
    .forEach((n) => n.classList.add('is-active'));

  $('glossary-tooltip-term').textContent = term.termo;
  $('glossary-tooltip-def').textContent = term.definicao;

  root.hidden = false;
  // If already visible for another term, just reposition without flash
  const alreadyOpen = tip.classList.contains('is-visible');
  if (!alreadyOpen) {
    tip.classList.remove('is-visible');
    tip.style.visibility = 'hidden';
  }
  tip.style.left = '0px';
  tip.style.top = '0px';

  requestAnimationFrame(() => {
    const rect = tip.getBoundingClientRect();
    const w = rect.width || 280;
    const h = rect.height || 80;
    const margin = 16;
    const gap = 8;
    const arrowH = 7;
    const lh = lineHeight || 24;

    const lineTop = clientY;
    const lineBottom = clientY + lh;
    const spaceAbove = lineTop - margin;
    const showAbove = spaceAbove >= h + arrowH + gap;

    let top;
    if (showAbove) {
      top = lineTop - gap - arrowH - h;
      tip.dataset.side = 'above';
    } else {
      top = lineBottom + gap + arrowH;
      tip.dataset.side = 'below';
      if (top + h > window.innerHeight - margin) top = window.innerHeight - margin - h;
    }
    top = Math.max(margin, top);

    let left = clientX - w / 2;
    left = Math.max(margin, Math.min(window.innerWidth - w - margin, left));

    const arrow = $('glossary-tooltip-arrow');
    if (arrow) {
      const arrowX = Math.max(12, Math.min(clientX - left, w - 12));
      arrow.style.left = `${arrowX}px`;
      arrow.style.transform = 'translateX(-50%)';
    }

    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.visibility = '';
    if (!alreadyOpen) {
      void tip.offsetWidth;
      tip.classList.add('is-visible');
    } else {
      tip.classList.add('is-visible');
    }
  });
}

function openGlossaryTooltipForEl(el) {
  if (!el) return;
  const term = glossaryTermById(el.dataset.glossaryId);
  if (!term) return;
  glossaryHoverTermEl = el;
  const rect = el.getBoundingClientRect();
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || rect.height || 24;
  showGlossaryTooltip(term, rect.left + rect.width / 2, rect.top, lineHeight);
}

/** Delegated hover/focus on .glossary-term inside content roots. */
function onGlossaryTermPointerOver(e) {
  const el = e.target.closest && e.target.closest('.glossary-term');
  if (!el) return;
  // Ignore bubbled transitions from child text nodes re-entering
  if (glossaryHoverTermEl === el) {
    clearTimeout(glossaryTooltipHideTimer);
    return;
  }
  clearTimeout(glossaryTooltipHideTimer);
  clearTimeout(glossaryTooltipShowTimer);
  // Tiny delay so quick mouse-through doesn't flash tooltips
  glossaryTooltipShowTimer = setTimeout(() => openGlossaryTooltipForEl(el), 60);
}

function onGlossaryTermPointerOut(e) {
  const el = e.target.closest && e.target.closest('.glossary-term');
  if (!el) return;
  // Still inside the same term (moved to a child)?
  const related = e.relatedTarget;
  if (related && el.contains(related)) return;
  if (related && related.closest && related.closest('.glossary-term') === el) return;
  clearTimeout(glossaryTooltipShowTimer);
  scheduleHideGlossaryTooltip(100);
}

function onGlossaryTermFocusIn(e) {
  const el = e.target.closest && e.target.closest('.glossary-term');
  if (!el) return;
  openGlossaryTooltipForEl(el);
}

function onGlossaryTermFocusOut(e) {
  const el = e.target.closest && e.target.closest('.glossary-term');
  if (!el) return;
  scheduleHideGlossaryTooltip(120);
}

function wireGlossaryTooltipRoot(root) {
  if (!root || root.dataset.glossaryTipBound) return;
  root.dataset.glossaryTipBound = '1';
  root.addEventListener('mouseover', onGlossaryTermPointerOver);
  root.addEventListener('mouseout', onGlossaryTermPointerOut);
  root.addEventListener('focusin', onGlossaryTermFocusIn);
  root.addEventListener('focusout', onGlossaryTermFocusOut);
}

// ── Notion block renderer (raw block JSON) ────────────────────────────
function richText(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map((t) => {
    // A Notion custom emoji arrives as a MENTION whose plain_text is the literal ":name:".
    // Rendering plain_text — which is all this did — puts ":crypto-doge:" on the page.
    const ce =
      t.type === 'mention' && t.mention && t.mention.type === 'custom_emoji'
        ? t.mention.custom_emoji
        : null;
    if (ce && ce.url) {
      const img = `<img class="nb-emoji" src="${escapeHtml(ce.url)}" alt="${escapeHtml(t.plain_text || '')}" loading="lazy"/>`;
      const link = t.href || (t.text && t.text.link && t.text.link.url);
      return link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${img}</a>` : img;
    }

    const a = t.annotations || {};
    const href = t.href || (t.text && t.text.link && t.text.link.url);
    const plain = t.plain_text || '';
    // Skip glossary inside code or links (avoid nested interactive elements).
    let html = (a.code || href) ? escapeHtml(plain) : applyGlossaryToPlainText(plain);
    if (a.code) html = `<code>${html}</code>`;
    if (a.bold) html = `<strong>${html}</strong>`;
    if (a.italic) html = `<em>${html}</em>`;
    if (a.strikethrough) html = `<s>${html}</s>`;
    if (a.underline) html = `<u>${html}</u>`;
    if (a.color && a.color !== 'default') {
      if (a.color.endsWith('_background')) {
        // Solid, like the app — a translucent wash of the text colour is a different colour.
        const bg = notionBgHex(a.color.replace('_background', ''));
        html = `<span style="background:${bg};padding:0 2px;border-radius:3px">${html}</span>`;
      } else if (NOTION_COLORS[a.color]) {
        html = `<span style="color:${notionHex(a.color)}">${html}</span>`;
      }
    }
    if (href) {
      const internal = internalCalcRoute(href);
      if (internal) {
        html = `<a href="${escapeHtml(href)}" data-calc-link="${internal}">${html}</a>`;
      } else {
        html = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${html}</a>`;
      }
    }
    return html;
  }).join('');
}

/** App InternalLinkContext routes: /dca-sim, /pos-calc (optionally absolute). */
function internalCalcRoute(href) {
  if (!href) return null;
  try {
    let path = href;
    if (/^https?:\/\//i.test(href)) {
      const u = new URL(href);
      // Only treat same-site or path-only style app routes.
      if (u.hostname && u.hostname !== 'crypto-bros.com' && u.hostname !== location.hostname) return null;
      path = u.pathname || '';
    }
    path = path.replace(/\/+$/, '') || '/';
    const lower = path.toLowerCase();
    if (lower === '/dca-sim' || lower.endsWith('/dca-sim')) return 'dca';
    if (lower === '/pos-calc' || lower.endsWith('/pos-calc')) return 'pos';
  } catch (e) {}
  return null;
}
function blockText(b) { const d = b[b.type]; return d ? richText(d.rich_text) : ''; }
function imgUrl(d) { return d ? (d.external ? d.external.url : d.file ? d.file.url : null) : null; }
function hostname(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } }
function youtubeEmbed(url) {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : null;
}

// ── Progressive images (app parity: CachedImage + BlurPlaceholder) ────
//
// 1. Paint a tiny thumbnail (blurred) immediately.
// 2. Lazy-load the full (or width-capped) image on top.
// 3. Fade the thumb out when the full image is ready.
//
// Notion-hosted URLs accept `?width=` for free resizing. AWS-signed S3 file
// URLs must not be mutated (signature breaks) — for those we rely on an
// explicit Thumbnail property when the API sends one.

/**
 * Resize Notion-hosted image URLs (app: transforms.ts resizeNotionImageUrl).
 * Signed S3 URLs (`X-Amz-*`) are returned unchanged.
 */
function resizeNotionImageUrl(url, width) {
  if (!url || !width) return url || null;
  let parsed;
  try { parsed = new URL(url); } catch (e) { return url; }
  if (!parsed.hostname.toLowerCase().includes('notion')) return url;
  for (const key of parsed.searchParams.keys()) {
    if (key.toLowerCase().startsWith('x-amz-')) return url;
  }
  parsed.searchParams.set('width', String(width));
  return parsed.toString();
}

/**
 * @param {string} src full-resolution source
 * @param {{ fullWidth?: number, thumbWidth?: number, thumbUrl?: string|null }} [opts]
 * @returns {{ full: string, thumb: string|null }}
 */
function progressiveImgAttrs(src, opts) {
  const fullWidth = (opts && opts.fullWidth) || 1200;
  const thumbWidth = (opts && opts.thumbWidth) || 40;
  const explicitThumb = opts && opts.thumbUrl;
  const full = resizeNotionImageUrl(src, fullWidth) || src;
  let thumb = null;
  if (explicitThumb) {
    thumb = resizeNotionImageUrl(explicitThumb, thumbWidth) || explicitThumb;
  } else {
    const derived = resizeNotionImageUrl(src, thumbWidth);
    // Only progressive when width= actually produced a different URL.
    if (derived && derived !== src) thumb = derived;
  }
  if (thumb && thumb === full) thumb = null;
  return { full, thumb };
}

/** Wire load/error on a progressive wrapper so the blur thumb fades out. */
function bindProgressiveImg(wrap) {
  if (!wrap || wrap.dataset.lazyBound) return;
  wrap.dataset.lazyBound = '1';
  const full = wrap.querySelector('.lazy-img__full');
  if (!full) { wrap.classList.add('is-loaded'); return; }
  const done = (ok) => {
    wrap.classList.add('is-loaded');
    if (!ok) wrap.classList.add('is-error');
  };
  if (full.complete && full.naturalWidth) done(true);
  else if (full.complete) done(false); // decoded as broken
  else {
    full.addEventListener('load', () => done(true), { once: true });
    full.addEventListener('error', () => done(false), { once: true });
  }
}

/** After innerHTML with progressive images, attach load handlers. */
function hydrateLazyImages(root) {
  if (!root) return;
  root.querySelectorAll('.lazy-img').forEach(bindProgressiveImg);
}

/**
 * DOM node for progressive cover/content images.
 * Falls back to a plain <img loading=lazy> when no thumb is available.
 */
function progressiveImgEl(src, className, opts) {
  const { full, thumb } = progressiveImgAttrs(src, opts);
  if (!thumb) {
    const img = el('img', className);
    img.src = full;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => img.remove();
    return img;
  }
  const wrap = el('span', `lazy-img${className ? ` ${className}` : ''}`);
  const t = el('img', 'lazy-img__thumb');
  t.src = thumb;
  t.alt = '';
  t.decoding = 'async';
  t.setAttribute('aria-hidden', 'true');
  const f = el('img', 'lazy-img__full');
  f.src = full;
  f.alt = '';
  f.loading = 'lazy';
  f.decoding = 'async';
  wrap.appendChild(t);
  wrap.appendChild(f);
  bindProgressiveImg(wrap);
  return wrap;
}

/** HTML string variant for renderBlocks(). Call hydrateLazyImages() after insert. */
function progressiveImgHtml(src, className, opts) {
  const { full, thumb } = progressiveImgAttrs(src, opts);
  if (!thumb) {
    return `<img class="${className || ''}" src="${escapeHtml(full)}" loading="lazy" decoding="async" alt=""/>`;
  }
  const cls = `lazy-img${className ? ` ${className}` : ''}`;
  return (
    `<span class="${cls}">` +
      `<img class="lazy-img__thumb" src="${escapeHtml(thumb)}" alt="" aria-hidden="true" decoding="async"/>` +
      `<img class="lazy-img__full" src="${escapeHtml(full)}" loading="lazy" decoding="async" alt=""/>` +
    `</span>`
  );
}

// ── Bookmark cards ────────────────────────────────────────────────────
//
// App parity (BookmarkBlock.tsx): a card with the page's og:title, its favicon + domain,
// and a preview image on the right — with the Notion caption BELOW the card, not used as
// the title. The app scrapes the target page itself; a browser cannot (arbitrary sites
// send no CORS headers), so the metadata comes from the Worker's /web/link-preview.
//
// renderBlocks() is synchronous, so the card is emitted with the domain as a placeholder
// title and hydrated once it is in the DOM.

const LINK_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';

function bookmarkHtml(url, caption) {
  const host = escapeHtml(hostname(url));
  const cap = caption && caption.length ? richText(caption) : '';
  return (
    `<div class="nb-bookmark-wrap">` +
      `<a class="nb-bookmark" href="${escapeHtml(url)}" target="_blank" rel="noopener" data-preview="${escapeHtml(url)}">` +
        `<div class="nb-bookmark-body">` +
          `<div class="nb-bookmark-title">${host}</div>` +
          `<div class="nb-bookmark-meta">` +
            `<span class="nb-bookmark-icon">${LINK_ICON_SVG}</span>` +
            `<span class="nb-bookmark-url">${host}</span>` +
          `</div>` +
        `</div>` +
      `</a>` +
      (cap ? `<div class="nb-bookmark-caption">${cap}</div>` : '') +
    `</div>`
  );
}

const linkPreviewCache = {}; // url → { title, description, image, favicon }

/** Fill in og: title / favicon / preview image for every bookmark card under `root`. */
async function hydrateBookmarks(root) {
  const cards = [...root.querySelectorAll('.nb-bookmark[data-preview]')];
  await Promise.all(
    cards.map(async (card) => {
      const url = card.dataset.preview;
      delete card.dataset.preview; // hydrate once, even if this node is re-scanned
      let p = linkPreviewCache[url];
      if (!p) {
        try {
          const res = await fetch(
            `${CONFIG.workerBase}/web/link-preview?url=${encodeURIComponent(url)}`,
          );
          if (!res.ok) return; // leave the domain-only placeholder — it is still a valid link
          p = await res.json();
          linkPreviewCache[url] = p;
        } catch (e) {
          return;
        }
      }
      if (p.title) card.querySelector('.nb-bookmark-title').textContent = p.title;
      if (p.favicon) {
        const img = el('img', 'nb-bookmark-favicon');
        img.src = p.favicon;
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => img.remove(); // a broken favicon must not leave a gap
        card.querySelector('.nb-bookmark-icon').replaceChildren(img);
      }
      if (p.image) {
        const img = el('img', 'nb-bookmark-preview');
        img.src = p.image;
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => img.remove();
        card.appendChild(img);
      }
    }),
  );
}

/** Notion block icon → HTML. Custom emoji and uploaded images are images, not characters. */
function calloutIcon(icon) {
  if (!icon) return '💡';
  const url =
    (icon.type === 'custom_emoji' && icon.custom_emoji && icon.custom_emoji.url) ||
    (icon.type === 'external' && icon.external && icon.external.url) ||
    (icon.type === 'file' && icon.file && icon.file.url) ||
    null;
  if (url) return `<img class="nb-emoji nb-emoji--callout" src="${escapeHtml(url)}" alt="" loading="lazy"/>`;
  return escapeHtml(icon.emoji || '💡');
}

function renderBlocks(blocks, skipFirstDivider) {
  let html = '', listType = null, listItems = '', firstDividerSkipped = false;
  // Pending half-width widget (price or size:half chart) — paired like app groupHalfCharts.
  let pendingHalf = null; // { kind: 'price'|'chart', html: string }
  const flushList = () => {
    if (listType) { html += `<${listType}>${listItems}</${listType}>`; listType = null; listItems = ''; }
  };
  const flushHalf = () => {
    if (!pendingHalf) return;
    // Solo half-width: keep left cell + empty spacer (app chartRow + flex:1 spacer).
    html += `<div class="nb-half-row">${pendingHalf.html}<div class="nb-half-spacer" aria-hidden="true"></div></div>`;
    pendingHalf = null;
  };
  const emitWidget = (kind, params) => {
    const piece = kind === 'chart'
      ? chartEmbedPlaceholder(params)
      : kind === 'price'
        ? priceWidgetPlaceholder(params)
        : unsupportedWidgetHtml();
    if (kind === 'unsupported' || !isHalfWidthWidget(kind, params)) {
      flushHalf();
      html += piece;
      return;
    }
    // Only pair same kind: price+price or half-chart+half-chart (app bothPriceWidgets / bothHalfCharts).
    if (pendingHalf && pendingHalf.kind === kind) {
      html += `<div class="nb-half-row">${pendingHalf.html}${piece}</div>`;
      pendingHalf = null;
    } else {
      flushHalf();
      pendingHalf = { kind, html: piece };
    }
  };
  for (const b of blocks || []) {
    const t = b.type;
    if (t === 'bulleted_list_item' || t === 'numbered_list_item' || t === 'to_do') {
      // Lists break a half-row (app groupHalfCharts only pairs consecutive half blocks).
      flushHalf();
      const tag = t === 'numbered_list_item' ? 'ol' : 'ul';
      if (listType && listType !== tag) flushList();
      listType = tag;
      const check = t === 'to_do' ? (b.to_do && b.to_do.checked ? '☑ ' : '☐ ') : '';
      const kids = b.children && b.children.length ? renderBlocks(b.children) : '';
      listItems += `<li>${check}${blockText(b)}${kids}</li>`;
      continue;
    }
    flushList();
    const kids = b.children && b.children.length ? renderBlocks(b.children) : '';
    switch (t) {
      case 'paragraph': {
        // Widget embeds: entire paragraph is {{chart:…}} or {{price:…}} (app transforms.ts).
        const plain = plainFromBlock(b);
        const widget = tryParseWidget(plain);
        if (widget) {
          if (widget.kind === 'chart' || widget.kind === 'price') emitWidget(widget.kind, widget.params);
          else { flushHalf(); html += unsupportedWidgetHtml(); }
          break;
        }
        flushHalf();
        const x = blockText(b);
        if (x || kids) html += `<p>${x}</p>${kids}`;
        break;
      }
      case 'heading_1': flushHalf(); html += `<h1>${blockText(b)}</h1>`; break;
      case 'heading_2': flushHalf(); html += `<h2>${blockText(b)}</h2>`; break;
      case 'heading_3': flushHalf(); html += `<h3>${blockText(b)}</h3>`; break;
      case 'quote': flushHalf(); html += `<blockquote>${blockText(b)}${kids}</blockquote>`; break;
      case 'callout': {
        flushHalf();
        // The icon is not always a unicode emoji. Falling back to 💡 for a custom emoji does
        // not LOOK like a bug — it looks like a lightbulb — so 43 `:circle-info:` icons were
        // silently replaced by one.
        const icon = calloutIcon(b.callout && b.callout.icon);
        // The callout's Notion colour drives bg AND text, per theme — the app's
        // NOTION_CALLOUT_COLORS. This used to be a flat --bg-tertiary that ignored it.
        const cc = calloutColors(b.callout && b.callout.color);
        html += `<div class="callout" style="background:${cc.bg};color:${cc.text}"><span class="callout-emoji">${icon}</span><div>${blockText(b)}${kids}</div></div>`;
        break;
      }
      case 'toggle': flushHalf(); html += `<details><summary>${blockText(b)}</summary>${kids}</details>`; break;
      case 'code': {
        // Charts often live in code blocks in Notion (app also accepts this).
        const codePlain = (b.code && b.code.rich_text || []).map((r) => r.plain_text || '').join('');
        const codeWidget = tryParseWidget(codePlain);
        if (codeWidget) {
          if (codeWidget.kind === 'chart' || codeWidget.kind === 'price') emitWidget(codeWidget.kind, codeWidget.params);
          else { flushHalf(); html += unsupportedWidgetHtml(); }
          break;
        }
        flushHalf();
        html += `<pre><code>${escapeHtml(codePlain)}</code></pre>`;
        break;
      }
      case 'chart_embed':
        // Pre-transformed shape (if API ever emits it)
        if (b.chartParams) emitWidget('chart', b.chartParams);
        else { flushHalf(); html += unsupportedWidgetHtml(); }
        break;
      case 'price_widget':
        if (b.priceWidgetParams) emitWidget('price', b.priceWidgetParams);
        else { flushHalf(); html += unsupportedWidgetHtml(); }
        break;
      case 'unsupported_widget':
        flushHalf();
        html += unsupportedWidgetHtml();
        break;
      case 'divider':
        // The first divider is the preview/full boundary (marks "Continuar Lendo") — never rendered.
        if (skipFirstDivider && !firstDividerSkipped) { firstDividerSkipped = true; break; }
        flushHalf();
        html += '<hr class="nb-hr"/>';
        break;
      case 'image': {
        flushHalf();
        const u = imgUrl(b.image);
        if (u) {
          // Theme-gating (app parity — ImageBlock.tsx): a caption containing [light] means
          // the image is light-mode only, [dark] means dark-mode only. The marker is an
          // instruction, not a caption, so it is stripped from what gets shown.
          const caption = (b.image && b.image.caption) || [];
          const plain = caption.map((t) => t.plain_text || '').join('').toLowerCase();
          const lightOnly = plain.includes('[light]');
          const darkOnly = plain.includes('[dark]');
          if ((lightOnly && isDark()) || (darkOnly && !isDark())) break; // wrong theme → drop it

          const shown = (lightOnly || darkOnly)
            ? caption
                .map((t) => ({ ...t, plain_text: (t.plain_text || '').replace(/\[(light|dark)\]/gi, '').trim() }))
                .filter((t) => t.plain_text !== '')
            : caption;
          const cap = shown.length ? richText(shown) : '';
          // Progressive: tiny blurred thumb first, then width-capped full (app ImageBlock/CachedImage).
          html += `<figure class="nb-figure">${progressiveImgHtml(u, 'nb-figure__img', { fullWidth: 1200, thumbWidth: 40 })}${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`;
        }
        break;
      }
      case 'video': {
        flushHalf();
        const v = b.video, u = v ? (v.external ? v.external.url : v.file ? v.file.url : null) : null;
        if (u) {
          const yt = youtubeEmbed(u);
          html += yt
            ? `<div class="nb-video"><iframe src="${yt}" allow="encrypted-media" allowfullscreen loading="lazy"></iframe></div>`
            : `<div class="nb-video"><video src="${escapeHtml(u)}" controls></video></div>`;
        }
        break;
      }
      case 'bookmark': case 'embed': case 'link_preview': {
        flushHalf();
        const d = b[t], u = d && d.url;
        if (u) html += bookmarkHtml(u, d.caption);
        break;
      }
      case 'table': {
        flushHalf();
        const rows = (b.children || []).filter((r) => r.type === 'table_row');
        if (rows.length) {
          const hasHeader = b.table && b.table.has_column_header;
          let head = '', bodyRows = '';
          rows.forEach((r, ri) => {
            const cells = (r.table_row && r.table_row.cells) || [];
            if (hasHeader && ri === 0) head = `<thead><tr>${cells.map((c) => `<th>${richText(c)}</th>`).join('')}</tr></thead>`;
            else bodyRows += `<tr>${cells.map((c) => `<td>${richText(c)}</td>`).join('')}</tr>`;
          });
          html += `<div class="nb-table-wrap"><table class="nb-table">${head}<tbody>${bodyRows}</tbody></table></div>`;
        }
        break;
      }
      case 'column_list': {
        flushHalf();
        const cols = (b.children || []).filter((c) => c.type === 'column');
        if (cols.length) html += `<div class="nb-columns">${cols.map((c) => `<div class="nb-column">${renderBlocks(c.children || [])}</div>`).join('')}</div>`;
        break;
      }
      case 'equation':
        flushHalf();
        html += `<pre class="nb-eq"><code>${escapeHtml(b.equation ? b.equation.expression : '')}</code></pre>`;
        break;
      default: break; // chart_embed / price_widget / unsupported_widget → app-only, skipped
    }
  }
  flushList();
  flushHalf();
  return html;
}

// ── Post card ─────────────────────────────────────────────────────────
const AVATAR_MAP = {
  'vini ramos': 'ViniRamos.jpg', '@viniciusramos': 'ViniRamos.jpg', 'viniciusramos': 'ViniRamos.jpg',
  'crypto bros': 'criptobros2.png', 'cryptobros': 'criptobros2.png',
  '@ocryptobro': 'criptobros2.png', 'ocryptobro': 'criptobros2.png',
};
function avatarNode(author) {
  const name = (author && author.name) || 'Crypto Bros';
  const key = name.toLowerCase().trim();
  const local = AVATAR_MAP[key];
  const src = local ? `./assets/avatars/${local}` : (author && author.avatar) || null;
  if (src) { const img = el('img', 'avatar'); img.src = src; img.alt = ''; img.referrerPolicy = 'no-referrer'; return img; }
  return el('div', 'avatar avatar--ph', name.charAt(0).toUpperCase());
}
function titleHtml(post) {
  let html = ''; // page icons are not shown to the left of the title (app parity)
  const parts = (post.title || '').split(/(\[[^\]]+\])/);
  for (const part of parts) {
    const m = part.match(/^\[([^\]]+)\]$/);
    if (m) {
      const tag = m[1].toUpperCase();
      const color = tag === 'LONG' ? '#22C55E' : tag === 'SHORT' ? '#EF4444' : '#6B7280';
      html += `<span class="title-chip" style="background:${color}">${escapeHtml(m[1])}</span>`;
    } else if (part) { html += escapeHtml(part); }
  }
  return html;
}
function authorRow(post, dateClass) {
  const row = el('div', 'card__author');
  const left = el('div', 'card__author-left');
  left.appendChild(avatarNode(post.author));
  left.appendChild(el('span', 'card__author-name', (post.author && post.author.name) || 'Crypto Bros'));
  row.appendChild(left);
  row.appendChild(el('span', dateClass || 'card__date', I18N.formatDate(post.publishedAt)));
  return row;
}
function renderCard(post) {
  const card = el('article', 'card');
  card.style.cursor = 'pointer';
  card.addEventListener('click', () => openPost(post.id));
  if (post.cover) {
    // Cover: full ~800px (app extractCoverImage), thumb from Thumbnail prop or ?width=40.
    card.appendChild(progressiveImgEl(post.cover, 'card__cover', {
      fullWidth: 800,
      thumbWidth: 40,
      thumbUrl: post.thumbnail || null,
    }));
  }
  const body = el('div', 'card__body');
  body.appendChild(authorRow(post));
  const title = el('h2', 'card__title');
  title.innerHTML = titleHtml(post);
  body.appendChild(title);

  const preview = el('div', 'card__preview');
  if (post.previewBlocks && post.previewBlocks.length) preview.innerHTML = renderBlocks(post.previewBlocks, true);
  else if (post.excerpt) preview.appendChild(el('p', 'excerpt-clamp', post.excerpt));
  if (preview.innerHTML) body.appendChild(preview);

  if (post.hasDivider) {
    const more = el('div', 'card__more');
    const btn = el('button');
    btn.innerHTML = `${escapeHtml(I18N.t('post.readMore'))}` +
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
    more.appendChild(btn);
    body.appendChild(more);
  }
  card.appendChild(body);
  return card;
}

// ── Feed + history ────────────────────────────────────────────────────
/** Switch filter pill. Live traffic re-queries the Worker with `?tag=` so results
 * span the full published history; preview keeps a local filter over mock posts.
 * Clicking the already-selected tag (except "all") clears the filter. */
function selectTag(name) {
  if (selectedTag === name) {
    if (name === 'all') return;
    name = 'all'; // toggle off
  }
  selectedTag = name;
  historyPage = 0;
  // In-place style update so hover → selected (and back) can CSS-transition.
  syncTagPills();
  if (isPreview()) {
    renderFeed();
    return;
  }
  loadFeed();
}

function renderFeed() {
  const list = $('feed-list');
  // Server-scoped responses already match selectedTag. Client filter remains for
  // preview mocks (and as a safety net if a stale unscoped payload is rendered).
  const posts = selectedTag === 'all'
    ? feedPosts
    : feedPosts.filter((p) => (p.tags || []).some((t) => t.name === selectedTag));
  if (!posts.length) {
    list.replaceChildren(emptyFeedState());
  } else {
    const frag = document.createDocumentFragment();
    posts.forEach((p) => frag.appendChild(renderCard(p)));
    list.replaceChildren(frag);
    hydrateBookmarks(list);
    hydrateLazyImages(list);
    hydrateWidgets(list);
  }
  renderHistory();
}
function renderHistory() {
  const sec = $('history');
  // History rows are metadata-only (no tags). After a server-side tag query the list
  // is already scoped, so show it. Preview filters client-side only → hide history
  // while a tag is active (mock history has no tags to match against).
  if (!feedHistory.length || (selectedTag !== 'all' && isPreview())) {
    sec.classList.add('hidden');
    sec.replaceChildren();
    return;
  }
  sec.classList.remove('hidden');
  const totalPages = Math.ceil(feedHistory.length / HISTORY_PAGE_SIZE);
  if (historyPage >= totalPages) historyPage = totalPages - 1;
  const rows = feedHistory.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE);
  sec.replaceChildren();
  sec.appendChild(el('div', 'history__header', I18N.t('older.title')));
  rows.forEach((p) => {
    const row = el('button', 'history__row');
    const icon = el('div', 'history__icon');
    if (p.icon && p.icon.emoji) icon.textContent = p.icon.emoji;
    else if (p.icon && p.icon.url) { const im = el('img'); im.src = p.icon.url; im.alt = ''; im.loading = 'lazy'; icon.appendChild(im); }
    else icon.innerHTML = docIconSvg();
    const main = el('div', 'history__main');
    main.appendChild(el('div', 'history__title', p.title || '—'));
    main.appendChild(el('div', 'history__date', I18N.formatDate(p.publishedAt)));
    const chev = el('span', 'history__chev');
    chev.innerHTML = chevronSvg();
    row.appendChild(icon); row.appendChild(main); row.appendChild(chev);
    row.addEventListener('click', () => openPost(p.id));
    sec.appendChild(row);
  });
  if (totalPages > 1) {
    const pager = el('div', 'history__pager');
    const prev = el('button'); prev.innerHTML = chevronSvg(true); prev.disabled = historyPage === 0;
    prev.onclick = () => { historyPage--; renderHistory(); };
    const next = el('button'); next.innerHTML = chevronSvg(false); next.disabled = historyPage >= totalPages - 1;
    next.onclick = () => { historyPage++; renderHistory(); };
    pager.appendChild(prev); pager.appendChild(next);
    sec.appendChild(pager);
  }
}
function stateNode(title, hint, retry) {
  const wrap = el('div', 'state');
  wrap.appendChild(el('h3', null, title));
  if (hint) wrap.appendChild(el('div', null, hint));
  if (retry) { const btn = el('button', null, I18N.t('error.retry')); btn.onclick = retry; wrap.appendChild(btn); }
  return wrap;
}

/** Feed empty filter state — mirrors app EmptyState (icon="sad-outline"). */
function emptyFeedState() {
  const wrap = el('div', 'state state--empty');
  const icon = el('div', 'state__icon');
  icon.innerHTML = SAD_OUTLINE_ICON;
  wrap.appendChild(icon);
  wrap.appendChild(el('h3', 'state__title', I18N.t('empty.message')));
  wrap.appendChild(el('p', 'state__msg', I18N.t('empty.hint')));
  return wrap;
}
function skeletons(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const c = el('article', 'card skeleton');
    c.appendChild(el('div', 'card__cover'));
    const b = el('div', 'card__body');
    b.appendChild(el('div', 'sk-line short'));
    b.appendChild(el('div', 'sk-line title'));
    b.appendChild(el('div', 'sk-line'));
    c.appendChild(b);
    frag.appendChild(c);
  }
  return frag;
}
function sameTagList(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((t, i) => t.name === b[i].name && t.color === b[i].color);
}

function applyFeedData(data, opts) {
  feedPosts = data.posts || [];
  feedHistory = data.history || [];
  // Tag options come from the DB schema (not the filtered result set) — always refresh
  // when present so the pill bar stays complete even on a scoped query.
  const tagsChanged = !!(data.tags && !sameTagList(feedTags, data.tags));
  if (data.tags) feedTags = data.tags;
  // Preserve the tag that produced this payload (defaults to "all" on first paint).
  selectedTag = (opts && opts.tag) || 'all';
  historyPage = 0;
  // Rebuild only when the option set changes (or first paint). Rebuilding on every
  // filtered fetch would tear down the DOM mid hover→selected CSS transition.
  const bar = $('tagbar');
  if (tagsChanged || !bar || !bar.children.length) renderTags();
  else syncTagPills();
  renderFeed();
}

function feedCacheKey(tag) {
  const t = tag && tag !== 'all' ? tag : 'all';
  return t === 'all' ? `cb-feed-${I18N.notionLang}` : `cb-feed-${I18N.notionLang}-tag:${t}`;
}

// Bumps on every loadFeed call so a slow response for tag A cannot overwrite tag B.
let feedLoadSeq = 0;

// Stale-while-revalidate: render the cached feed instantly, then refresh from the network.
// When selectedTag !== 'all', the Worker scopes the Notion query via ?tag=.
async function loadFeed() {
  const requestedTag = selectedTag || 'all';
  const seq = ++feedLoadSeq;
  const cacheKey = feedCacheKey(requestedTag);
  let showedCache = false;
  try {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) { applyFeedData(JSON.parse(cached), { tag: requestedTag }); showedCache = true; }
  } catch (e) {}
  if (!showedCache) { $('feed-list').replaceChildren(skeletons(3)); $('history').classList.add('hidden'); }

  const tagParam = requestedTag !== 'all' ? `&tag=${encodeURIComponent(requestedTag)}` : '';
  let res;
  try {
    res = await authFetch(`/web/feed?lang=${I18N.notionLang}${tagParam}`);
  } catch (e) {
    if (seq !== feedLoadSeq) return;
    if (!showedCache) $('feed-list').replaceChildren(stateNode(I18N.t('offline.message'), null, loadFeed));
    return;
  }
  if (seq !== feedLoadSeq) return;
  if (!res) return; // session expired — authFetch already sent us to the login screen
  if (!res.ok) {
    if (!showedCache) $('feed-list').replaceChildren(stateNode(I18N.t('error.title'), I18N.t('error.message'), loadFeed));
    return;
  }
  const data = await res.json();
  if (seq !== feedLoadSeq) return;
  try { sessionStorage.setItem(cacheKey, JSON.stringify(data)); } catch (e) {}
  applyFeedData(data, { tag: requestedTag });
}

// ── Post detail modal ─────────────────────────────────────────────────
let currentPostId = null;

/** True while any full-screen overlay (post/market/indicator/lightbox) is visible. */
function anyOverlayOpen() {
  return ['modal', 'market-modal', 'indicator-modal', 'lightbox'].some((id) => {
    const el = $(id);
    return el && !el.classList.contains('hidden');
  });
}
function lockBodyScroll() {
  document.body.style.overflow = 'hidden';
  document.body.classList.add('modal-open');
}
function unlockBodyScrollIfIdle() {
  if (anyOverlayOpen()) return;
  document.body.style.overflow = '';
  document.body.classList.remove('modal-open');
}

/** Cancel a pending animated close (timer + animationend) without hiding. */
function cancelOverlayClose(root) {
  if (!root) return;
  if (root._closeTimer) { clearTimeout(root._closeTimer); root._closeTimer = null; }
  if (root._closeOnEnd && root._closePanel) {
    root._closePanel.removeEventListener('animationend', root._closeOnEnd);
  }
  root._closeOnEnd = null;
  root._closePanel = null;
  root._closeDone = null;
  root.classList.remove('is-closing');
}

/**
 * Play the CSS close animation (reverse of open), then hide. Re-open cancels
 * an in-flight close via cancelOverlayClose().
 */
function animateOverlayClose(root, panelSelector, onDone) {
  if (!root || root.classList.contains('hidden')) {
    if (onDone) onDone();
    return;
  }
  if (root.classList.contains('is-closing')) return;
  cancelOverlayClose(root);
  root.classList.add('is-closing');
  let finished = false;
  const panel = panelSelector ? root.querySelector(panelSelector) : null;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (root._closeTimer) { clearTimeout(root._closeTimer); root._closeTimer = null; }
    if (root._closeOnEnd && root._closePanel) {
      root._closePanel.removeEventListener('animationend', root._closeOnEnd);
    }
    root._closeOnEnd = null;
    root._closePanel = null;
    // Hide first, then drop is-closing — avoids a one-frame flash of the enter state.
    root.classList.add('hidden');
    root.classList.remove('is-closing');
    if (onDone) onDone();
  };
  const onEnd = (e) => {
    // Only the panel's own animation — ignore bubbled ends from children.
    if (e.target !== panel) return;
    finish();
  };
  root._closePanel = panel;
  root._closeOnEnd = onEnd;
  if (panel) panel.addEventListener('animationend', onEnd);
  // Fallback if animationend never fires (reduced-motion / display quirks).
  root._closeTimer = setTimeout(finish, 260);
}

/** Cancel an in-flight close and show the overlay (restarts enter animation). */
function openOverlay(root) {
  if (!root) return;
  const wasClosing = root.classList.contains('is-closing');
  cancelOverlayClose(root);
  root.classList.remove('hidden');
  // Interrupted mid-close: force enter keyframes to re-run from the start.
  if (wasClosing) {
    root.querySelectorAll('[class*="__panel"], [class*="__backdrop"]').forEach((node) => {
      node.style.animation = 'none';
      // Force reflow so clearing the style restarts the stylesheet animation.
      void node.offsetWidth;
      node.style.animation = '';
    });
  }
  lockBodyScroll();
}

function openModal() {
  openOverlay($('modal'));
}
function finishCloseModal(fromPop) {
  currentPostId = null;
  currentLessonId = null;
  $('modal-complete').classList.add('hidden');
  closeLessonPanel();
  markActiveLesson(null);
  // Only dismiss the post-language offer — leave a site-locale banner alone.
  hidePostLangBanner();
  unlockBodyScrollIfIdle();
  if (fromPop) return;
  const params = new URLSearchParams(location.search);
  if (!params.has('post') && !params.has('lesson')) return;
  // Go back to the view that opened the modal, not to a bare "/" — closing a lesson
  // must land on Estudos, not on the Feed.
  history.pushState({ view: currentView }, '', viewUrl(currentView));
}
function closeModal(fromPop) {
  const m = $('modal');
  // Desktop lesson panel path never opens #modal — still clean state + history.
  if (m.classList.contains('hidden')) {
    finishCloseModal(fromPop);
    return;
  }
  if (m.classList.contains('is-closing')) return;
  animateOverlayClose(m, '.modal__panel', () => finishCloseModal(fromPop));
}
function openLightbox(src) {
  $('lightbox-img').src = src;
  $('lightbox').classList.remove('hidden');
  lockBodyScroll();
}
function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lightbox-img').removeAttribute('src');
  unlockBodyScrollIfIdle();
}
function toast(msg) {
  const t = el('div', 'toast', msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2000);
}
async function shareCurrent() {
  let url;
  if (currentPostId) {
    // The pre-generated /p/<id> page carries the post's OG meta for crawlers and
    // redirects humans into the app (?post=<id>).
    url = `${location.origin}/p/${encodeURIComponent(currentPostId)}/`;
  } else if (currentLessonId) {
    // Lessons have no pre-generated page (they are session-gated anyway, so a crawler
    // would see nothing) — link straight into the app.
    url = `${location.origin}/?lesson=${encodeURIComponent(currentLessonId)}`;
  } else {
    return;
  }
  try {
    if (navigator.share) { await navigator.share({ url }); return; }
  } catch (e) { return; } // user cancelled native share
  try { await navigator.clipboard.writeText(url); toast(I18N.t('share.copied')); } catch (e) {}
}
function renderPostModal(post) {
  const c = $('modal-content');
  c.replaceChildren();
  if (post.cover) {
    c.appendChild(progressiveImgEl(post.cover, 'modal__cover', {
      fullWidth: 800,
      thumbWidth: 40,
      thumbUrl: post.thumbnail || null,
    }));
  }
  const body = el('div', 'modal__body');
  body.appendChild(authorRow(post));
  const title = el('h1', 'modal__title');
  title.innerHTML = titleHtml(post);
  body.appendChild(title);
  const content = el('div', 'modal__content');
  content.innerHTML = renderBlocks(post.blocks || post.previewBlocks || [], true);
  body.appendChild(content);
  c.appendChild(body);
  c.scrollTop = 0;
  hydrateBookmarks(content);
  hydrateLazyImages(content);
  hydrateWidgets(content);
  maybeSuggestPostLanguage(post);
}
const postCache = {}; // id → full post (in-memory, session-lived)
async function openPost(id, fromPop) {
  currentPostId = id;
  currentLessonId = null;
  closeLessonPanel(); // posts always use the centered modal, never the lesson split
  if (!fromPop) history.pushState({ post: id }, '', `?post=${encodeURIComponent(id)}`);
  openModal();
  $('modal-complete').classList.add('hidden');
  if (postCache[id]) { renderPostModal(postCache[id]); return; }
  $('modal-content').innerHTML = '<div class="spinner"></div>';
  if (isPreview()) {
    const m = feedPosts.find((p) => p.id === id) || feedHistory.find((p) => p.id === id);
    if (m) renderPostModal(m); else $('modal-content').innerHTML = `<div class="modal__state">${I18N.t('modal.error')}</div>`;
    return;
  }
  try {
    const res = await authFetch(`/web/post?id=${encodeURIComponent(id)}`);
    if (!res) return; // session expired
    if (!res.ok) throw new Error();
    const post = await res.json();
    postCache[id] = post;
    if (currentPostId === id) renderPostModal(post); // ignore if the user already opened another post
  } catch (e) {
    $('modal-content').innerHTML = `<div class="modal__state">${I18N.t('modal.error')}</div>`;
  }
}

// ── Estudos / Lessons ─────────────────────────────────────────────────
//
// Mirrors the app's Estudos tab: one card per module, a progress DONUT showing a
// completed/total fraction (not a bar, not a percentage), and numbered lesson rows.
// Grouping and ordering come from the Worker, which reuses the app's rules.

let lessonModules = []; // [{ modulo, moduloEn, lessons, completed, total }]
let currentLessonId = null;
const lessonCache = {}; // id → full lesson (in-memory, session-lived)

const LESSONS_CACHE_KEY = () => `cb-lessons-${I18N.notionLang}`;

// r = (36 - 3.5) / 2 = 16.25 — the app's ModuleProgressDonut geometry.
const DONUT_C = 2 * Math.PI * 16.25;

function donutSvg(completed, total) {
  const ratio = total > 0 ? completed / total : 0;
  const done = total > 0 && completed === total;
  return `<svg class="module__donut${done ? ' is-done' : ''}" viewBox="0 0 36 36" aria-hidden="true">
    <circle class="donut__track" cx="18" cy="18" r="16.25"/>
    <circle class="donut__arc" cx="18" cy="18" r="16.25"
      stroke-dasharray="${DONUT_C.toFixed(2)}"
      stroke-dashoffset="${(DONUT_C * (1 - ratio)).toFixed(2)}"/>
    <text x="18" y="18" text-anchor="middle" dominant-baseline="central">${completed}/${total}</text>
  </svg>`;
}
function checkSvg() {
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
}

/** Module names are written as "01 - Fundamentos"; split the number off the name. */
function parseModuleName(modulo) {
  const m = /^(\d+)\s*[-–—]\s*(.+)$/.exec(modulo || '');
  return m ? { number: m[1], name: m[2].trim() } : { number: null, name: modulo || '' };
}
function moduleName(mod) {
  return I18N.lang === 'en' && mod.moduloEn ? mod.moduloEn : mod.modulo;
}
function moduleLabel(mod) {
  const { number } = parseModuleName(moduleName(mod));
  const count = mod.total;
  const word = I18N.t(count === 1 ? 'lessons.lessonSingular' : 'lessons.lessonPlural');
  return number
    ? I18N.t('lessons.moduleLabel', { number, count, word })
    : I18N.t('lessons.moduleLabelExtra', { count, word });
}

function renderLessonRow(lesson, displayNumber) {
  const active = lesson.id === currentLessonId;
  const row = el('button', 'lesson' + (lesson.completed ? ' is-done' : '') + (active ? ' is-active' : ''));
  row.dataset.lessonId = lesson.id;
  row.setAttribute('aria-current', active ? 'true' : 'false');
  const badge = el('div', 'lesson__badge');
  // The badge shows the lesson's POSITION in the module (index + 1), never the Notion
  // "Aula" number — that one only orders, and it has gaps.
  if (lesson.completed) badge.innerHTML = checkSvg();
  else badge.textContent = String(displayNumber);
  const main = el('div', 'lesson__main');
  main.appendChild(el('div', 'lesson__title', lesson.title || '—'));
  main.appendChild(el('div', 'lesson__date', I18N.formatDate(lesson.updatedAt)));
  const chev = el('span', 'lesson__chev');
  chev.innerHTML = chevronSvg();
  row.appendChild(badge);
  row.appendChild(main);
  row.appendChild(chev);
  row.addEventListener('click', () => openLesson(lesson.id));
  return row;
}

/** Toggle the active row without re-rendering the whole list (keeps scroll position). */
function markActiveLesson(id) {
  let activeRow = null;
  document.querySelectorAll('#lessons-list .lesson').forEach((row) => {
    const active = !!id && row.dataset.lessonId === id;
    row.classList.toggle('is-active', active);
    row.setAttribute('aria-current', active ? 'true' : 'false');
    if (active) activeRow = row;
  });
  // Deep-link / long modules: keep the selected row in view when the panel opens.
  if (activeRow && prefersLessonSplit()) {
    activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function renderModuleCard(mod) {
  const card = el('section', 'module');

  const header = el('div', 'module__header');
  const heading = el('div', 'module__heading');
  heading.appendChild(el('div', 'module__label', moduleLabel(mod)));
  heading.appendChild(el('div', 'module__title', parseModuleName(moduleName(mod)).name));
  header.appendChild(heading);
  const donut = el('div');
  donut.innerHTML = donutSvg(mod.completed, mod.total);
  header.appendChild(donut.firstElementChild);
  card.appendChild(header);

  const list = el('div', 'module__lessons');
  mod.lessons.forEach((lesson, i) => list.appendChild(renderLessonRow(lesson, i + 1)));
  card.appendChild(list);
  return card;
}

function renderLessons() {
  const list = $('lessons-list');
  if (!lessonModules.length) {
    list.replaceChildren(stateNode(I18N.t('lessons.empty'), I18N.t('lessons.emptyHint')));
    return;
  }
  const frag = document.createDocumentFragment();
  lessonModules.forEach((m) => frag.appendChild(renderModuleCard(m)));
  list.replaceChildren(frag);
}

/**
 * Skeleton modules that reuse the real layout classes (header padding, lesson
 * row flex + badge + two-line main, donut slot) so the list does not jump when
 * data arrives. Only the text/glyph nodes are replaced by sized sk-* blocks.
 */
function lessonSkeletons(n) {
  const frag = document.createDocumentFragment();
  // Vary row counts so the page does not look like three identical clones.
  const rowsPerModule = [4, 3, 2];
  for (let i = 0; i < n; i++) {
    const c = el('section', 'module skeleton');
    c.setAttribute('aria-hidden', 'true');

    const header = el('div', 'module__header');
    const heading = el('div', 'module__heading');
    heading.appendChild(el('div', 'module__label sk-block sk-block--label'));
    heading.appendChild(el('div', 'module__title sk-block sk-block--module-title'));
    header.appendChild(heading);
    header.appendChild(el('div', 'module__donut sk-block sk-block--donut'));
    c.appendChild(header);

    const list = el('div', 'module__lessons');
    const rows = rowsPerModule[i % rowsPerModule.length];
    for (let r = 0; r < rows; r++) {
      const row = el('div', 'lesson lesson--skeleton');
      row.appendChild(el('div', 'lesson__badge sk-block sk-block--badge'));
      const main = el('div', 'lesson__main');
      // Title width varies a bit so rows do not look identical.
      const title = el('div', 'lesson__title sk-block sk-block--lesson-title');
      title.style.width = `${68 + ((i + r) % 3) * 8}%`;
      main.appendChild(title);
      main.appendChild(el('div', 'lesson__date sk-block sk-block--lesson-date'));
      row.appendChild(main);
      row.appendChild(el('span', 'lesson__chev sk-block sk-block--chev'));
      list.appendChild(row);
    }
    c.appendChild(list);
    frag.appendChild(c);
  }
  return frag;
}

function applyLessonsData(data) {
  lessonModules = data.modules || [];
  renderLessons();
}

/** Stale-while-revalidate, same shape as loadFeed(). */
async function loadLessons() {
  if (isPreview()) {
    // Lessons are session-gated end to end (progress is per user), so there is nothing
    // sensible to mock — say so instead of bouncing the previewer to the login screen.
    $('lessons-list').replaceChildren(stateNode(I18N.t('lessons.title'), I18N.t('login.hint')));
    return;
  }

  let showedCache = false;
  try {
    const cached = sessionStorage.getItem(LESSONS_CACHE_KEY());
    if (cached) { applyLessonsData(JSON.parse(cached)); showedCache = true; }
  } catch (e) {}
  if (!showedCache) $('lessons-list').replaceChildren(lessonSkeletons(3));

  let res;
  try {
    res = await authFetch(`/web/lessons?lang=${I18N.notionLang}`);
  } catch (e) {
    if (!showedCache) $('lessons-list').replaceChildren(stateNode(I18N.t('offline.message'), null, loadLessons));
    return;
  }
  if (!res) return; // session expired
  if (!res.ok) {
    if (!showedCache) $('lessons-list').replaceChildren(stateNode(I18N.t('error.title'), I18N.t('error.message'), loadLessons));
    return;
  }
  const data = await res.json();
  cacheLessons(data);
  applyLessonsData(data);
}
function cacheLessons(data) {
  try { sessionStorage.setItem(LESSONS_CACHE_KEY(), JSON.stringify(data)); } catch (e) {}
}

// ── Lesson detail (desktop panel | mobile/tablet modal) ───────────────
// Desktop (≥1024px): master-detail split — index stays visible on the left,
// detail opens as a sticky right panel that pushes the list over. Below that
// breakpoint we keep the existing centered modal so tablets/phones still get
// a full-screen reading surface.

const LESSON_SPLIT_MQ = window.matchMedia('(min-width: 1024px)');
function prefersLessonSplit() { return LESSON_SPLIT_MQ.matches; }

function lessonContentEl() {
  return prefersLessonSplit() ? $('lesson-panel-content') : $('modal-content');
}

function openLessonPanel() {
  const view = $('view-lessons');
  const panel = $('lesson-panel');
  syncLessonPanelChrome(); // re-measure in case the lang banner appeared mid-session
  view.classList.add('is-lesson-open');
  panel.setAttribute('aria-hidden', 'false');
}

function closeLessonPanel() {
  const view = $('view-lessons');
  const panel = $('lesson-panel');
  if (!view || !panel) return;
  view.classList.remove('is-lesson-open');
  panel.setAttribute('aria-hidden', 'true');
  // Drop heavy content so a closed panel is not holding images/iframes.
  $('lesson-panel-content').replaceChildren();
}

function lessonBadgeText(lesson) {
  const mod = lessonModules.find((m) => m.lessons.some((l) => l.id === lesson.id));
  const name = parseModuleName(mod ? moduleName(mod) : lesson.modulo).name;
  const number = mod ? mod.lessons.findIndex((l) => l.id === lesson.id) + 1 : 1;
  return I18N.t('lessons.moduleBadge', { modulo: name, number });
}

function renderCompleteButton(completed) {
  const label = I18N.t(completed ? 'lessons.markUndone' : 'lessons.markDone');
  // Keep both surfaces in sync — only one is visible at a time, but resize can
  // migrate a lesson between panel and modal without a re-fetch.
  for (const id of ['modal-complete', 'lesson-panel-complete']) {
    const btn = $(id);
    if (!btn) continue;
    btn.classList.toggle('is-done', !!completed);
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
}

function renderLessonModal(lesson) {
  const c = lessonContentEl();
  c.replaceChildren();
  if (lesson.cover) {
    c.appendChild(progressiveImgEl(lesson.cover, 'modal__cover', {
      fullWidth: 800,
      thumbWidth: 40,
      thumbUrl: lesson.thumbnail || null,
    }));
  }
  const body = el('div', 'modal__body');
  body.appendChild(el('div', 'lesson-pill', lessonBadgeText(lesson)));
  body.appendChild(el('h1', 'modal__title', lesson.title || ''));
  const content = el('div', 'modal__content');
  content.innerHTML = renderBlocks(lesson.blocks || [], true);
  body.appendChild(content);
  c.appendChild(body);
  c.scrollTop = 0;
  renderCompleteButton(lesson.completed);
  hydrateBookmarks(content);
  hydrateLazyImages(content);
  hydrateWidgets(content);
}

/**
 * Present the lesson on the surface that fits the viewport. Desktop → right
 * panel (no body scroll lock). Tablet/mobile → shared modal. Crossing the
 * breakpoint mid-read re-calls this with fromPop so history is left alone.
 */
function presentLessonSurface() {
  if (prefersLessonSplit()) {
    // Leaving the modal path (e.g. resize up from tablet) — no close animation.
    const m = $('modal');
    if (!m.classList.contains('hidden') && !currentPostId) {
      cancelOverlayClose(m);
      m.classList.add('hidden');
      unlockBodyScrollIfIdle();
    }
    $('modal-complete').classList.add('hidden');
    openLessonPanel();
  } else {
    closeLessonPanel();
    openModal();
    $('modal-complete').classList.remove('hidden'); // share stays visible: lessons are shareable too
  }
}

async function openLesson(id, fromPop) {
  const prevId = currentLessonId;
  currentLessonId = id;
  currentPostId = null;
  if (!fromPop) history.pushState({ lesson: id }, '', `?lesson=${encodeURIComponent(id)}`);
  presentLessonSurface();
  markActiveLesson(id);

  const c = lessonContentEl();
  if (lessonCache[id]) { renderLessonModal(lessonCache[id]); return; }
  // Show a spinner when opening a different lesson (or an empty surface) so the
  // user is not reading the previous body while we fetch.
  if (prevId !== id || !c.childElementCount) c.innerHTML = '<div class="spinner"></div>';
  try {
    const res = await authFetch(`/web/lesson?id=${encodeURIComponent(id)}`);
    if (!res) return; // session expired
    if (!res.ok) throw new Error();
    const lesson = await res.json();
    lessonCache[id] = lesson;
    if (currentLessonId === id) renderLessonModal(lesson); // ignore if another was opened meanwhile
  } catch (e) {
    if (currentLessonId === id) {
      lessonContentEl().innerHTML = `<div class="modal__state">${I18N.t('lessons.error')}</div>`;
    }
  }
}

/** Migrate an open lesson between panel and modal when the viewport crosses 1024px. */
function onLessonSplitChange() {
  if (!currentLessonId) return;
  presentLessonSurface();
  if (lessonCache[currentLessonId]) renderLessonModal(lessonCache[currentLessonId]);
  else openLesson(currentLessonId, true);
}
if (typeof LESSON_SPLIT_MQ.addEventListener === 'function') {
  LESSON_SPLIT_MQ.addEventListener('change', onLessonSplitChange);
} else if (typeof LESSON_SPLIT_MQ.addListener === 'function') {
  LESSON_SPLIT_MQ.addListener(onLessonSplitChange); // Safari < 14
}

/** Flip completion everywhere it shows: modal button, module donut, row badge, caches. */
function setLessonCompleted(id, completed) {
  if (lessonCache[id]) lessonCache[id].completed = completed;
  for (const mod of lessonModules) {
    const l = mod.lessons.find((x) => x.id === id);
    if (!l || l.completed === completed) continue;
    l.completed = completed;
    mod.completed += completed ? 1 : -1;
  }
  renderLessons();
  renderCompleteButton(completed);
  // Keep the SWR cache in step — otherwise a reload paints the stale state first.
  cacheLessons({ modules: lessonModules });
}

async function toggleLessonComplete() {
  const id = currentLessonId;
  const lesson = id && lessonCache[id];
  if (!lesson) return;
  const next = !lesson.completed;

  setLessonCompleted(id, next); // optimistic — the donut moves immediately
  try {
    const res = next
      ? await authFetch('/web/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lessonId: id }),
        })
      : await authFetch(`/web/progress?lessonId=${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res) return; // session expired
    if (!res.ok) throw new Error();
    toast(I18N.t(next ? 'lessons.doneToast' : 'lessons.undoneToast'));
  } catch (e) {
    setLessonCompleted(id, !next); // roll back — the server never took it
    toast(I18N.t('lessons.saveError'));
  }
}

// ── View switching (Feed | Estudos | Glossário | DCA | Pos) ───────────
const ALL_VIEWS = ['feed', 'lessons', 'glossary', 'dca', 'pos'];
const VIEW_FADE_MS = 160;
/** View currently painted (may lag `currentView` mid-transition). */
let displayedView = 'feed';
let viewFadeToken = 0;

function viewUrl(view) {
  if (view === 'lessons') return '?view=lessons';
  if (view === 'glossary') return '?view=glossary';
  if (view === 'dca') return '?view=dca';
  if (view === 'pos') return '?view=pos';
  return location.pathname;
}

function viewNode(view) {
  return document.getElementById(`view-${view}`);
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function clearViewFade(el) {
  if (!el) return;
  el.classList.remove('is-view-fade');
  el.style.opacity = '';
}

/** Show exactly one view; clears any in-flight fade styles. */
function showOnlyView(view) {
  for (const name of ALL_VIEWS) {
    const el = viewNode(name);
    if (!el) continue;
    clearViewFade(el);
    el.classList.toggle('hidden', name !== view);
  }
  displayedView = view;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fade out the painted view, swap, fade in the target.
 * Interrupted by a newer setView (token bump) so rapid clicks stay coherent.
 */
async function transitionViews(fromView, toView) {
  const token = ++viewFadeToken;
  const fromEl = viewNode(fromView);
  const toEl = viewNode(toView);
  if (!fromEl || !toEl || fromView === toView) {
    showOnlyView(toView);
    return;
  }
  if (prefersReducedMotion()) {
    showOnlyView(toView);
    return;
  }

  // Fade out current page
  fromEl.classList.add('is-view-fade');
  // Ensure the transition applies (opacity is currently 1 / default)
  void fromEl.offsetWidth;
  fromEl.style.opacity = '0';
  await waitMs(VIEW_FADE_MS);
  if (token !== viewFadeToken) return;

  clearViewFade(fromEl);
  fromEl.classList.add('hidden');
  toEl.classList.remove('hidden');
  clearViewFade(toEl);
  toEl.classList.add('is-view-fade');
  toEl.style.opacity = '0';
  displayedView = toView;

  // Fade in next page
  void toEl.offsetWidth;
  toEl.style.opacity = '1';
  await waitMs(VIEW_FADE_MS);
  if (token !== viewFadeToken) return;
  clearViewFade(toEl);
}

function setView(view, fromPop) {
  const leavingLessons = currentView === 'lessons' && view !== 'lessons';
  const leavingGlossary = currentView === 'glossary' && view !== 'glossary';
  const leavingDca = currentView === 'dca' && view !== 'dca';
  const leavingPos = currentView === 'pos' && view !== 'pos';
  const fromPainted = displayedView;
  const samePainted = fromPainted === view;

  currentView = view;

  syncNavActive(view);
  closeSidebarDrawer(); // phone/tablet: close overlay after a nav choice
  if (!fromPop) history.pushState({ view }, '', viewUrl(view));
  if (view === 'lessons' && !lessonModules.length) loadLessons();
  if (view === 'glossary') loadGlossaryPage();
  if (view === 'dca') loadDcaPage();
  if (view === 'pos') loadPosPage();
  if (leavingGlossary) {
    glossarySearchQuery = '';
    const search = $('glossary-search');
    if (search) search.value = '';
    hideGlossaryTooltip();
  }
  if (leavingDca || leavingPos) closeCalcSheet();
  // Leaving Estudos via the sidebar must tear down any open lesson (panel or
  // modal). URL is already view-only above; skip another history push.
  if (leavingLessons && (currentLessonId || $('view-lessons').classList.contains('is-lesson-open'))) {
    currentLessonId = null;
    closeLessonPanel();
    markActiveLesson(null);
    if (!$('modal').classList.contains('hidden') && !currentPostId) {
      const m = $('modal');
      cancelOverlayClose(m);
      m.classList.add('hidden');
      $('modal-complete').classList.add('hidden');
      unlockBodyScrollIfIdle();
    }
  }

  // Boot / same painted view → snap (and cancel any in-flight fade that
  // was still leaving this page). Otherwise fade out → in.
  if (samePainted) {
    viewFadeToken += 1;
    showOnlyView(view);
    return;
  }
  transitionViews(fromPainted, view);
}

/**
 * Make the UI match the URL. Single entry point for boot and for the back button, so
 * the view and the modal can never disagree with the address bar.
 */
function syncFromUrl() {
  const params = new URLSearchParams(location.search);
  const post = params.get('post');
  const lesson = params.get('lesson');
  const viewParam = params.get('view');

  let view = 'feed';
  if (lesson || viewParam === 'lessons') view = 'lessons';
  else if (viewParam === 'glossary') view = 'glossary';
  else if (viewParam === 'dca') view = 'dca';
  else if (viewParam === 'pos') view = 'pos';
  setView(view, true);

  if (post) { openPost(post, true); return; }
  if (lesson) { openLesson(lesson, true); return; }
  closeModal(true);
}

// ── Glossary page (app GlossarySlide) ─────────────────────────────────
const GLOSSARY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');

function groupTermsByLetter(terms) {
  const map = new Map();
  for (const term of terms) {
    const first = (term.termo || '').charAt(0).toUpperCase();
    const letter = /[A-Z]/.test(first) ? first : '#';
    if (!map.has(letter)) map.set(letter, []);
    map.get(letter).push(term);
  }
  return Array.from(map.entries())
    .map(([letter, letterTerms]) => ({
      letter,
      terms: letterTerms.slice().sort((a, b) =>
        a.termo.localeCompare(b.termo, 'pt-BR', { sensitivity: 'base' })),
    }))
    .sort((a, b) => {
      if (a.letter === '#') return 1;
      if (b.letter === '#') return -1;
      return a.letter.localeCompare(b.letter);
    });
}

function filterGlossaryTerms(terms, query) {
  if (!query || !query.trim()) return terms;
  const q = query.toLowerCase().trim();
  return terms.filter(
    (t) =>
      (t.termo && t.termo.toLowerCase().includes(q)) ||
      (t.definicao && t.definicao.toLowerCase().includes(q)),
  );
}

function highlightSearchText(text, query) {
  if (!query || !query.trim()) return escapeHtml(text);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  return escapeHtml(text).replace(re, '<mark>$1</mark>');
}

function glossarySkeletonHtml() {
  let html = '<div class="glossary-skel" aria-hidden="true">';
  for (let i = 0; i < 3; i++) {
    html +=
      `<div class="glossary-skel__section">` +
        `<div class="glossary-skel__letter"></div>` +
        `<div class="glossary-skel__card">` +
          `<div class="glossary-skel__term"></div>` +
          `<div class="glossary-skel__def"></div>` +
        `</div>` +
      `</div>`;
  }
  return html + '</div>';
}

function glossarySearchPlaceholder(totalCount) {
  const n = typeof totalCount === 'number' ? totalCount : 0;
  const key = n === 1 ? 'glossary.searchPlaceholderOne' : 'glossary.searchPlaceholder';
  return I18N.t(key, { count: n });
}

function renderGlossaryPage() {
  const list = $('glossary-list');
  const titleEl = $('glossary-title');
  const search = $('glossary-search');
  const clearBtn = $('glossary-search-clear');
  const alpha = $('glossary-alpha');
  if (!list) return;

  if (titleEl) titleEl.textContent = I18N.t('glossary.title');
  const termTotal = glossaryTerms.length;
  if (search) {
    const ph = glossarySearchPlaceholder(termTotal);
    search.placeholder = ph;
    search.setAttribute('aria-label', ph);
  }

  const q = glossarySearchQuery;
  if (clearBtn) clearBtn.classList.toggle('hidden', !q);

  const filtered = filterGlossaryTerms(glossaryTerms, q);
  const groups = groupTermsByLetter(filtered);

  if (!glossaryTerms.length && glossaryLoadedLang !== I18N.notionLang) {
    list.innerHTML = glossarySkeletonHtml();
    if (alpha) alpha.hidden = true;
    return;
  }

  if (!groups.length) {
    const msg = q.trim()
      ? I18N.t('glossary.empty.search', { query: q.trim() })
      : I18N.t('glossary.empty.default');
    list.innerHTML =
      `<div class="glossary-empty">` +
        `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3-3"/></svg>` +
        `<p>${escapeHtml(msg)}</p>` +
      `</div>`;
    if (alpha) alpha.hidden = true;
    return;
  }

  let html = '';
  for (const group of groups) {
    html +=
      `<section class="glossary-section" data-letter="${escapeHtml(group.letter)}" id="glossary-letter-${escapeHtml(group.letter)}">` +
        `<div class="glossary-section__letter">${escapeHtml(group.letter)}</div>` +
        `<div class="glossary-section__card">`;
    group.terms.forEach((term) => {
      html +=
        `<div class="glossary-term-item">` +
          `<div class="glossary-term-item__name">${highlightSearchText(term.termo, q)}</div>` +
          `<div class="glossary-term-item__def">${highlightSearchText(term.definicao, q)}</div>` +
        `</div>`;
    });
    html += `</div></section>`;
  }
  list.innerHTML = html;

  // Alphabet rail — only when not searching
  if (alpha) {
    if (q.trim()) {
      alpha.hidden = true;
    } else {
      const available = new Set(groups.map((g) => g.letter));
      alpha.hidden = false;
      alpha.innerHTML = GLOSSARY_ALPHABET.map((letter) => {
        const avail = available.has(letter);
        return (
          `<button type="button" class="glossary__alpha-btn${avail ? ' is-available' : ''}" ` +
          `data-letter="${letter}" ${avail ? '' : 'disabled'} aria-label="${letter}">` +
            `<span class="glossary__alpha-bubble" aria-hidden="true"></span>` +
            `<span class="glossary__alpha-char">${letter}</span>` +
          `</button>`
        );
      }).join('');
      // Restore scroll-spy highlight after re-render
      requestAnimationFrame(updateGlossaryScrollSpy);
    }
  }
}

async function loadGlossaryPage() {
  const list = $('glossary-list');
  if (list && !glossaryTerms.length) list.innerHTML = glossarySkeletonHtml();
  renderGlossaryStatic();
  // Force retry when we previously failed (no loaded lang / empty after error).
  await ensureGlossaryLoaded({ force: !glossaryTerms.length });
  renderGlossaryPage();
}

function renderGlossaryStatic() {
  const titleEl = $('glossary-title');
  if (titleEl) titleEl.textContent = I18N.t('glossary.title');
  const search = $('glossary-search');
  if (search) {
    const ph = glossarySearchPlaceholder(glossaryTerms.length);
    search.placeholder = ph;
    search.setAttribute('aria-label', ph);
  }
}

/** Offset from top of viewport for alphabet jump targets. */
function glossaryScrollOffset() {
  const topbarH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 0;
  const bannerH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lang-banner-h')) || 0;
  // Small breathing room under the fixed chrome (sidebar/banner).
  return topbarH + bannerH + 12;
}

function scrollToGlossaryLetter(letter, opts) {
  const section = document.getElementById(`glossary-letter-${letter}`);
  if (!section) return;
  const smooth = !(opts && opts.instant);
  const y = section.getBoundingClientRect().top + window.scrollY - glossaryScrollOffset();
  window.scrollTo({ top: Math.max(0, y), behavior: smooth ? 'smooth' : 'auto' });

  // Keep a stable "last jumped-to" highlight until scroll-spy takes over
  document.querySelectorAll('.glossary__alpha-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.letter === letter);
  });
}

/**
 * Scroll spy — mark the letter whose section is currently at the top
 * (app AlphabetIndex `visibleLetter` / isVisibleSection).
 */
function updateGlossaryScrollSpy() {
  if (currentView !== 'glossary') return;
  const alpha = $('glossary-alpha');
  if (!alpha || alpha.hidden) return;
  const sections = [...document.querySelectorAll('.glossary-section[data-letter]')];
  if (!sections.length) return;

  const marker = glossaryScrollOffset() + 4;
  let current = sections[0].dataset.letter;
  for (const sec of sections) {
    if (sec.getBoundingClientRect().top <= marker) current = sec.dataset.letter;
    else break;
  }

  alpha.querySelectorAll('.glossary__alpha-btn').forEach((b) => {
    b.classList.toggle('is-current', b.dataset.letter === current);
  });
}

/** Map a Y coordinate on the rail to a letter button (evenly spaced flex slots). */
function glossaryAlphaBtnFromY(clientY) {
  const alpha = $('glossary-alpha');
  if (!alpha) return null;
  const buttons = alpha.querySelectorAll('.glossary__alpha-btn');
  if (!buttons.length) return null;
  const rect = alpha.getBoundingClientRect();
  if (rect.height <= 0) return buttons[0];
  const rel = Math.max(0, Math.min(rect.height - 0.001, clientY - rect.top));
  const idx = Math.min(buttons.length - 1, Math.floor((rel / rect.height) * buttons.length));
  return buttons[idx];
}

function setGlossaryAlphaPressed(btn) {
  const alpha = $('glossary-alpha');
  if (!alpha) return;
  alpha.querySelectorAll('.glossary__alpha-btn.is-pressed').forEach((b) => {
    if (b !== btn) b.classList.remove('is-pressed');
  });
  if (btn) btn.classList.add('is-pressed');
}

function clearGlossaryAlphaPressed() {
  document.querySelectorAll('.glossary__alpha-btn.is-pressed').forEach((b) => {
    b.classList.remove('is-pressed');
  });
}

/** Scrub interaction — press + drag along the rail (app Pan gesture). */
let glossaryAlphaScrubbing = false;
let glossaryAlphaLastLetter = null;

function onGlossaryAlphaPointerDown(e) {
  const alpha = $('glossary-alpha');
  if (!alpha || alpha.hidden) return;
  // Only primary button / touch
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  glossaryAlphaScrubbing = true;
  glossaryAlphaLastLetter = null;
  try { alpha.setPointerCapture(e.pointerId); } catch (err) {}
  handleGlossaryAlphaScrub(e.clientY, true);
  e.preventDefault();
}

function onGlossaryAlphaPointerMove(e) {
  if (!glossaryAlphaScrubbing) return;
  handleGlossaryAlphaScrub(e.clientY, false);
  e.preventDefault();
}

function onGlossaryAlphaPointerUp(e) {
  if (!glossaryAlphaScrubbing) return;
  glossaryAlphaScrubbing = false;
  glossaryAlphaLastLetter = null;
  clearGlossaryAlphaPressed();
  // Let scroll-spy own the highlight after release
  requestAnimationFrame(updateGlossaryScrollSpy);
}

function handleGlossaryAlphaScrub(clientY, isStart) {
  const btn = glossaryAlphaBtnFromY(clientY);
  if (!btn) return;
  setGlossaryAlphaPressed(btn);
  const letter = btn.dataset.letter;
  const available = btn.classList.contains('is-available');
  // Animate every letter (available or not), scroll only when available — app parity
  if (available && letter !== glossaryAlphaLastLetter) {
    glossaryAlphaLastLetter = letter;
    // Smooth on first press; instant while dragging so the list tracks the finger
    scrollToGlossaryLetter(letter, { instant: !isStart });
  }
}

// ── Preview (localhost, no real session) ──────────────────────────────
function mockCover(from, to, glyph) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='560' height='360'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${from}'/><stop offset='1' stop-color='${to}'/></linearGradient></defs><rect width='560' height='360' fill='url(#g)'/><text x='50%' y='56%' font-size='120' text-anchor='middle' fill='rgba(255,255,255,.9)'>${glyph}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}
function loadPreviewFeed() {
  const h2 = new Date(Date.now() - 2 * 3600000).toISOString();
  const d1 = new Date(Date.now() - 26 * 3600000).toISOString();
  feedTags = [
    { name: 'Notícias', color: 'blue' }, { name: 'Análises', color: 'purple' },
    { name: 'Trade', color: 'green' }, { name: 'Bitcoin', color: 'orange' },
  ];
  feedPosts = [
    {
      id: 'm1', title: 'Bitcoin rompe resistência e mira nova máxima', icon: '🚀',
      cover: mockCover('#F15B24', '#B53D15', '₿'), author: { name: 'Crypto Bros', avatar: null },
      tags: [{ name: 'Notícias', color: 'blue' }], publishedAt: h2, hasDivider: true, excerpt: '',
      previewBlocks: [
        { type: 'paragraph', paragraph: { rich_text: [
          { plain_text: 'O par ', annotations: {} }, { plain_text: 'BTC/USD', annotations: { bold: true } },
          { plain_text: ' superou os US$ 72 mil com volume crescente.', annotations: {} }] } },
        { type: 'heading_3', heading_3: { rich_text: [{ plain_text: 'Pontos-chave', annotations: {} }] } },
        { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Rompimento com volume acima da média', annotations: {} }] } },
        { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Fundamentos on-chain sólidos', annotations: {} }] } },
        { type: 'divider', divider: {} },
        { type: 'image', image: { external: { url: mockCover('#1F2937', '#111827', '📈') }, caption: [{ plain_text: 'BTC/USD no gráfico diário', annotations: {} }] } },
        { type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Níveis importantes', annotations: {} }] } },
        { type: 'table', table: { has_column_header: true }, children: [
          { type: 'table_row', table_row: { cells: [[{ plain_text: 'Nível', annotations: {} }], [{ plain_text: 'Preço', annotations: {} }]] } },
          { type: 'table_row', table_row: { cells: [[{ plain_text: 'Suporte', annotations: {} }], [{ plain_text: 'US$ 68.000', annotations: {} }]] } },
          { type: 'table_row', table_row: { cells: [[{ plain_text: 'Resistência', annotations: {} }], [{ plain_text: 'US$ 72.500', annotations: {} }]] } },
        ] },
        { type: 'column_list', column_list: {}, children: [
          { type: 'column', column: {}, children: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Cenário otimista: continuação até novas máximas.', annotations: {} }] } }] },
          { type: 'column', column: {}, children: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Cenário de risco: reteste do suporte em 68k.', annotations: {} }] } }] },
        ] },
        { type: 'bookmark', bookmark: { url: 'https://cryptobros.com', caption: [{ plain_text: 'Leia a análise completa', annotations: {} }] } },
      ],
    },
    {
      id: 'm2', title: 'Entendendo liquidez em pools automatizadas', icon: '📚',
      cover: mockCover('#8B5CF6', '#6D28D9', '📊'), author: { name: 'Vini Ramos', avatar: null },
      tags: [{ name: 'Análises', color: 'purple' }], publishedAt: d1, hasDivider: false,
      excerpt: 'Um guia direto sobre AMMs, impermanent loss e como avaliar o risco real de prover liquidez em protocolos descentralizados.',
      previewBlocks: [],
    },
    {
      id: 'm3', title: '[LONG] Setup de continuação no gráfico de 4h', icon: '📈',
      cover: null, author: { name: 'Crypto Bros', avatar: null },
      tags: [{ name: 'Trade', color: 'green' }], publishedAt: d1, hasDivider: true, excerpt: '',
      previewBlocks: [
        { type: 'callout', callout: { icon: { emoji: '⚠️' }, rich_text: [{ plain_text: 'Não é recomendação de investimento.', annotations: { italic: true } }] } },
        { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Estrutura de alta preservada, pullback na média de 50 e gatilho acima do topo anterior.', annotations: {} }] } },
      ],
    },
  ];
  feedHistory = Array.from({ length: 8 }, (_, i) => ({
    id: 'h' + i, title: `Post do histórico #${i + 1} — análise de mercado`,
    // index 0 uses an image (custom-emoji/file style); the rest use standard emojis
    icon: i === 0 ? { url: './icon.png' } : { emoji: ['📰', '📉', '🧠', '🪙', '⚡'][i % 5] },
    publishedAt: new Date(Date.now() - (i + 2) * 86400000).toISOString(),
  }));
  selectedTag = 'all';
  historyPage = 0;
  renderTags();
  renderFeed();
}

// ── iOS App Store banner ──────────────────────────────────────────────
function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream; }
function isStandalone() {
  return navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
}
function isIOSSafari() {
  const ua = navigator.userAgent;
  return isIOS() && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}
function maybeShowIosBanner() {
  if (!isIOS() || isStandalone() || localStorage.getItem('cb-banner-dismissed')) return;
  if (isIOSSafari()) return; // native apple-itunes-app smart banner handles Safari

  $('ios-banner-sub').textContent = I18N.t('banner.install');
  const cta = $('ios-banner-cta');
  cta.textContent = I18N.t('banner.cta');
  cta.href = CONFIG.appStoreUrl;
  $('ios-banner').classList.remove('hidden');
}

// ── Web push ──────────────────────────────────────────────────────────
function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function getPushSubscription() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  } catch (e) {
    return null;
  }
}
async function updateNotifButton() {
  const sw = $('menu-notif');
  const row = $('menu-notif-row');
  const label = $('menu-notif-label');
  if (!sw || !row) return;
  if (!pushSupported()) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');

  if (Notification.permission === 'denied') {
    const text = I18N.t('notif.blocked');
    if (label) label.textContent = text;
    sw.setAttribute('aria-checked', 'false');
    row.disabled = true;
    row.setAttribute('aria-label', text);
    return;
  }

  row.disabled = false;
  const sub = await getPushSubscription();
  const on = !!sub;
  const text = I18N.t(on ? 'notif.enabled' : 'notif.enable');
  if (label) label.textContent = I18N.t('menu.notifications');
  sw.setAttribute('aria-checked', on ? 'true' : 'false');
  row.setAttribute('aria-label', text);
  row.setAttribute('aria-pressed', on ? 'true' : 'false');
}
async function enableNotifications() {
  if (!pushSupported()) return;
  const row = $('menu-notif-row');
  if (row && row.disabled) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    try { const c = await caches.open('cb-cfg'); await c.put('cb-lang', new Response(I18N.lang)); } catch (e) {}
    if (await reg.pushManager.getSubscription()) { toast(I18N.t('notif.enabled')); return updateNotifButton(); }
    if ((await Notification.requestPermission()) !== 'granted') return updateNotifButton();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: urlB64ToUint8(CONFIG.vapidPublicKey),
    });
    await fetch(`${CONFIG.workerBase}/web/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getSession()}` },
      body: JSON.stringify({ subscription: sub, lang: I18N.notionLang }),
    });
    toast(I18N.t('notif.enabled'));
  } catch (e) { /* permission denied / unsupported */ }
  updateNotifButton();
}
async function disableNotifications() {
  if (!pushSupported()) return;
  try {
    const sub = await getPushSubscription();
    if (sub) {
      try {
        await fetch(`${CONFIG.workerBase}/web/push/unsubscribe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getSession()}` },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
      } catch (e) { /* best-effort */ }
      await sub.unsubscribe();
    }
  } catch (e) { /* ignore */ }
  updateNotifButton();
}
async function onNotifSwitchClick() {
  const sw = $('menu-notif');
  const row = $('menu-notif-row');
  if (!sw || (row && row.disabled)) return;
  const on = sw.getAttribute('aria-checked') === 'true';
  if (on) await disableNotifications();
  else await enableNotifications();
}

// ── Calculators (app DCASimulatorSlide + PositionCalculatorSlide) ─────
// Fields, formulas, bundled chart source, and DCA chart colors/entrance
// match the mobile app 1:1.

/** Coins available in CoinDropdown / CoinPickerList (app SYMBOL_TO_COINGECKO). */
const CALC_COINS = [
  ...MARKET_COINS,
  { id: 'pax-gold', sym: 'GOLD' },
  { id: 'kinesis-silver', sym: 'SILVER' },
].slice().sort((a, b) => a.sym.localeCompare(b.sym));

const DEFAULT_TAKER_FEE = 0.00055; // Bybit VIP 0
const DEFAULT_MAKER_FEE = 0.0002;
const RESULT_CARD_STAGGER = 120;
const DCA_CHART_H = 180;
// Right pad leaves a gutter for Y-axis labels so lines never cover them.
const DCA_PAD = { top: 32, right: 48, bottom: 32, left: 12 };
const POST_DCA_OPACITY = 0.35;
const DCA_DRAW_MS = 800;
const DCA_AVG_DRAW_MS = 1000;
const POS_STORAGE = {
  wallet: 'posCalc_walletSize',
  lossPct: 'posCalc_maxLossPercent',
  lossDollar: 'posCalc_maxLossDollar',
  lastEdit: 'posCalc_lastLossEdit',
};

const dcaState = {
  coinId: 'bitcoin',
  amount: '100',
  frequency: 'monthly', // daily | weekly | monthly
  years: '3',
  startDate: null, // Date
  chartData: [],
  results: null,
  chartGeom: null,
  scrub: null,
  cancelDraw: null,
  chartRo: null, // ResizeObserver on #dca-chart-host
  lastPaintW: 0,
};

const posState = {
  walletSize: '',
  maxLossPercent: '',
  maxLossDollar: '',
  stopLossDistance: '',
  leverage: '10',
  lastLossEdit: null, // 'percent' | 'dollar'
  openFeeType: 'market',
  closeFeeType: 'market',
};

const MONTH_NAMES_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const MONTH_NAMES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isCalcOpen(which) {
  return currentView === which;
}

function calcCoinSym(id) {
  const hit = CALC_COINS.find((c) => c.id === id);
  return hit ? hit.sym : (id || '').toUpperCase();
}

function calcCoinIconSrc(sym) {
  // Stables + metals only ship as ticker SVGs; everything else keeps the webp set.
  if (isStablecoinRef(sym) || sym === 'GOLD' || sym === 'SILVER') return tickerUrl(sym);
  return `./assets/crypto/${sym}.webp`;
}

function binarySearchFloor(sorted, target, getKey) {
  let lo = 0;
  let hi = sorted.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const key = getKey(sorted[mid]);
    if (key <= target) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

function linearSvgPath(points) {
  if (!points || points.length < 2) return '';
  let d = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L${points[i].x.toFixed(2)},${points[i].y.toFixed(2)}`;
  }
  return d;
}

function formatDcaAxisPrice(price) {
  if (price >= 10000) return `$${(price / 1000).toFixed(0)}k`;
  if (price >= 1000) return `$${(price / 1000).toFixed(1)}k`;
  if (price >= 100) return `$${price.toFixed(0)}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(4)}`;
}

function formatCalcMoney(n, decimals = 2) {
  if (n == null || !isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * DCA calculation — verbatim port of calculateDCA in DCASimulatorSlide.tsx.
 * Series comes from loadDcaChartData (bundle + /chart-delta + CoinGecko gap-fill).
 */
function calculateDCA(dailyData, amount, frequency, startDate, years) {
  if (!dailyData.length || amount <= 0 || years <= 0) return null;
  const sortedData = dailyData;

  const endDate = new Date(startDate);
  endDate.setFullYear(endDate.getFullYear() + years);

  const startTs = new Date(Date.UTC(
    startDate.getFullYear(), startDate.getMonth(), startDate.getDate()
  )).getTime();
  const endTs = Math.min(
    new Date(Date.UTC(
      endDate.getFullYear(), endDate.getMonth(), endDate.getDate()
    )).getTime(),
    Date.now()
  );

  const dataInRange = sortedData.filter((p) => p.t >= startTs && p.t <= endTs);
  if (dataInRange.length === 0) return null;

  const getNextPurchaseDate = (current, freq, originalDay) => {
    const next = new Date(current);
    switch (freq) {
      case 'daily': next.setDate(next.getDate() + 1); break;
      case 'weekly': next.setDate(next.getDate() + 7); break;
      case 'monthly': {
        next.setMonth(next.getMonth() + 1);
        const lastDayOfMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
        next.setDate(Math.min(originalDay, lastDayOfMonth));
        break;
      }
    }
    return next;
  };

  const priceByDate = new Map();
  dataInRange.forEach((p) => {
    const date = new Date(p.t);
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
    priceByDate.set(key, p.c);
  });

  const findPrice = (date) => {
    const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
    if (priceByDate.has(key)) return priceByDate.get(key);
    const ts = date.getTime();
    const idx = binarySearchFloor(dataInRange, ts, (p) => p.t);
    return idx >= 0 ? dataInRange[idx].c : null;
  };

  let totalInvested = 0;
  let totalCoins = 0;
  let numPurchases = 0;
  const purchases = [];
  const originalDay = startDate.getDate();
  let currentDate = new Date(startDate);

  while (currentDate.getTime() <= endTs) {
    const price = findPrice(currentDate);
    if (price !== null && price > 0) {
      const coins = amount / price;
      totalCoins += coins;
      totalInvested += amount;
      numPurchases++;
      purchases.push({
        timestamp: currentDate.getTime(),
        price,
        runningAvgPrice: totalInvested / totalCoins,
        cumulativeInvested: totalInvested,
        cumulativeCoins: totalCoins,
      });
    }
    currentDate = getNextPurchaseDate(currentDate, frequency, originalDay);
  }

  if (totalInvested === 0 || totalCoins === 0) return null;

  const lastDataPoint = sortedData[sortedData.length - 1];
  const currentPrice = lastDataPoint.c;
  const currentValue = totalCoins * currentPrice;
  const averagePrice = totalInvested / totalCoins;
  const profitLoss = currentValue - totalInvested;
  const profitLossPercent = (profitLoss / totalInvested) * 100;

  return {
    totalInvested, currentValue, totalCoins, averagePrice, currentPrice,
    profitLoss, profitLossPercent, numPurchases, purchases, priceData: dataInRange,
  };
}

/** Position sizing — verbatim from PositionCalculatorSlide.tsx results useMemo. */
function calculatePosition(wallet, lossPercent, stopDist, lev, openFeeRate, closeFeeRate) {
  if (!(wallet > 0) || !(lossPercent > 0) || !(stopDist > 0) || !(lev > 0)) return null;
  const maxLoss = (wallet * lossPercent) / 100;
  const positionValue = maxLoss / (stopDist / 100 + openFeeRate + closeFeeRate);
  const cost = positionValue / lev;
  const openFee = positionValue * openFeeRate;
  const closeFee = positionValue * closeFeeRate;
  const totalFees = openFee + closeFee;
  const stopLoss = positionValue * (stopDist / 100);
  return { positionValue, cost, maxLoss, stopLoss, openFee, closeFee, totalFees };
}

// ── Nested form sheet / popover / modal ──────────────────────────────
// presentation:
//   'sheet'   — bottom sheet (phone default)
//   'popover' — anchored floating panel (tablet/desktop pickers)
//   'modal'   — centered dialog (fee config)
//   'auto'    — popover ≥768px, sheet below

function isCalcWideLayout() {
  return window.matchMedia('(min-width: 768px)').matches;
}

function clearCalcSheetPanelPosition(panel) {
  if (!panel) return;
  panel.style.top = '';
  panel.style.left = '';
  panel.style.right = '';
  panel.style.bottom = '';
  panel.style.width = '';
  panel.style.maxHeight = '';
  panel.style.position = '';
}

function positionCalcPopover(panel, anchor) {
  if (!panel || !anchor) return;
  const gap = 8;
  const margin = 12;
  const rect = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const panelW = Math.min(320, vw - margin * 2);
  const maxH = Math.min(420, vh - margin * 2);

  // Measure preferred height (content may be long — cap with maxH)
  panel.style.position = 'fixed';
  panel.style.width = `${panelW}px`;
  panel.style.maxHeight = `${maxH}px`;
  panel.style.visibility = 'hidden';
  panel.style.left = '0';
  panel.style.top = '0';
  const measuredH = Math.min(panel.scrollHeight || maxH, maxH);

  let left = rect.left;
  if (left + panelW > vw - margin) left = vw - margin - panelW;
  if (left < margin) left = margin;

  // Prefer below the trigger; flip above if not enough room
  let top = rect.bottom + gap;
  if (top + measuredH > vh - margin && rect.top - gap - measuredH >= margin) {
    top = rect.top - gap - measuredH;
  } else if (top + measuredH > vh - margin) {
    top = Math.max(margin, vh - margin - measuredH);
  }

  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;
  panel.style.visibility = '';
}

let calcSheetRepositionHandler = null;

function openCalcSheet({ title, html, onMount, presentation = 'sheet', anchor = null }) {
  const root = $('calc-sheet');
  const panel = root.querySelector('.csheet__panel');
  let mode = presentation;
  if (mode === 'auto') mode = isCalcWideLayout() ? 'popover' : 'sheet';
  if (mode === 'popover' && !anchor) mode = isCalcWideLayout() ? 'modal' : 'sheet';

  root.classList.remove('csheet--sheet', 'csheet--popover', 'csheet--modal');
  root.classList.add(`csheet--${mode}`);
  root.dataset.presentation = mode;
  clearCalcSheetPanelPosition(panel);

  $('calc-sheet-title').textContent = title;
  $('calc-sheet-body').innerHTML = html;
  root.classList.remove('hidden');

  if (mode === 'popover' && anchor) {
    positionCalcPopover(panel, anchor);
    if (calcSheetRepositionHandler) {
      window.removeEventListener('resize', calcSheetRepositionHandler);
      window.removeEventListener('scroll', calcSheetRepositionHandler, true);
    }
    calcSheetRepositionHandler = () => {
      if (root.classList.contains('hidden') || root.dataset.presentation !== 'popover') return;
      if (!document.body.contains(anchor)) {
        closeCalcSheet();
        return;
      }
      positionCalcPopover(panel, anchor);
    };
    window.addEventListener('resize', calcSheetRepositionHandler);
    window.addEventListener('scroll', calcSheetRepositionHandler, true);
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => root.classList.add('is-open'));
  });
  if (onMount) onMount($('calc-sheet-body'));
}

function closeCalcSheet() {
  const root = $('calc-sheet');
  if (!root || root.classList.contains('hidden')) return;
  root.classList.remove('is-open');
  if (calcSheetRepositionHandler) {
    window.removeEventListener('resize', calcSheetRepositionHandler);
    window.removeEventListener('scroll', calcSheetRepositionHandler, true);
    calcSheetRepositionHandler = null;
  }
  setTimeout(() => {
    if (!root.classList.contains('is-open')) {
      root.classList.add('hidden');
      root.classList.remove('csheet--sheet', 'csheet--popover', 'csheet--modal');
      clearCalcSheetPanelPosition(root.querySelector('.csheet__panel'));
      $('calc-sheet-body').innerHTML = '';
    }
  }, 280);
}

function openCoinPicker(selectedId, onSelect, anchor) {
  const html = CALC_COINS.map((c) => {
    const sel = c.id === selectedId ? ' is-selected' : '';
    const check = c.id === selectedId
      ? `<svg class="csheet__coin-check" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`
      : '';
    return `<button type="button" class="csheet__coin${sel}" data-coin="${escapeHtml(c.id)}">` +
      `<img src="${calcCoinIconSrc(c.sym)}" alt="" onerror="this.style.visibility='hidden'"/>` +
      `<span class="csheet__coin-sym">${escapeHtml(c.sym)}</span>${check}</button>`;
  }).join('');
  openCalcSheet({
    title: I18N.t('dca.picker.selectCrypto'),
    html,
    presentation: 'auto',
    anchor: anchor || null,
    onMount: (body) => {
      body.querySelectorAll('[data-coin]').forEach((btn) => {
        btn.addEventListener('click', () => {
          onSelect(btn.getAttribute('data-coin'));
          closeCalcSheet();
        });
      });
    },
  });
}

/** Inline month/year (and day when not monthly) for the DCA start date. */
function dcaStartDateControlsHtml() {
  const months = I18N.lang === 'en' ? MONTH_NAMES_EN : MONTH_NAMES_PT;
  const date = dcaState.startDate || defaultDcaStartDate();
  const first = dcaState.chartData[0] ? new Date(dcaState.chartData[0].t) : null;
  const maxDate = new Date();
  const y = date.getFullYear();
  const m = date.getMonth();
  const d = date.getDate();
  const minY = first ? first.getFullYear() : y - 20;
  const maxY = maxDate.getFullYear();
  const monthYearOnly = dcaState.frequency === 'monthly';

  let yearOpts = '';
  for (let i = maxY; i >= minY; i--) {
    yearOpts += `<option value="${i}"${i === y ? ' selected' : ''}>${i}</option>`;
  }
  let monthOpts = '';
  for (let i = 0; i < 12; i++) {
    monthOpts += `<option value="${i}"${i === m ? ' selected' : ''}>${months[i]}</option>`;
  }

  let dayOpts = '';
  if (!monthYearOnly) {
    const lastDay = new Date(y, m + 1, 0).getDate();
    for (let i = 1; i <= lastDay; i++) {
      dayOpts += `<option value="${i}"${i === d ? ' selected' : ''}>${i}</option>`;
    }
  }

  // PT: day/month/year · EN: month/day/year · monthly: month/year
  const monthSel = `<select id="dca-month" class="calc-date-select" aria-label="Month">${monthOpts}</select>`;
  const yearSel = `<select id="dca-year" class="calc-date-select" aria-label="Year">${yearOpts}</select>`;
  const daySel = monthYearOnly
    ? ''
    : `<select id="dca-day" class="calc-date-select" aria-label="Day">${dayOpts}</select>`;

  const order = monthYearOnly
    ? monthSel + yearSel
    : (I18N.lang === 'en' ? monthSel + daySel + yearSel : daySel + monthSel + yearSel);

  return `<div class="calc-date-inline">${order}</div>`;
}

function applyDcaStartDateFromControls(root) {
  const monthEl = root.querySelector('#dca-month');
  const yearEl = root.querySelector('#dca-year');
  if (!monthEl || !yearEl) return;
  const month = parseInt(monthEl.value, 10);
  const year = parseInt(yearEl.value, 10);
  let day = 1;
  const dayEl = root.querySelector('#dca-day');
  if (dayEl) day = parseInt(dayEl.value, 10) || 1;
  else if (dcaState.frequency !== 'monthly' && dcaState.startDate) {
    day = dcaState.startDate.getDate();
  }
  const lastDay = new Date(year, month + 1, 0).getDate();
  day = Math.min(Math.max(1, day), lastDay);
  let next = new Date(year, month, day);
  const first = dcaState.chartData[0] ? new Date(dcaState.chartData[0].t) : null;
  const maxDate = new Date();
  if (first && next < first) next = new Date(first);
  if (next > maxDate) next = new Date(maxDate);
  dcaState.startDate = next;
  const maxYears = dcaMaxYears();
  const yrs = parseInt(dcaState.years, 10);
  if (!isNaN(yrs) && yrs > maxYears && maxYears > 0) dcaState.years = String(maxYears);
  recomputeDcaResults();
  scheduleDcaResultsRefresh();
}

function openFeeConfig() {
  const seg = (name, value) => {
    const mk = (key, label) =>
      `<button type="button" data-fee-group="${name}" data-fee="${key}"` +
      ` class="${value === key ? 'active' : ''}">${escapeHtml(label)}</button>`;
    return `<div class="mm__seg" role="tablist">` +
      mk('market', I18N.t('position.fees.market')) +
      mk('limit', I18N.t('position.fees.limit')) +
      `</div>`;
  };
  const html =
    `<div class="csheet__fee-section">` +
      `<p class="csheet__fee-label">${escapeHtml(I18N.t('position.fees.openPosition'))}</p>` +
      `<p class="csheet__fee-cap">${escapeHtml(I18N.t('position.fees.caption'))}</p>` +
      seg('open', posState.openFeeType) +
    `</div>` +
    `<div class="csheet__fee-section">` +
      `<p class="csheet__fee-label">${escapeHtml(I18N.t('position.fees.closePosition'))}</p>` +
      `<p class="csheet__fee-cap">${escapeHtml(I18N.t('position.fees.caption'))}</p>` +
      seg('close', posState.closeFeeType) +
    `</div>` +
    `<div class="calc-note">` +
      `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>` +
      `<span>${escapeHtml(I18N.t('position.fees.modalNote'))}</span>` +
    `</div>`;
  openCalcSheet({
    title: I18N.t('position.fees.configTitle'),
    html,
    presentation: 'modal',
    onMount: (body) => {
      body.querySelectorAll('[data-fee]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const group = btn.getAttribute('data-fee-group');
          const fee = btn.getAttribute('data-fee');
          if (group === 'open') posState.openFeeType = fee;
          else posState.closeFeeType = fee;
          body.querySelectorAll(`[data-fee-group="${group}"]`).forEach((b) =>
            b.classList.toggle('active', b.getAttribute('data-fee') === fee));
          renderPosBody();
        });
      });
    },
  });
}

// ── Shared field helpers ─────────────────────────────────────────────
function calcFieldHtml({ id, label, value, placeholder, prefix, suffix, smallLabel, flex, hint, type = 'text' }) {
  const flexCls = flex ? ' flex' : '';
  const labCls = smallLabel ? ' calc-field__label--sm' : '';
  return `<div class="calc-field${flexCls}" data-field="${id}">` +
    (label != null ? `<label class="calc-field__label${labCls}" for="cf-${id}">${escapeHtml(label)}</label>` : '') +
    `<div class="calc-field__row">` +
      (prefix != null ? `<span class="calc-field__prefix">${escapeHtml(prefix)}</span>` : '') +
      `<input class="calc-field__input" id="cf-${id}" type="${type}" inputmode="decimal" ` +
        `value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder || '')}" autocomplete="off"/>` +
      (suffix != null ? `<span class="calc-field__suffix" data-suffix="${id}">${escapeHtml(suffix)}</span>` : '') +
    `</div>` +
    (hint ? `<span class="calc-field__hint">${escapeHtml(hint)}</span>` : '') +
  `</div>`;
}

function resultRowHtml({ label, value, prefix = '$ ', suffix = '', caption, tone, decimals = 2 }) {
  const toneCls = tone === 'accent' ? ' is-accent'
    : tone === 'success' ? ' is-success'
    : tone === 'danger' ? ' is-danger' : '';
  const num = typeof value === 'number' ? formatCalcMoney(value, decimals) : value;
  return `<div class="calc-row">` +
    `<div class="calc-row__label">` +
      `<div class="calc-row__label-main">${escapeHtml(label)}</div>` +
      (caption ? `<div class="calc-row__label-cap">${escapeHtml(caption)}</div>` : '') +
    `</div>` +
    `<div class="calc-row__value${toneCls}">${escapeHtml(prefix)}${escapeHtml(num)}${escapeHtml(suffix)}</div>` +
  `</div>`;
}

function resultDividerHtml() {
  return `<div class="calc-divider"></div>`;
}

function defaultDcaStartDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  return d;
}

function dcaFrequencySuffix() {
  if (dcaState.frequency === 'daily') return I18N.t('dca.frequency.perDay');
  if (dcaState.frequency === 'weekly') return I18N.t('dca.frequency.perWeek');
  return I18N.t('dca.frequency.perMonth');
}

function dcaDataRangeHint(points) {
  if (!points.length) return null;
  const first = new Date(points[0].t);
  const last = new Date(points[points.length - 1].t);
  return I18N.t('dca.dataRange', {
    firstDate: `${first.getMonth() + 1}/${first.getFullYear()}`,
    lastDate: `${last.getMonth() + 1}/${last.getFullYear()}`,
  });
}

function dcaMaxYears() {
  const start = dcaState.startDate || defaultDcaStartDate();
  const diffMs = Date.now() - start.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 365.25)));
}

/**
 * Full daily series for DCA — same layers as market charts, but without
 * trimming early history (DCA needs the whole coin lifetime, not last N days).
 *
 *   1) bundled JSON (data/charts/*.json)
 *   2.5) Worker GET /chart-delta (KV — keeps recent ~90d fresh)
 *   3) CoinGecko market_chart gap-fill when still >1 day behind
 *
 * Bundles ship ~monthly; without delta, HYPE/etc stop at last release date
 * and "valor atual" / late purchases go stale.
 */
async function loadDcaChartData(coinId) {
  const bundled = await loadBundledChart(coinId);
  const bundledPoints = bundled.points || [];
  let localPoints = bundledPoints;

  try {
    const delta = await getChartDelta();
    const deltaPts = deltaPointsForCoin(delta, coinId);
    if (deltaPts.length) localPoints = mergeAndDedup(localPoints, deltaPts);
  } catch (e) { /* keep bundle */ }

  const lastKnownTs = localPoints.length ? localPoints[localPoints.length - 1].t : 0;
  const gapDays = lastKnownTs
    ? Math.ceil((Date.now() - lastKnownTs) / ONE_DAY_MS)
    : CHART_GAP_MAX_DAYS;

  if (gapDays > 1) {
    try {
      const fresh = await fetchGapFromApi(coinId, gapDays);
      if (fresh.length) localPoints = mergeAndDedup(localPoints, fresh);
    } catch (e) {
      // Offline / rate limit — keep bundle+delta; better partial than empty.
    }
  }

  return localPoints;
}

function recomputeDcaResults() {
  const amt = parseFloat(dcaState.amount);
  const yrs = parseFloat(dcaState.years);
  if (isNaN(amt) || isNaN(yrs) || amt <= 0 || yrs <= 0 || !dcaState.chartData.length) {
    dcaState.results = null;
    return;
  }
  dcaState.results = calculateDCA(
    dcaState.chartData, amt, dcaState.frequency,
    dcaState.startDate || defaultDcaStartDate(), yrs
  );
}

// ── DCA chart (SVG port of DCAChart.tsx) ─────────────────────────────
function buildDcaChartMetrics(allPriceData, purchases, width, height) {
  if (width < 40 || allPriceData.length < 2 || !purchases.length) return null;
  const P = DCA_PAD;
  const chartWidth = width - P.left - P.right;
  const chartHeight = height - P.top - P.bottom;
  const firstPurchase = purchases[0];
  const lastPurchase = purchases[purchases.length - 1];
  const minTime = firstPurchase.timestamp;
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const maxTime = today.getTime();
  const timeRange = maxTime - minTime || 1;

  const filteredPriceData = allPriceData.filter((p) => p.t >= minTime && p.t <= maxTime);
  if (filteredPriceData.length < 2) return null;

  const finalAvgPrice = lastPurchase.runningAvgPrice;
  const allPrices = [
    ...filteredPriceData.map((p) => p.c),
    ...purchases.map((p) => p.runningAvgPrice),
  ];
  const minPrice = Math.max(0.0001, Math.min(...allPrices));
  const maxPrice = Math.max(...allPrices);
  const logMin = Math.log(minPrice);
  const logMax = Math.log(maxPrice);
  const logRange = logMax - logMin || 1;
  const logPadding = logRange * 0.1;
  const paddedLogMin = logMin - logPadding;
  const paddedLogMax = logMax + logPadding;
  const paddedLogRange = paddedLogMax - paddedLogMin;
  const paddedMin = Math.exp(paddedLogMin);
  const paddedMax = Math.exp(paddedLogMax);

  const timeToX = (t) => P.left + ((t - minTime) / timeRange) * chartWidth;
  const priceToY = (p) => {
    const logP = Math.log(Math.max(0.0001, p));
    return P.top + chartHeight - ((logP - paddedLogMin) / paddedLogRange) * chartHeight;
  };

  const dcaPeriodPriceData = filteredPriceData.filter((p) => p.t <= lastPurchase.timestamp);
  const postDcaPriceData = filteredPriceData.filter((p) => p.t >= lastPurchase.timestamp);

  const pricePoints = dcaPeriodPriceData.map((d) => ({ x: timeToX(d.t), y: priceToY(d.c) }));
  const postDcaPricePoints = postDcaPriceData.map((d) => ({ x: timeToX(d.t), y: priceToY(d.c) }));
  const avgPoints = purchases.map((p) => ({ x: timeToX(p.timestamp), y: priceToY(p.runningAvgPrice) }));
  const lastAvgY = priceToY(finalAvgPrice);
  const postDcaAvgPoints = [
    { x: timeToX(lastPurchase.timestamp), y: lastAvgY },
    { x: timeToX(maxTime), y: lastAvgY },
  ];
  const purchaseDots = purchases.map((p) => ({ x: timeToX(p.timestamp), y: priceToY(p.price) }));
  const hasPostDcaPeriod = maxTime - lastPurchase.timestamp > ONE_DAY_MS;

  const allPricePoints = filteredPriceData.map((d) => ({
    x: timeToX(d.t), y: priceToY(d.c), timestamp: d.t, price: d.c,
  }));

  return {
    pricePath: monotoneCubicPath(pricePoints),
    postDcaPricePath: monotoneCubicPath(postDcaPricePoints),
    avgPath: linearSvgPath(avgPoints),
    postDcaAvgPath: linearSvgPath(postDcaAvgPoints),
    purchaseDots, avgPoints, allPricePoints,
    chartWidth, chartHeight, minPrice: paddedMin, maxPrice: paddedMax,
    hasPostDcaPeriod, finalAvgPrice, finalAvgY: lastAvgY, P, width, height,
    lastPurchase,
  };
}

/**
 * Paint when the host has a real width; observe resizes so a first paint that
 * landed while view-dca was still display:none (width 0) re-runs after layout,
 * and so window/sidebar width changes don't leave a stretched SVG.
 */
function ensureDcaChartHost(host, tipEl, baseOpts) {
  if (!host) return;
  if (dcaState.chartRo) {
    try { dcaState.chartRo.disconnect(); } catch (e) {}
    dcaState.chartRo = null;
  }
  dcaState.lastPaintW = 0;

  const paint = (playEntrance) => {
    if (!host.isConnected || !dcaState.results || dcaState.results.purchases.length < 2) return;
    const w = Math.round(host.clientWidth);
    if (w < 40) return;
    // Skip no-op resizes (sub-pixel / scrub repaints handle their own path).
    if (w === dcaState.lastPaintW && dcaState.chartGeom && !playEntrance && !dcaState.scrub) return;
    dcaState.lastPaintW = w;
    paintDcaChart(host, tipEl, {
      allPriceData: baseOpts.allPriceData,
      purchases: baseOpts.purchases,
      coinId: baseOpts.coinId,
      playEntrance: !!playEntrance,
      scrub: dcaState.scrub,
    });
  };

  paint(true);

  if (typeof ResizeObserver !== 'undefined') {
    let first = true;
    dcaState.chartRo = new ResizeObserver(() => {
      // First RO fire is the initial observation — already painted above when
      // width was ready; only re-paint when size actually changes (or when the
      // first paint was skipped because width was 0).
      if (first) {
        first = false;
        if (dcaState.lastPaintW > 0) return;
      }
      paint(dcaState.lastPaintW === 0);
    });
    dcaState.chartRo.observe(host);
  } else if (dcaState.lastPaintW === 0) {
    // No RO: poll a few frames through the view fade-in window.
    let tries = 0;
    const tick = () => {
      if (!host.isConnected || dcaState.lastPaintW > 0 || tries++ > 30) return;
      paint(true);
      if (dcaState.lastPaintW === 0) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function paintDcaChart(host, tipEl, opts) {
  const { allPriceData, purchases, coinId, playEntrance = true } = opts;
  // Only trust the host's laid-out width. Parent/fallback sizes are wrong
  // (card padding, or a stale 320 default): with viewBox aspect-ratio the SVG
  // then grows taller than the 180px host and paints past the card.
  // view-dca may still be display:none while chart data loads (race with
  // transitionViews) — clientWidth is 0 then; ensureDcaChartHost handles retry.
  const width = Math.round(host.clientWidth);
  if (width < 40) return null;
  const height = DCA_CHART_H;
  const metrics = buildDcaChartMetrics(allPriceData, purchases, width, height);
  dcaState.chartGeom = metrics;
  if (!metrics) {
    host.innerHTML = '';
    if (tipEl) tipEl.classList.remove('is-on');
    return null;
  }

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#F15B24';
  const priceLineColor = COIN_COLORS[coinId] || accent;
  const isOrangePrice = !COIN_COLORS[coinId] || priceLineColor === accent;
  const avgLineColor = isOrangePrice
    ? (isDark() ? '#FFFFFF' : '#000000')
    : accent;
  const dark = isDark();
  const crosshair = dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.1)';
  const innerDot = dark ? '#000000' : '#FFFFFF';
  const { P, chartHeight: ch } = metrics;
  const drawClipId = 'dca-draw';
  const avgClipId = 'dca-avg-draw';
  const crossId = 'dca-cross';
  const clipW = playEntrance ? 0 : width;

  let scrubSvg = '';
  let scrubDefs = '';
  if (opts.scrub) {
    const s = opts.scrub;
    scrubDefs =
      `<linearGradient id="${crossId}" x1="0" y1="${P.top}" x2="0" y2="${P.top + ch}" gradientUnits="userSpaceOnUse">` +
        `<stop offset="0%" stop-color="${crosshair}" stop-opacity="0"/>` +
        `<stop offset="12%" stop-color="${crosshair}" stop-opacity="1"/>` +
        `<stop offset="88%" stop-color="${crosshair}" stop-opacity="1"/>` +
        `<stop offset="100%" stop-color="${crosshair}" stop-opacity="0"/>` +
      `</linearGradient>`;
    const avgOp = s.isPostDca ? POST_DCA_OPACITY : 1;
    scrubSvg =
      `<rect x="${(s.x - 0.5).toFixed(2)}" y="${P.top}" width="1" height="${ch}" fill="url(#${crossId})"/>` +
      `<circle cx="${s.x.toFixed(2)}" cy="${s.priceY.toFixed(2)}" r="5" fill="${priceLineColor}"/>` +
      `<circle cx="${s.x.toFixed(2)}" cy="${s.priceY.toFixed(2)}" r="3" fill="${innerDot}"/>` +
      `<circle cx="${s.x.toFixed(2)}" cy="${s.avgY.toFixed(2)}" r="5" fill="${avgLineColor}" opacity="${avgOp}"/>` +
      `<circle cx="${s.x.toFixed(2)}" cy="${s.avgY.toFixed(2)}" r="3" fill="${innerDot}" opacity="${avgOp}"/>`;
    if (tipEl) {
      tipEl.innerHTML =
        `<div class="dca-chart__tip-date">${escapeHtml(s.date)}</div>` +
        `<div class="dca-chart__tip-row">` +
          `<span class="dca-chart__tip-dot" style="background:${priceLineColor}"></span>` +
          `<span class="dca-chart__tip-label">${escapeHtml(I18N.t('dca.chart.tooltipPrice'))}</span>` +
          `<span class="dca-chart__tip-val">${escapeHtml(s.price)}</span>` +
        `</div>` +
        `<div class="dca-chart__tip-row">` +
          `<span class="dca-chart__tip-dot" style="background:${avgLineColor}"></span>` +
          `<span class="dca-chart__tip-label">${escapeHtml(I18N.t('dca.chart.tooltipAvg'))}</span>` +
          `<span class="dca-chart__tip-val" style="color:${avgLineColor}">${escapeHtml(s.avgPrice)}</span>` +
        `</div>`;
      tipEl.classList.add('is-on');
    }
  } else if (tipEl) {
    tipEl.classList.remove('is-on');
  }

  const lastAvg = metrics.avgPoints[metrics.avgPoints.length - 1];
  const stageClass = 'dca-chart__stage' + (playEntrance ? '' : ' is-in');

  host.innerHTML =
    `<div class="dca-chart__y" aria-hidden="true">` +
      `<span>${formatDcaAxisPrice(metrics.maxPrice)}</span>` +
      `<span>${formatDcaAxisPrice(metrics.minPrice)}</span>` +
    `</div>` +
    `<div class="${stageClass}" data-dca-stage>` +
      `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none">` +
        `<defs>` +
          `<clipPath id="${drawClipId}"><rect data-dca-price-clip x="0" y="0" width="${clipW}" height="${height}"/></clipPath>` +
          `<clipPath id="${avgClipId}"><rect data-dca-avg-clip x="0" y="0" width="${clipW}" height="${height}"/></clipPath>` +
          scrubDefs +
        `</defs>` +
        `<g clip-path="url(#${drawClipId})">` +
          (metrics.pricePath
            ? `<path d="${metrics.pricePath}" fill="none" stroke="${priceLineColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"/>`
            : '') +
          (metrics.hasPostDcaPeriod && metrics.postDcaPricePath
            ? `<path d="${metrics.postDcaPricePath}" fill="none" stroke="${priceLineColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.4"/>`
            : '') +
          metrics.purchaseDots.map((dot) =>
            `<circle cx="${dot.x.toFixed(2)}" cy="${dot.y.toFixed(2)}" r="2.5" fill="${priceLineColor}" opacity="0.6"/>`
          ).join('') +
        `</g>` +
        `<g clip-path="url(#${avgClipId})">` +
          (metrics.avgPath
            ? `<path d="${metrics.avgPath}" fill="none" stroke="${avgLineColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
            : '') +
          (metrics.hasPostDcaPeriod && metrics.postDcaAvgPath
            ? `<path d="${metrics.postDcaAvgPath}" fill="none" stroke="${avgLineColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="${POST_DCA_OPACITY}"/>`
            : '') +
          (lastAvg
            ? `<circle cx="${lastAvg.x.toFixed(2)}" cy="${lastAvg.y.toFixed(2)}" r="4" fill="${avgLineColor}" data-dca-end-dot opacity="0"/>` +
              `<circle cx="${lastAvg.x.toFixed(2)}" cy="${lastAvg.y.toFixed(2)}" r="2" fill="${innerDot}" data-dca-end-dot opacity="0"/>`
            : '') +
        `</g>` +
        scrubSvg +
      `</svg>` +
    `</div>` +
    `<div class="dca-chart__legend">` +
      `<span class="dca-chart__legend-item">` +
        `<span class="dca-chart__legend-dot" style="background:${priceLineColor};opacity:0.6"></span>` +
        `${escapeHtml(I18N.t('dca.chart.priceLegend'))}` +
      `</span>` +
      `<span class="dca-chart__legend-item">` +
        `<span class="dca-chart__legend-line" style="background:${avgLineColor}"></span>` +
        `${escapeHtml(I18N.t('dca.chart.avgPrice'))}` +
      `</span>` +
    `</div>`;

  if (tipEl && !host.contains(tipEl)) host.appendChild(tipEl);
  else if (tipEl) host.appendChild(tipEl);

  if (dcaState.cancelDraw) { dcaState.cancelDraw(); dcaState.cancelDraw = null; }

  if (playEntrance) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const stage = host.querySelector('[data-dca-stage]');
        const priceClip = host.querySelector('[data-dca-price-clip]');
        const avgClip = host.querySelector('[data-dca-avg-clip]');
        const endDots = host.querySelectorAll('[data-dca-end-dot]');
        if (stage) stage.classList.add('is-in');
        const cancels = [];
        if (priceClip) {
          cancels.push(animateValue(0, width, DCA_DRAW_MS, (w) => {
            priceClip.setAttribute('width', String(Math.max(0, w)));
          }, () => priceClip.setAttribute('width', String(width))));
        }
        if (avgClip) {
          cancels.push(animateValue(0, width, DCA_AVG_DRAW_MS, (w) => {
            avgClip.setAttribute('width', String(Math.max(0, w)));
            // End-dot fades in over the last 10% of avg draw (app avgEndDotOpacity).
            const p = w / width;
            const op = p < 0.9 ? 0 : (p - 0.9) / 0.1;
            endDots.forEach((el) => { el.setAttribute('opacity', String(op)); });
          }, () => {
            avgClip.setAttribute('width', String(width));
            endDots.forEach((el) => { el.setAttribute('opacity', '1'); });
          }));
        }
        dcaState.cancelDraw = () => cancels.forEach((c) => c && c());
      });
    });
  } else {
    host.querySelectorAll('[data-dca-end-dot]').forEach((el) => el.setAttribute('opacity', '1'));
  }

  return metrics;
}

function dcaScrubAt(clientX) {
  const geom = dcaState.chartGeom;
  if (!geom || !geom.allPricePoints.length) return;
  const host = document.querySelector('#dca-chart-host');
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const x = clientX - rect.left;
  let nearest = 0;
  let nearestDist = Infinity;
  geom.allPricePoints.forEach((p, i) => {
    const dist = Math.abs(p.x - x);
    if (dist < nearestDist) { nearestDist = dist; nearest = i; }
  });
  const pricePoint = geom.allPricePoints[nearest];
  const lastPurchase = geom.lastPurchase;
  const isPostDca = pricePoint.timestamp > lastPurchase.timestamp;
  let avgPrice = geom.finalAvgPrice;
  let avgY = geom.finalAvgY;
  if (!isPostDca) {
    avgPrice = dcaState.results.purchases[0].runningAvgPrice;
    let idx = 0;
    for (let i = 0; i < dcaState.results.purchases.length; i++) {
      if (dcaState.results.purchases[i].timestamp <= pricePoint.timestamp) {
        avgPrice = dcaState.results.purchases[i].runningAvgPrice;
        idx = i;
      } else break;
    }
    avgY = geom.avgPoints[idx].y;
  }
  dcaState.scrub = {
    x: pricePoint.x,
    priceY: pricePoint.y,
    avgY,
    isPostDca,
    date: formatTooltipDate(pricePoint.timestamp),
    price: formatTooltipPrice(pricePoint.price),
    avgPrice: formatTooltipPrice(avgPrice),
  };
  const tip = $('dca-chart-tip');
  paintDcaChart(host, tip, {
    allPriceData: dcaState.chartData,
    purchases: dcaState.results.purchases,
    coinId: dcaState.coinId,
    playEntrance: false,
    scrub: dcaState.scrub,
  });
}

function endDcaScrub() {
  if (!dcaState.scrub) return;
  dcaState.scrub = null;
  const host = document.querySelector('#dca-chart-host');
  const tip = $('dca-chart-tip');
  if (host && dcaState.results) {
    paintDcaChart(host, tip, {
      allPriceData: dcaState.chartData,
      purchases: dcaState.results.purchases,
      coinId: dcaState.coinId,
      playEntrance: false,
      scrub: null,
    });
  }
}

// ── DCA body ─────────────────────────────────────────────────────────
function renderDcaBody() {
  const body = $('calc-dca-body');
  if (!body) return;
  if (!dcaState.startDate) dcaState.startDate = defaultDcaStartDate();
  const sym = calcCoinSym(dcaState.coinId);
  const rangeHint = dcaDataRangeHint(dcaState.chartData);
  const freqSeg =
    `<div class="calc-freq"><div class="mm__seg" role="tablist" id="dca-freq">` +
      [['daily', 'dca.frequency.daily'], ['weekly', 'dca.frequency.weekly'], ['monthly', 'dca.frequency.monthly']]
        .map(([k, key]) =>
          `<button type="button" data-freq="${k}" class="${dcaState.frequency === k ? 'active' : ''}">${escapeHtml(I18N.t(key))}</button>`
        ).join('') +
    `</div></div>`;

  let resultsHtml = '';
  const r = dcaState.results;
  if (r) {
    const plTone = r.profitLoss >= 0 ? 'success' : 'danger';
    const plPrefix = r.profitLoss >= 0 ? '+ $ ' : '- $ ';
    const apPrefix = r.profitLossPercent >= 0 ? '+ ' : '- ';
    let cardI = 0;
    resultsHtml +=
      `<div class="calc-card calc-card--result" data-i="${cardI++}">` +
        `<h3 class="calc-card__title">${escapeHtml(I18N.t('dca.results.title'))}</h3>` +
        `<p class="calc-card__subtitle">${r.numPurchases} × $${parseFloat(dcaState.amount).toFixed(2)} → ${escapeHtml(sym)}</p>` +
        resultRowHtml({ label: I18N.t('dca.results.totalInvested'), value: r.totalInvested }) +
        resultDividerHtml() +
        resultRowHtml({ label: I18N.t('dca.results.currentValue'), value: r.currentValue, tone: 'accent' }) +
        resultDividerHtml() +
        resultRowHtml({ label: I18N.t('dca.results.profitLoss'), value: Math.abs(r.profitLoss), prefix: plPrefix, tone: plTone }) +
        resultDividerHtml() +
        resultRowHtml({ label: I18N.t('dca.results.appreciation'), value: Math.abs(r.profitLossPercent), prefix: apPrefix, suffix: ' %', tone: plTone }) +
      `</div>`;

    if (r.purchases.length > 1) {
      resultsHtml +=
        `<div class="calc-card calc-card--result" data-i="${cardI++}" style="padding-bottom:8px">` +
          `<h3 class="calc-card__title">${escapeHtml(I18N.t('dca.chart.title'))}</h3>` +
          `<div class="dca-chart" id="dca-chart-host">` +
            `<div class="dca-chart__tip" id="dca-chart-tip"></div>` +
          `</div>` +
        `</div>`;
    }

    resultsHtml +=
      `<div class="calc-card calc-card--result" data-i="${cardI++}">` +
        `<h3 class="calc-card__title">${escapeHtml(I18N.t('dca.chart.details'))}</h3>` +
        resultRowHtml({ label: I18N.t('dca.chart.totalCoin', { symbol: sym }), value: r.totalCoins, prefix: '', suffix: ` ${sym}`, decimals: 6 }) +
        resultDividerHtml() +
        resultRowHtml({ label: I18N.t('dca.chart.avgPrice'), value: r.averagePrice }) +
        resultDividerHtml() +
        resultRowHtml({ label: I18N.t('dca.chart.currentPrice'), value: r.currentPrice, tone: 'accent' }) +
        `<div class="calc-note">` +
          `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>` +
          `<span>${escapeHtml(I18N.t('dca.disclaimer'))}</span>` +
        `</div>` +
      `</div>`;
  } else if (dcaState.chartData.length > 0) {
    resultsHtml =
      `<div class="calc-card" style="margin-top:var(--space-md)">` +
        `<div class="calc-warning">` +
          `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>` +
          `<span>${escapeHtml(I18N.t('dca.warning'))}</span>` +
        `</div>` +
      `</div>`;
  }

  body.innerHTML =
    `<h1 class="calc__title" id="calc-dca-title">${escapeHtml(I18N.t('dca.title'))}</h1>` +
    `<p class="calc__subtitle">${escapeHtml(I18N.t('dca.subtitle'))}</p>` +
    `<div class="calc-card">` +
      `<h3 class="calc-card__title">${escapeHtml(I18N.t('position.parameters.title'))}</h3>` +
      `<div class="calc-field">` +
        `<label class="calc-field__label">${escapeHtml(I18N.t('dca.crypto'))}</label>` +
        `<button type="button" class="calc-coin-btn" id="dca-coin-btn">` +
          `<img src="${calcCoinIconSrc(sym)}" alt="" onerror="this.style.visibility='hidden'"/>` +
          `<span class="calc-coin-btn__sym">${escapeHtml(sym)}</span>` +
          `<svg class="calc-coin-btn__chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>` +
        `</button>` +
      `</div>` +
      (rangeHint ? `<span class="calc-data-range">${escapeHtml(rangeHint)}</span>` : '') +
      `<span class="calc-section-label">${escapeHtml(I18N.t('dca.frequency.label'))}</span>` +
      freqSeg +
      calcFieldHtml({
        id: 'dca-amount', label: I18N.t('dca.amount'), value: dcaState.amount,
        placeholder: '100', prefix: '$', suffix: dcaFrequencySuffix(),
      }) +
      `<div class="calc-date-row">` +
        `<div class="calc-field flex">` +
          `<label class="calc-field__label">${escapeHtml(I18N.t('dca.startDate'))}</label>` +
          dcaStartDateControlsHtml() +
        `</div>` +
        calcFieldHtml({
          id: 'dca-years', label: I18N.t('dca.period'), value: dcaState.years,
          placeholder: '3', suffix: I18N.t('dca.years'), flex: true,
        }) +
      `</div>` +
    `</div>` +
    resultsHtml;

  // Wire controls
  const coinBtn = body.querySelector('#dca-coin-btn');
  if (coinBtn) coinBtn.addEventListener('click', () => {
    openCoinPicker(dcaState.coinId, async (id) => {
      dcaState.coinId = id;
      dcaState.chartData = await loadDcaChartData(id);
      recomputeDcaResults();
      renderDcaBody();
    }, coinBtn);
  });

  body.querySelectorAll('#dca-freq [data-freq]').forEach((btn) => {
    btn.addEventListener('click', () => {
      dcaState.frequency = btn.getAttribute('data-freq');
      recomputeDcaResults();
      renderDcaBody();
    });
  });

  const amountInput = body.querySelector('#cf-dca-amount');
  if (amountInput) amountInput.addEventListener('input', () => {
    dcaState.amount = amountInput.value;
    recomputeDcaResults();
    // Re-render only results region would be ideal; full re-render is fine and keeps focus
    // loss — so update results without full remount when possible:
    scheduleDcaResultsRefresh();
  });

  const yearsInput = body.querySelector('#cf-dca-years');
  if (yearsInput) yearsInput.addEventListener('input', () => {
    let v = yearsInput.value;
    const parsed = parseInt(v, 10);
    const maxY = dcaMaxYears();
    if (!isNaN(parsed) && parsed > maxY && maxY > 0) {
      v = String(maxY);
      yearsInput.value = v;
    }
    dcaState.years = v;
    scheduleDcaResultsRefresh();
  });

  ['#dca-month', '#dca-year', '#dca-day'].forEach((sel) => {
    const el = body.querySelector(sel);
    if (el) el.addEventListener('change', () => applyDcaStartDateFromControls(body));
  });

  // Paint chart after layout (and again when the host gets a real width —
  // view may still be display:none during the page fade-in).
  if (r && r.purchases.length > 1) {
    requestAnimationFrame(() => {
      const host = body.querySelector('#dca-chart-host');
      const tip = body.querySelector('#dca-chart-tip');
      if (!host) return;
      ensureDcaChartHost(host, tip, {
        allPriceData: dcaState.chartData,
        purchases: r.purchases,
        coinId: dcaState.coinId,
      });
      wireDcaChartScrub(host);
    });
  }
}

let dcaRefreshTimer = 0;
function scheduleDcaResultsRefresh() {
  clearTimeout(dcaRefreshTimer);
  dcaRefreshTimer = setTimeout(() => {
    recomputeDcaResults();
    // Preserve focus/caret: only re-render if not typing into amount/years... 
    // Full body re-render loses focus — patch results after inputs instead.
    const active = document.activeElement;
    const keepFocusId = active && active.id;
    const keepVal = active && active.value;
    const keepSel = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    renderDcaBody();
    if (keepFocusId) {
      const el = document.getElementById(keepFocusId);
      if (el) {
        el.focus();
        if (keepVal != null) el.value = keepVal;
        if (keepSel != null && el.setSelectionRange) {
          try { el.setSelectionRange(keepSel, keepSel); } catch (e) {}
        }
      }
    }
  }, 120);
}

function wireDcaChartScrub(host) {
  let active = false;
  const onDown = (e) => {
    active = true;
    host.setPointerCapture?.(e.pointerId);
    dcaScrubAt(e.clientX);
  };
  const onMove = (e) => {
    if (!active) {
      // Desktop hover scrub when fine pointer
      if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        dcaScrubAt(e.clientX);
      }
      return;
    }
    dcaScrubAt(e.clientX);
  };
  const onUp = () => {
    if (!active) return;
    active = false;
    endDcaScrub();
  };
  host.addEventListener('pointerdown', onDown);
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', onUp);
  host.addEventListener('pointercancel', onUp);
  host.addEventListener('pointerleave', () => {
    if (!active) endDcaScrub();
  });
}

// ── Position body ────────────────────────────────────────────────────
function loadPosFromStorage() {
  try {
    const wallet = localStorage.getItem(POS_STORAGE.wallet);
    const lossPct = localStorage.getItem(POS_STORAGE.lossPct);
    const lossDollar = localStorage.getItem(POS_STORAGE.lossDollar);
    const lastEdit = localStorage.getItem(POS_STORAGE.lastEdit);
    if (wallet != null) posState.walletSize = wallet;
    if (lossPct != null) posState.maxLossPercent = lossPct;
    if (lossDollar != null) posState.maxLossDollar = lossDollar;
    if (lastEdit === 'percent' || lastEdit === 'dollar') posState.lastLossEdit = lastEdit;
  } catch (e) {}
}

function persistPos(key, value) {
  try { localStorage.setItem(key, value); } catch (e) {}
}

function posOpenFeeRate() {
  return posState.openFeeType === 'market' ? DEFAULT_TAKER_FEE : DEFAULT_MAKER_FEE;
}
function posCloseFeeRate() {
  return posState.closeFeeType === 'market' ? DEFAULT_TAKER_FEE : DEFAULT_MAKER_FEE;
}

function renderPosBody() {
  const body = $('calc-pos-body');
  if (!body) return;

  const wallet = parseFloat(posState.walletSize);
  const lossPercent = parseFloat(posState.maxLossPercent);
  const stopDist = parseFloat(posState.stopLossDistance);
  const lev = parseFloat(posState.leverage);
  const results = calculatePosition(
    wallet, lossPercent, stopDist, lev, posOpenFeeRate(), posCloseFeeRate()
  );

  const openLabel = posState.openFeeType === 'market' ? 'Taker' : 'Maker';
  const closeLabel = posState.closeFeeType === 'market' ? 'Taker' : 'Maker';

  let resultsHtml = '';
  if (results) {
    resultsHtml =
      `<div class="calc-card calc-card--result" data-i="0">` +
        `<h3 class="calc-card__title">${escapeHtml(I18N.t('position.result.title'))}</h3>` +
        `<p class="calc-card__subtitle">${escapeHtml(I18N.t('position.result.subtitle'))}</p>` +
        resultRowHtml({ label: I18N.t('position.result.positionValue'), value: results.positionValue, tone: 'accent' }) +
        resultDividerHtml() +
        resultRowHtml({ label: I18N.t('position.result.margin'), value: results.cost, tone: 'accent' }) +
      `</div>` +
      `<div class="calc-card calc-card--result" data-i="1">` +
        `<div class="calc-fees-title">` +
          `<h3 class="calc-card__title">${escapeHtml(I18N.t('position.fees.title'))}</h3>` +
          `<button type="button" class="calc-fee-cfg" id="pos-fee-cfg" aria-label="${escapeHtml(I18N.t('position.fees.configTitle'))}">` +
            `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>` +
          `</button>` +
        `</div>` +
        resultRowHtml({
          label: I18N.t('position.fees.openFee'), value: results.openFee,
          caption: `${(posOpenFeeRate() * 100).toFixed(2)}% ${openLabel} fee`,
        }) +
        resultDividerHtml() +
        resultRowHtml({
          label: I18N.t('position.fees.closeFee'), value: results.closeFee,
          caption: `${(posCloseFeeRate() * 100).toFixed(2)}% ${closeLabel} fee`,
        }) +
        resultDividerHtml() +
        resultRowHtml({ label: I18N.t('position.fees.totalFees'), value: results.totalFees }) +
        `<div class="calc-note">` +
          `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>` +
          `<span>${escapeHtml(I18N.t('position.fees.note'))}</span>` +
        `</div>` +
      `</div>` +
      `<div class="calc-card calc-card--result" data-i="2">` +
        `<h3 class="calc-card__title">${escapeHtml(I18N.t('position.impact.title'))}</h3>` +
        resultRowHtml({ label: I18N.t('position.impact.stopLoss'), value: results.stopLoss, prefix: '- $ ', tone: 'danger' }) +
        resultDividerHtml() +
        resultRowHtml({ label: I18N.t('position.impact.fees'), value: results.totalFees, prefix: '- $ ', tone: 'danger' }) +
        resultDividerHtml() +
        resultRowHtml({
          label: I18N.t('position.impact.totalLoss'), value: results.maxLoss, prefix: '- $ ', tone: 'danger',
          caption: I18N.t('position.impact.note'),
        }) +
      `</div>`;
  }

  body.innerHTML =
    `<h1 class="calc__title" id="calc-pos-title">${escapeHtml(I18N.t('position.title'))}</h1>` +
    `<p class="calc__subtitle">${escapeHtml(I18N.t('position.subtitle'))}</p>` +
    `<div class="calc-card">` +
      `<h3 class="calc-card__title">${escapeHtml(I18N.t('position.parameters.title'))}</h3>` +
      calcFieldHtml({
        id: 'pos-wallet', label: I18N.t('position.parameters.walletSize'),
        value: posState.walletSize, placeholder: '10000', prefix: '$',
      }) +
      `<span class="calc-section-label">${escapeHtml(I18N.t('position.parameters.maxLoss'))}</span>` +
      `<div class="calc-linked">` +
        calcFieldHtml({
          id: 'pos-loss-pct', label: I18N.t('position.parameters.maxLossPercent'),
          value: posState.maxLossPercent, placeholder: '2', suffix: '%', smallLabel: true,
        }) +
        `<span class="calc-linked__icon" aria-hidden="true">` +
          `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>` +
        `</span>` +
        calcFieldHtml({
          id: 'pos-loss-dollar', label: I18N.t('position.parameters.maxLossDollar'),
          value: posState.maxLossDollar, placeholder: '200', prefix: '$', smallLabel: true,
        }) +
      `</div>` +
      calcFieldHtml({
        id: 'pos-lev', label: I18N.t('position.parameters.leverage'),
        value: posState.leverage, placeholder: '10', suffix: 'x',
      }) +
      calcFieldHtml({
        id: 'pos-sl', label: I18N.t('position.parameters.stopLossDistance'),
        value: posState.stopLossDistance, placeholder: '5', suffix: '%',
        hint: I18N.t('position.parameters.stopLossHint'),
      }) +
    `</div>` +
    resultsHtml;

  const bind = (id, fn) => {
    const el = body.querySelector(`#cf-${id}`);
    if (el) el.addEventListener('input', () => fn(el));
  };

  bind('pos-wallet', (el) => {
    posState.walletSize = el.value;
    persistPos(POS_STORAGE.wallet, el.value);
    // Recalculate linked loss field (app useEffect on walletSize)
    const w = parseFloat(el.value);
    if (!isNaN(w) && w > 0) {
      if (posState.lastLossEdit === 'percent') {
        const pct = parseFloat(posState.maxLossPercent);
        if (!isNaN(pct)) {
          const dollar = ((w * pct) / 100).toFixed(2);
          posState.maxLossDollar = dollar;
          persistPos(POS_STORAGE.lossDollar, dollar);
        }
      } else if (posState.lastLossEdit === 'dollar') {
        const dollar = parseFloat(posState.maxLossDollar);
        if (!isNaN(dollar)) {
          const pct = ((dollar / w) * 100).toFixed(2);
          posState.maxLossPercent = pct;
          persistPos(POS_STORAGE.lossPct, pct);
        }
      }
    }
    schedulePosRefresh();
  });

  bind('pos-loss-pct', (el) => {
    posState.maxLossPercent = el.value;
    posState.lastLossEdit = 'percent';
    persistPos(POS_STORAGE.lossPct, el.value);
    persistPos(POS_STORAGE.lastEdit, 'percent');
    const w = parseFloat(posState.walletSize);
    const pct = parseFloat(el.value);
    if (!isNaN(w) && w > 0 && !isNaN(pct)) {
      const dollar = ((w * pct) / 100).toFixed(2);
      posState.maxLossDollar = dollar;
      persistPos(POS_STORAGE.lossDollar, dollar);
    } else {
      posState.maxLossDollar = '';
      persistPos(POS_STORAGE.lossDollar, '');
    }
    schedulePosRefresh();
  });

  bind('pos-loss-dollar', (el) => {
    posState.maxLossDollar = el.value;
    posState.lastLossEdit = 'dollar';
    persistPos(POS_STORAGE.lossDollar, el.value);
    persistPos(POS_STORAGE.lastEdit, 'dollar');
    const w = parseFloat(posState.walletSize);
    const dollar = parseFloat(el.value);
    if (!isNaN(w) && w > 0 && !isNaN(dollar)) {
      const pct = ((dollar / w) * 100).toFixed(2);
      posState.maxLossPercent = pct;
      persistPos(POS_STORAGE.lossPct, pct);
    } else {
      posState.maxLossPercent = '';
      persistPos(POS_STORAGE.lossPct, '');
    }
    schedulePosRefresh();
  });

  bind('pos-lev', (el) => {
    posState.leverage = el.value;
    schedulePosRefresh();
  });

  bind('pos-sl', (el) => {
    posState.stopLossDistance = el.value;
    schedulePosRefresh();
  });

  const feeBtn = body.querySelector('#pos-fee-cfg');
  if (feeBtn) feeBtn.addEventListener('click', openFeeConfig);
}

let posRefreshTimer = 0;
function schedulePosRefresh() {
  clearTimeout(posRefreshTimer);
  posRefreshTimer = setTimeout(() => {
    const active = document.activeElement;
    const keepFocusId = active && active.id;
    const keepVal = active && active.value;
    const keepSel = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    renderPosBody();
    if (keepFocusId) {
      const el = document.getElementById(keepFocusId);
      if (el) {
        el.focus();
        if (keepVal != null) el.value = keepVal;
        if (keepSel != null && el.setSelectionRange) {
          try { el.setSelectionRange(keepSel, keepSel); } catch (e) {}
        }
      }
    }
  }, 80);
}

// ── Open / close (full-page views, same as Glossary) ─────────────────
async function loadDcaPage() {
  if (!dcaState.startDate) dcaState.startDate = defaultDcaStartDate();
  dcaState.chartData = await loadDcaChartData(dcaState.coinId);
  recomputeDcaResults();
  renderDcaBody();
}

function loadPosPage() {
  loadPosFromStorage();
  renderPosBody();
}

function openDcaCalculator() {
  setView('dca');
}

function closeDcaCalculator() {
  closeCalcSheet();
  if (currentView === 'dca') setView('feed');
}

function openPosCalculator() {
  setView('pos');
}

function closePosCalculator() {
  closeCalcSheet();
  if (currentView === 'pos') setView('feed');
}

function closeAnyCalculator() {
  if ($('calc-sheet') && !$('calc-sheet').classList.contains('hidden')) {
    closeCalcSheet();
    return true;
  }
  if (isCalcOpen('dca')) { closeDcaCalculator(); return true; }
  if (isCalcOpen('pos')) { closePosCalculator(); return true; }
  return false;
}

function handleCalcLinkClick(e) {
  const a = e.target.closest && e.target.closest('a[data-calc-link]');
  if (!a) return;
  e.preventDefault();
  const which = a.getAttribute('data-calc-link');
  if (which === 'dca') openDcaCalculator();
  else if (which === 'pos') openPosCalculator();
}

// ── Boot ──────────────────────────────────────────────────────────────
applyTheme();
// Keep the desktop lesson panel height in sync with measured chrome (lang banner).
window.addEventListener('resize', () => {
  syncLessonPanelChrome();
  // Crossing the desktop breakpoint: drop drawer open state / re-apply rail.
  if (isDesktopSidebar()) {
    setSidebarOpen(false);
    document.body.style.overflow = '';
  } else {
    // Leaving desktop: clear rail classes so the overlay drawer is always full-width.
    const app = $('app');
    if (app) {
      app.classList.remove('is-sidebar-rail');
      // Keep collapsed preference in storage but don't apply rail layout on mobile.
    }
  }
  updateSidebarChromeAria();
});
if (typeof ResizeObserver !== 'undefined') {
  const ro = new ResizeObserver(() => syncLessonPanelChrome());
  const banner = $('lang-banner');
  const mobileTop = $('mobile-topbar');
  if (banner) ro.observe(banner);
  if (mobileTop) ro.observe(mobileTop);
}
window.addEventListener('scroll', () => {
  // Tooltip is position:fixed to the tap point — hide on scroll so it does not drift.
  if ($('glossary-tooltip-root') && !$('glossary-tooltip-root').hidden) hideGlossaryTooltip();
  if (currentView === 'glossary') updateGlossaryScrollSpy();
}, { capture: true, passive: true });
document.querySelectorAll('#menu-lang button').forEach((b) =>
  b.addEventListener('click', () => onLangChange(b.dataset.lang)));
document.querySelectorAll('#menu-theme button').forEach((b) =>
  b.addEventListener('click', () => setThemePref(b.dataset.themePref)));
const menuThemeCycle = $('menu-theme-cycle');
if (menuThemeCycle) menuThemeCycle.addEventListener('click', () => cycleThemePref());
const userMenuTrigger = $('user-menu-trigger');
if (userMenuTrigger) {
  userMenuTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUserPopover();
  });
}
const userPopover = $('user-popover');
if (userPopover) {
  userPopover.addEventListener('click', (e) => e.stopPropagation());
}
document.addEventListener('click', () => {
  if (userPopoverOpen()) closeUserPopover();
});
const menuLogout = $('menu-logout');
if (menuLogout) {
  menuLogout.addEventListener('click', () => {
    closeUserPopover();
    signOut();
  });
}
const menuNotifRow = $('menu-notif-row');
if (menuNotifRow) {
  menuNotifRow.addEventListener('click', (e) => {
    e.stopPropagation();
    onNotifSwitchClick();
  });
}
const glossarySearch = $('glossary-search');
if (glossarySearch) {
  glossarySearch.addEventListener('input', () => {
    glossarySearchQuery = glossarySearch.value || '';
    renderGlossaryPage();
  });
}
const glossarySearchClear = $('glossary-search-clear');
if (glossarySearchClear) {
  glossarySearchClear.addEventListener('click', () => {
    glossarySearchQuery = '';
    if (glossarySearch) glossarySearch.value = '';
    renderGlossaryPage();
    if (glossarySearch) glossarySearch.focus();
  });
}
const glossaryAlpha = $('glossary-alpha');
if (glossaryAlpha) {
  // Press + drag scrub (app AlphabetIndex Pan gesture). Click is covered by pointerdown.
  glossaryAlpha.addEventListener('pointerdown', onGlossaryAlphaPointerDown);
  glossaryAlpha.addEventListener('pointermove', onGlossaryAlphaPointerMove);
  glossaryAlpha.addEventListener('pointerup', onGlossaryAlphaPointerUp);
  glossaryAlpha.addEventListener('pointercancel', onGlossaryAlphaPointerUp);
  glossaryAlpha.addEventListener('lostpointercapture', onGlossaryAlphaPointerUp);
}
// Glossary tooltip hover roots (feed + modal + lesson panel)
wireGlossaryTooltipRoot($('feed-list'));
wireGlossaryTooltipRoot($('modal-content'));
wireGlossaryTooltipRoot($('lesson-panel-content'));

// Calculators (full-page views)
const calcSheetClose = $('calc-sheet-close');
const calcSheetBackdrop = $('calc-sheet-backdrop');
if (calcSheetClose) calcSheetClose.addEventListener('click', closeCalcSheet);
if (calcSheetBackdrop) calcSheetBackdrop.addEventListener('click', closeCalcSheet);
// Internal Notion links → /dca-sim /pos-calc
$('modal-content').addEventListener('click', handleCalcLinkClick);
$('lesson-panel-content').addEventListener('click', handleCalcLinkClick);
$('ios-banner-close').addEventListener('click', () => {
  $('ios-banner').classList.add('hidden');
  localStorage.setItem('cb-banner-dismissed', '1');
});
$('modal-close').addEventListener('click', () => closeModal());
$('modal-backdrop').addEventListener('click', () => closeModal());
$('modal-share').addEventListener('click', shareCurrent);
$('modal-complete').addEventListener('click', toggleLessonComplete);
$('lesson-panel-close').addEventListener('click', () => closeModal());
$('lesson-panel-share').addEventListener('click', shareCurrent);
$('lesson-panel-complete').addEventListener('click', toggleLessonComplete);
// Market indicators card → info modal (app FearGreedWidget → /indicator-info)
$('market').addEventListener('click', openIndicatorModal);
$('market').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openIndicatorModal();
  }
});
$('indicator-modal-close').addEventListener('click', closeIndicatorModal);
$('indicator-modal-backdrop').addEventListener('click', closeIndicatorModal);

// Price marquee → market modal (app CryptoPriceMarquee → /crypto-market). Always opens on BTC.
$('marquee').addEventListener('click', openMarketModal);
$('marquee').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openMarketModal();
  }
});
$('market-modal-close').addEventListener('click', closeMarketModal);
$('market-modal-backdrop').addEventListener('click', closeMarketModal);
// Period / grid / retry — delegated (content re-renders)
$('mm-periods').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-period]');
  if (btn) selectMarketPeriod(btn.dataset.period);
});
$('mm-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-coin]');
  if (btn) selectMarketCoin(btn.dataset.coin);
});
$('mm-chart').addEventListener('click', (e) => {
  if (e.target.closest('#mm-retry')) loadMarketChart(true);
});
// Chart scrub — press on touch; hover on desktop/tablet (fine pointer).
(function wireChartScrub() {
  const wrap = $('mm-chart-wrap');
  let active = false; // pointer-down drag
  const canHover = () => {
    try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; }
    catch (e) { return false; }
  };
  const onDown = (e) => {
    if (mmState.loading || mmState.error || !mmState.chartGeom) return;
    active = true;
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
    scrubAtClientX(e.clientX);
  };
  const onMove = (e) => {
    if (mmState.loading || mmState.error || !mmState.chartGeom) return;
    // Hover scrub (desktop/tablet) — no button pressed
    if (!active && canHover() && e.buttons === 0) {
      scrubAtClientX(e.clientX);
      return;
    }
    if (!active) return;
    scrubAtClientX(e.clientX);
  };
  const onUp = () => {
    if (!active) return;
    active = false;
    // On fine pointer, leave tooltip on hover until pointerleave
    if (!canHover()) endScrub();
  };
  wrap.addEventListener('pointerdown', onDown);
  wrap.addEventListener('pointermove', onMove);
  wrap.addEventListener('pointerup', onUp);
  wrap.addEventListener('pointercancel', onUp);
  wrap.addEventListener('pointerleave', () => {
    active = false;
    endScrub();
  });
})();
// Keep chart width accurate when the sheet resizes (orientation / desktop).
window.addEventListener('resize', () => {
  if (isMarketModalOpen() && mmState.points && !mmState.loading) renderMarketChart();
});

// Sidebar navigation (Feed / Estudos / tools).
document.querySelectorAll('#sidebar-nav .sidebar__item').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.view !== currentView) setView(b.dataset.view);
    else closeSidebarDrawer();
  });
  // Collapsed rail tooltips use position:fixed — pin --tip-x/y so they aren’t
  // clipped by overflow on .sidebar__item / .sidebar__nav.
  const pinTip = () => {
    if (!isDesktopSidebar() || !isSidebarCollapsed()) return;
    const r = b.getBoundingClientRect();
    b.style.setProperty('--tip-x', `${Math.round(r.right + 12)}px`);
    b.style.setProperty('--tip-y', `${Math.round(r.top + r.height / 2)}px`);
  };
  b.addEventListener('pointerenter', pinTip);
  b.addEventListener('focus', pinTip);
});
// Theme cycle tooltip (collapsed rail) — same fixed positioning as nav items.
const menuThemeCycleBtn = $('menu-theme-cycle');
if (menuThemeCycleBtn) {
  const pinThemeTip = () => {
    if (!isDesktopSidebar() || !isSidebarCollapsed()) return;
    const r = menuThemeCycleBtn.getBoundingClientRect();
    menuThemeCycleBtn.style.setProperty('--tip-x', `${Math.round(r.right + 12)}px`);
    menuThemeCycleBtn.style.setProperty('--tip-y', `${Math.round(r.top + r.height / 2)}px`);
  };
  menuThemeCycleBtn.addEventListener('pointerenter', pinThemeTip);
  menuThemeCycleBtn.addEventListener('focus', pinThemeTip);
}
const sidebarToggle = $('sidebar-toggle');
if (sidebarToggle) {
  sidebarToggle.addEventListener('click', () => {
    if (isDesktopSidebar()) setSidebarCollapsed(!isSidebarCollapsed());
    else setSidebarOpen(!isSidebarOpen());
  });
}
const sidebarFab = $('sidebar-fab');
if (sidebarFab) {
  sidebarFab.addEventListener('click', () => setSidebarOpen(true));
}
const sidebarBackdrop = $('sidebar-backdrop');
if (sidebarBackdrop) {
  sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));
}
initSidebar();
// Body images → fullscreen viewer (modal + desktop lesson panel).
// Cover images are decorative headers — not zoomable. Glossary terms use hover, not click.
function onContentImageClick(e) {
  if (e.target.closest('.glossary-term')) return;
  if (e.target.closest('.nb-bookmark')) return; // favicon/og:image belong to the link
  if (e.target.closest('.modal__cover')) return; // post/lesson cover: no lightbox
  if (e.target.closest('.nb-price')) return; // coin marks in price widgets: decorative, not zoomable
  // Progressive wrappers: always open the full-res layer, not the blur thumb.
  const wrap = e.target.closest('.lazy-img');
  if (wrap) {
    const full = wrap.querySelector('.lazy-img__full');
    const src = full && (full.currentSrc || full.src);
    if (src) { e.stopPropagation(); openLightbox(src); }
    return;
  }
  const img = e.target.closest('img');
  if (img && (img.currentSrc || img.src)) {
    e.stopPropagation();
    openLightbox(img.currentSrc || img.src);
  }
}
$('modal-content').addEventListener('click', onContentImageClick);
$('lesson-panel-content').addEventListener('click', onContentImageClick);
$('lightbox').addEventListener('click', closeLightbox);
$('lightbox-close').addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('glossary-tooltip-root') && !$('glossary-tooltip-root').hidden) {
    hideGlossaryTooltip();
    return;
  }
  if (!$('lightbox').classList.contains('hidden')) { closeLightbox(); return; }
  if (closeAnyCalculator()) return;
  if (!$('market-modal').classList.contains('hidden')) { closeMarketModal(); return; }
  if (!$('indicator-modal').classList.contains('hidden')) { closeIndicatorModal(); return; }
  if (userPopoverOpen()) { closeUserPopover(); return; }
  if (!isDesktopSidebar() && isSidebarOpen()) { closeSidebarDrawer(); return; }
  closeModal();
});
// Back/forward: re-derive the whole UI from the URL, so view + modal stay in step.
window.addEventListener('popstate', syncFromUrl);
document.querySelectorAll('#login-lang button').forEach((b) =>
  b.addEventListener('click', () => onLangChange(b.dataset.lang)));
$('lang-banner-close').addEventListener('click', () => {
  localStorage.setItem(LANG_BANNER_KEY, '1');
  hideLangBanner();
});
const postLangClose = $('post-lang-banner-close');
if (postLangClose) {
  postLangClose.addEventListener('click', () => {
    try { sessionStorage.setItem(POST_LANG_BANNER_KEY, '1'); } catch (e) {}
    hidePostLangBanner();
  });
}
// Register the service worker for app-shell/asset caching (push permission is separate).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Boot: on localhost, try exchanging a dev secret for a real session before deciding
// between showApp (real or mock) and the Google login screen.
(async () => {
  await maybeBootstrapDevSession();
  if (getSession() || isPreview()) showApp();
  else showLogin();
  maybeSuggestLanguage();
})();
