// Crypto Bros website — Google sign-in → gated Feed (marquee, F&G/MVRV, tags, posts, detail modal).
'use strict';

const CONFIG = {
  workerBase: 'https://crypto-bros-notion-proxy.crypto-bros.workers.dev',
  googleClientId: '947303618125-0k85q1ds1g8gfq3njtgsh1nc8ihug94p.apps.googleusercontent.com',
};

const SESSION_KEY = 'cb-session';
const THEME_KEY = 'cb-theme'; // 'light' | 'dark' | absent(=system)
const AVATAR_KEY = 'cb-avatar';
const NAME_KEY = 'cb-name';
const EMAIL_KEY = 'cb-email';
const HISTORY_PAGE_SIZE = 5;

const $ = (id) => document.getElementById(id);
const getSession = () => localStorage.getItem(SESSION_KEY);
const isPreview = () =>
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && !getSession();

let feedPosts = [];
let feedHistory = [];
let feedTags = [];
let selectedTag = 'all';
let historyPage = 0;
let marketData = { fng: null, mvrv: null };
let marqueeTimer = null;

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
function setThemePref(pref) {
  if (pref === 'system') localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, pref);
  applyTheme();
  renderMarket();
  renderMenuState();
}
if (window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themePref() === 'system') { applyTheme(); renderMarket(); }
  });
}

// ── i18n glue ─────────────────────────────────────────────────────────
function applyStaticText() {
  $('login-subtitle').textContent = I18N.t('login.subtitle');
  $('login-hint').textContent = I18N.t('login.hint');
  $('brand-title').textContent = I18N.t('header.title');
  renderMenuState();
}
function onLangChange(lang) {
  if (lang === I18N.lang) return;
  I18N.set(lang);
  applyStaticText();
  renderMarket();
  if (isPreview()) { renderTags(); renderFeed(); return; }
  loadFeed();
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
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  google.accounts.id.renderButton($('google-btn'), {
    theme: dark ? 'filled_black' : 'outline', size: 'large', text: 'continue_with', shape: 'pill', logo_alignment: 'left',
  });
}
function signOut() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(AVATAR_KEY);
  localStorage.removeItem(NAME_KEY);
  localStorage.removeItem(EMAIL_KEY);
  if (marqueeTimer) clearInterval(marqueeTimer);
  $('user-menu').classList.add('hidden');
  showLogin();
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

// ── Popover menu ──────────────────────────────────────────────────────
function renderMenuState() {
  document.querySelectorAll('#menu-lang button').forEach((b) =>
    b.classList.toggle('active', b.dataset.lang === I18N.lang));
  const pref = themePref();
  document.querySelectorAll('#menu-theme button').forEach((b) =>
    b.classList.toggle('active', b.dataset.themePref === pref));
  $('menu-lang-label').textContent = I18N.t('menu.language');
  $('menu-theme-label').textContent = I18N.t('menu.appearance');
  const tp = (k) => document.querySelector(`#menu-theme [data-theme-pref="${k}"]`);
  tp('system').textContent = I18N.t('appearance.system');
  tp('light').textContent = I18N.t('appearance.light');
  tp('dark').textContent = I18N.t('appearance.dark');
  $('menu-logout').textContent = I18N.t('menu.logout');
}

// ── Views ─────────────────────────────────────────────────────────────
function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  applyStaticText();
  initGoogle();
}
function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('user-btn').replaceChildren(userAvatarNode());
  renderMenuUser();
  applyStaticText();
  startMarquee();
  loadMarket();
  if (isPreview()) { loadPreviewFeed(); } else { loadFeed(); }
}

// ── Price marquee (CoinGecko) ─────────────────────────────────────────
const COINS = [
  { id: 'bitcoin', sym: 'BTC' }, { id: 'ethereum', sym: 'ETH' }, { id: 'solana', sym: 'SOL' },
  { id: 'ripple', sym: 'XRP' }, { id: 'chainlink', sym: 'LINK' }, { id: 'hyperliquid', sym: 'HYPE' },
  { id: 'cardano', sym: 'ADA' }, { id: 'sui', sym: 'SUI' }, { id: 'dogecoin', sym: 'DOGE' },
];
function formatUsd(v) {
  if (v == null) return '—';
  if (v >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(4);
}
function formatChg(v) {
  if (v == null) return '';
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(1) + '%';
}
async function fetchPrices() {
  const ids = COINS.map((c) => c.id).join(',');
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}` +
    `&order=market_cap_desc&sparkline=false&price_change_percentage=24h`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`coingecko ${res.status}`);
  const rows = await res.json();
  const byId = {};
  rows.forEach((r) => { byId[r.id] = r; });
  return COINS.map((c) => {
    const r = byId[c.id] || {};
    return { sym: c.sym, price: r.current_price, chg: r.price_change_percentage_24h };
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
    const coins = await fetchPrices();
    const items = coins.map(marqueeItemHtml).join('');
    $('marquee-track').innerHTML = items + items + items;
  } catch (e) { /* keep previous prices */ }
}
function startMarquee() {
  refreshMarquee();
  if (marqueeTimer) clearInterval(marqueeTimer);
  marqueeTimer = setInterval(refreshMarquee, 120000);
}

// ── Market widget (Fear & Greed + MVRV) ───────────────────────────────
const FNG = {
  zones: [
    { max: 25, key: 'extremeFear', color: '#EF4444' }, { max: 45, key: 'fear', color: '#F7931A' },
    { max: 55, key: 'neutral', color: '#B0B0B0' }, { max: 75, key: 'greed', color: '#93C47D' },
    { max: 100, key: 'extremeGreed', color: '#22C55E' },
  ],
  weights: [25, 20, 10, 20, 25],
  progress: (v) => Math.min(Math.max(v, 0), 100) / 100,
};
const MVRV = {
  zones: [
    { max: 1.0, key: 'extremeUndervalued', color: '#22C55E' }, { max: 1.5, key: 'undervalued', color: '#93C47D' },
    { max: 2.4, key: 'fairValue', color: '#B0B0B0' }, { max: 3.5, key: 'overvalued', color: '#F7931A' },
    { max: Infinity, key: 'extremeOvervalued', color: '#EF4444' },
  ],
  weights: [20, 10, 18, 22, 30],
  progress: (v) => Math.min(Math.max((v / 5) * 100, 0), 100) / 100,
};
function activeZoneIndex(cfg, value) {
  for (let i = 0; i < cfg.zones.length; i++) if (value <= cfg.zones[i].max) return i;
  return cfg.zones.length - 1;
}
function buildGauge(cfg, value) {
  const C = 2 * Math.PI * 14, ARC = C * 0.75, GAP = 5;
  const activeIdx = activeZoneIndex(cfg, value);
  let start = 0, segs = '';
  for (let i = 0; i < cfg.zones.length; i++) {
    const len = (cfg.weights[i] / 100) * ARC;
    const dash = Math.max(len - GAP, 0.1);
    segs += `<circle cx="16" cy="16" r="14" fill="none" stroke="${cfg.zones[i].color}" stroke-width="4"` +
      ` stroke-linecap="round" stroke-dasharray="${dash.toFixed(2)} ${C.toFixed(2)}"` +
      ` stroke-dashoffset="${(-start).toFixed(2)}" stroke-opacity="${i === activeIdx ? 1 : 0.28}"/>`;
    start += len;
  }
  const theta = (135 + cfg.progress(value) * 270) * Math.PI / 180;
  const mx = 16 + 14 * Math.cos(theta), my = 16 + 14 * Math.sin(theta);
  const marker = `<circle class="gauge-marker" cx="${mx.toFixed(2)}" cy="${my.toFixed(2)}" r="3"` +
    ` fill="${cfg.zones[activeIdx].color}" stroke-width="1.5"/>`;
  return `<svg viewBox="0 0 32 32" width="32" height="32"><g transform="rotate(135 16 16)">${segs}</g>${marker}</svg>`;
}
function sectionHtml(cfg, titleKey, labelPrefix, value, valueText) {
  if (value == null) {
    return `<div class="market__section"><div class="market__title">${I18N.t(titleKey)}</div>
      <div class="market__value" style="color:var(--text-tertiary)">—</div>
      <div class="market__label" style="color:var(--text-tertiary)">${I18N.t('market.unavailable')}</div></div>`;
  }
  const idx = activeZoneIndex(cfg, value);
  const color = cfg.zones[idx].color;
  const label = I18N.t(labelPrefix + '.' + cfg.zones[idx].key);
  return `<div class="market__section"><div class="market__title">${I18N.t(titleKey)}</div>
    <div class="gauge-row">${buildGauge(cfg, value)}<span class="market__value" style="color:${color}">${valueText}</span></div>
    <div class="market__label" style="color:${color}">${label}</div></div>`;
}
function renderMarket() {
  const fng = marketData.fng, mvrv = marketData.mvrv;
  $('market').innerHTML =
    sectionHtml(FNG, 'market.fearGreed', 'fng', fng, fng == null ? '' : String(fng)) +
    `<div class="market__divider"></div>` +
    sectionHtml(MVRV, 'market.mvrv', 'mvrv', mvrv, mvrv == null ? '' : mvrv.toFixed(2));
}
async function loadMarket() {
  renderMarket();
  fetch(`${CONFIG.workerBase}/web/fng`).then((r) => r.json())
    .then((d) => { if (typeof d.value === 'number') { marketData.fng = d.value; renderMarket(); } }).catch(() => {});
  fetch(`${CONFIG.workerBase}/web/mvrv`).then((r) => r.json())
    .then((d) => { if (typeof d.value === 'number') { marketData.mvrv = d.value; renderMarket(); } }).catch(() => {});
}

// ── Tag filter ────────────────────────────────────────────────────────
const NOTION_TAG_HEX = {
  default: '#F15B24', gray: '#9B9B9B', brown: '#BA856F', orange: '#FFA344', yellow: '#FFDC49',
  green: '#6DB87E', blue: '#529CCA', purple: '#A475C2', pink: '#E255A1', red: '#FF7369',
};
function renderTags() {
  const bar = $('tagbar');
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  const pills = [{ name: 'all', label: I18N.t('filters.all'), color: 'default' }]
    .concat(feedTags.map((t) => ({ name: t.name, label: t.name, color: t.color })));
  bar.replaceChildren();
  pills.forEach((p) => {
    const btn = el('button', 'tag-pill', p.label);
    if (selectedTag === p.name) {
      btn.classList.add('selected');
      const hex = NOTION_TAG_HEX[p.color] || NOTION_TAG_HEX.default;
      btn.style.background = rgba(hex, dark ? 0.3 : 0.15);
      btn.style.color = hex;
    }
    btn.addEventListener('click', () => { selectedTag = p.name; renderTags(); renderFeed(); });
    bar.appendChild(btn);
  });
}

// ── Notion block renderer (raw block JSON) ────────────────────────────
function richText(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.map((t) => {
    let html = escapeHtml(t.plain_text || '');
    const a = t.annotations || {};
    if (a.code) html = `<code>${html}</code>`;
    if (a.bold) html = `<strong>${html}</strong>`;
    if (a.italic) html = `<em>${html}</em>`;
    if (a.strikethrough) html = `<s>${html}</s>`;
    if (a.underline) html = `<u>${html}</u>`;
    if (a.color && a.color !== 'default') {
      if (a.color.endsWith('_background')) {
        const hex = NOTION_TAG_HEX[a.color.replace('_background', '')] || NOTION_TAG_HEX.default;
        html = `<span style="background:${rgba(hex, 0.2)};padding:0 2px;border-radius:3px">${html}</span>`;
      } else {
        const hex = NOTION_TAG_HEX[a.color];
        if (hex) html = `<span style="color:${hex}">${html}</span>`;
      }
    }
    const href = t.href || (t.text && t.text.link && t.text.link.url);
    if (href) html = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${html}</a>`;
    return html;
  }).join('');
}
function blockText(b) { const d = b[b.type]; return d ? richText(d.rich_text) : ''; }
function imgUrl(d) { return d ? (d.external ? d.external.url : d.file ? d.file.url : null) : null; }
function hostname(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return url; } }
function youtubeEmbed(url) {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([\w-]{11})/);
  return m ? `https://www.youtube.com/embed/${m[1]}` : null;
}

function renderBlocks(blocks) {
  let html = '', listType = null, listItems = '';
  const flushList = () => {
    if (listType) { html += `<${listType}>${listItems}</${listType}>`; listType = null; listItems = ''; }
  };
  for (const b of blocks || []) {
    const t = b.type;
    if (t === 'bulleted_list_item' || t === 'numbered_list_item' || t === 'to_do') {
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
      case 'paragraph': { const x = blockText(b); if (x || kids) html += `<p>${x}</p>${kids}`; break; }
      case 'heading_1': html += `<h1>${blockText(b)}</h1>`; break;
      case 'heading_2': html += `<h2>${blockText(b)}</h2>`; break;
      case 'heading_3': html += `<h3>${blockText(b)}</h3>`; break;
      case 'quote': html += `<blockquote>${blockText(b)}${kids}</blockquote>`; break;
      case 'callout': {
        const icon = b.callout && b.callout.icon && b.callout.icon.emoji ? b.callout.icon.emoji : '💡';
        html += `<div class="callout"><span class="callout-emoji">${escapeHtml(icon)}</span><div>${blockText(b)}${kids}</div></div>`;
        break;
      }
      case 'toggle': html += `<details><summary>${blockText(b)}</summary>${kids}</details>`; break;
      case 'code': html += `<pre><code>${escapeHtml((b.code.rich_text || []).map((r) => r.plain_text).join(''))}</code></pre>`; break;
      case 'divider': html += '<hr class="nb-hr"/>'; break;
      case 'image': {
        const u = imgUrl(b.image);
        if (u) {
          const cap = b.image && b.image.caption && b.image.caption.length ? richText(b.image.caption) : '';
          html += `<figure class="nb-figure"><img src="${escapeHtml(u)}" loading="lazy" alt=""/>${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`;
        }
        break;
      }
      case 'video': {
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
        const d = b[t], u = d && d.url;
        if (u) {
          const cap = d.caption && d.caption.length ? richText(d.caption) : escapeHtml(u);
          html += `<a class="nb-bookmark" href="${escapeHtml(u)}" target="_blank" rel="noopener"><span class="nb-bookmark-title">${cap}</span><span class="nb-bookmark-url">${escapeHtml(hostname(u))}</span></a>`;
        }
        break;
      }
      case 'table': {
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
        const cols = (b.children || []).filter((c) => c.type === 'column');
        if (cols.length) html += `<div class="nb-columns">${cols.map((c) => `<div class="nb-column">${renderBlocks(c.children || [])}</div>`).join('')}</div>`;
        break;
      }
      case 'equation': html += `<pre class="nb-eq"><code>${escapeHtml(b.equation ? b.equation.expression : '')}</code></pre>`; break;
      default: break; // chart_embed / price_widget / unsupported_widget → app-only, skipped
    }
  }
  flushList();
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
  let html = post.icon ? `<span class="emoji">${escapeHtml(post.icon)}</span>` : '';
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
    const img = el('img', 'card__cover');
    img.src = post.cover; img.alt = ''; img.loading = 'lazy';
    img.onerror = () => img.remove();
    card.appendChild(img);
  }
  const body = el('div', 'card__body');
  body.appendChild(authorRow(post));
  const title = el('h2', 'card__title');
  title.innerHTML = titleHtml(post);
  body.appendChild(title);

  const preview = el('div', 'card__preview');
  if (post.previewBlocks && post.previewBlocks.length) preview.innerHTML = renderBlocks(post.previewBlocks);
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
function renderFeed() {
  const list = $('feed-list');
  const posts = selectedTag === 'all'
    ? feedPosts
    : feedPosts.filter((p) => (p.tags || []).some((t) => t.name === selectedTag));
  if (!posts.length) {
    list.replaceChildren(stateNode(I18N.t('empty.message'), I18N.t('empty.hint')));
  } else {
    const frag = document.createDocumentFragment();
    posts.forEach((p) => frag.appendChild(renderCard(p)));
    list.replaceChildren(frag);
  }
  renderHistory();
}
function renderHistory() {
  const sec = $('history');
  // History is the "older posts" list; hidden while a tag filter is active (full cards only).
  if (selectedTag !== 'all' || !feedHistory.length) { sec.classList.add('hidden'); sec.replaceChildren(); return; }
  sec.classList.remove('hidden');
  const totalPages = Math.ceil(feedHistory.length / HISTORY_PAGE_SIZE);
  if (historyPage >= totalPages) historyPage = totalPages - 1;
  const rows = feedHistory.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE);
  sec.replaceChildren();
  sec.appendChild(el('div', 'history__header', I18N.t('older.title')));
  rows.forEach((p) => {
    const row = el('button', 'history__row');
    const icon = el('div', 'history__icon');
    if (p.icon) icon.textContent = p.icon; else icon.innerHTML = docIconSvg();
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
async function loadFeed() {
  $('feed-list').replaceChildren(skeletons(3));
  $('history').classList.add('hidden');
  let res;
  try {
    res = await fetch(`${CONFIG.workerBase}/web/feed?lang=${I18N.notionLang}`, {
      headers: { Authorization: `Bearer ${getSession()}` },
    });
  } catch (e) { $('feed-list').replaceChildren(stateNode(I18N.t('offline.message'), null, loadFeed)); return; }
  if (res.status === 401) { localStorage.removeItem(SESSION_KEY); showLogin(); return; }
  if (!res.ok) { $('feed-list').replaceChildren(stateNode(I18N.t('error.title'), I18N.t('error.message'), loadFeed)); return; }
  const data = await res.json();
  feedPosts = data.posts || [];
  feedHistory = data.history || [];
  feedTags = data.tags || [];
  selectedTag = 'all';
  historyPage = 0;
  renderTags();
  renderFeed();
}

// ── Post detail modal ─────────────────────────────────────────────────
function openModal() { $('modal').classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
function closeModal() { $('modal').classList.add('hidden'); document.body.style.overflow = ''; }
function renderPostModal(post) {
  const c = $('modal-content');
  c.replaceChildren();
  if (post.cover) {
    const img = el('img', 'modal__cover');
    img.src = post.cover; img.alt = ''; img.onerror = () => img.remove();
    c.appendChild(img);
  }
  const body = el('div', 'modal__body');
  body.appendChild(authorRow(post));
  const title = el('h1', 'modal__title');
  title.innerHTML = titleHtml(post);
  body.appendChild(title);
  const content = el('div', 'modal__content');
  content.innerHTML = renderBlocks(post.blocks || post.previewBlocks || []);
  body.appendChild(content);
  c.appendChild(body);
  c.scrollTop = 0;
}
async function openPost(id) {
  openModal();
  $('modal-content').innerHTML = `<div class="modal__state">…</div>`;
  if (isPreview()) {
    const m = feedPosts.find((p) => p.id === id) || feedHistory.find((p) => p.id === id);
    if (m) renderPostModal(m); else $('modal-content').innerHTML = `<div class="modal__state">${I18N.t('modal.error')}</div>`;
    return;
  }
  try {
    const res = await fetch(`${CONFIG.workerBase}/web/post?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${getSession()}` },
    });
    if (res.status === 401) { closeModal(); localStorage.removeItem(SESSION_KEY); showLogin(); return; }
    if (!res.ok) throw new Error();
    renderPostModal(await res.json());
  } catch (e) {
    $('modal-content').innerHTML = `<div class="modal__state">${I18N.t('modal.error')}</div>`;
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
    icon: ['📰', '📉', '🧠', '🪙', '⚡'][i % 5],
    publishedAt: new Date(Date.now() - (i + 2) * 86400000).toISOString(),
  }));
  selectedTag = 'all';
  historyPage = 0;
  renderTags();
  renderFeed();
}

// ── Boot ──────────────────────────────────────────────────────────────
applyTheme();
$('user-btn').addEventListener('click', (e) => { e.stopPropagation(); $('user-menu').classList.toggle('hidden'); });
document.addEventListener('click', (e) => {
  if (!$('user-menu').classList.contains('hidden') && !$('user') .contains(e.target)) $('user-menu').classList.add('hidden');
});
document.querySelectorAll('#menu-lang button').forEach((b) =>
  b.addEventListener('click', () => onLangChange(b.dataset.lang)));
document.querySelectorAll('#menu-theme button').forEach((b) =>
  b.addEventListener('click', () => setThemePref(b.dataset.themePref)));
$('menu-logout').addEventListener('click', signOut);
$('modal-close').addEventListener('click', closeModal);
$('modal-backdrop').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

if (getSession() || isPreview()) { showApp(); } else { showLogin(); }
