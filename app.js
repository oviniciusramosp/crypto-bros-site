// Crypto Bros website — Google sign-in → gated Feed (marquee, F&G/MVRV, tags, posts).
'use strict';

const CONFIG = {
  workerBase: 'https://crypto-bros-notion-proxy.crypto-bros.workers.dev',
  googleClientId: '947303618125-0k85q1ds1g8gfq3njtgsh1nc8ihug94p.apps.googleusercontent.com',
};

const SESSION_KEY = 'cb-session';
const THEME_KEY = 'cb-theme';
const $ = (id) => document.getElementById(id);
const getSession = () => localStorage.getItem(SESSION_KEY);
const isPreview = () =>
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1') && !getSession();

// Module state so tag-filter / language changes can re-render without refetching.
let feedPosts = [];
let feedTags = [];
let selectedTag = 'all';
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

// ── Theme + language ──────────────────────────────────────────────────
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);
  renderMarket(); // gauge marker stroke = surface color
}

function applyStaticText() {
  $('login-subtitle').textContent = I18N.t('login.subtitle');
  $('login-hint').textContent = I18N.t('login.hint');
  $('brand-title').textContent = I18N.t('header.title');
  document.querySelectorAll('#lang-toggle button').forEach((b) =>
    b.classList.toggle('active', b.dataset.lang === I18N.lang));
}

function onLangChange(lang) {
  if (lang === I18N.lang) return;
  I18N.set(lang);
  applyStaticText();
  renderMarket();          // re-label F&G/MVRV
  if (isPreview()) { renderTags(); renderFeed(); return; }
  loadFeed();              // re-query Notion with the new Language filter
}

// ── Auth ──────────────────────────────────────────────────────────────
async function onGoogleCredential(response) {
  const errorEl = $('login-error');
  errorEl.classList.add('hidden');
  try {
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
  google.accounts.id.initialize({
    client_id: CONFIG.googleClientId, callback: onGoogleCredential, ux_mode: 'popup',
  });
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  google.accounts.id.renderButton($('google-btn'), {
    theme: dark ? 'filled_black' : 'outline', size: 'large',
    text: 'continue_with', shape: 'pill', logo_alignment: 'left',
  });
}

function signOut() {
  localStorage.removeItem(SESSION_KEY);
  if (marqueeTimer) clearInterval(marqueeTimer);
  showLogin();
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
  applyStaticText();
  startMarquee();
  loadMarket();
  if (isPreview()) { loadPreviewFeed(); } else { loadFeed(); }
}

// ── Price marquee (CoinGecko — CORS-friendly, keyless) ────────────────
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
    $('marquee-track').innerHTML = items + items + items; // triplicated for seamless loop
  } catch (e) { /* keep previous prices; retry next cycle */ }
}
function startMarquee() {
  refreshMarquee();
  if (marqueeTimer) clearInterval(marqueeTimer);
  marqueeTimer = setInterval(refreshMarquee, 120000);
}

// ── Market widget (Fear & Greed + MVRV) ───────────────────────────────
const FNG = {
  zones: [
    { max: 25, key: 'extremeFear', color: '#EF4444' },
    { max: 45, key: 'fear', color: '#F7931A' },
    { max: 55, key: 'neutral', color: '#B0B0B0' },
    { max: 75, key: 'greed', color: '#93C47D' },
    { max: 100, key: 'extremeGreed', color: '#22C55E' },
  ],
  weights: [25, 20, 10, 20, 25],
  progress: (v) => Math.min(Math.max(v, 0), 100) / 100,
};
const MVRV = {
  zones: [
    { max: 1.0, key: 'extremeUndervalued', color: '#22C55E' },
    { max: 1.5, key: 'undervalued', color: '#93C47D' },
    { max: 2.4, key: 'fairValue', color: '#B0B0B0' },
    { max: 3.5, key: 'overvalued', color: '#F7931A' },
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
    return `<div class="market__section">
      <div class="market__title">${I18N.t(titleKey)}</div>
      <div class="market__value" style="color:var(--text-tertiary)">—</div>
      <div class="market__label" style="color:var(--text-tertiary)">${I18N.t('market.unavailable')}</div>
    </div>`;
  }
  const idx = activeZoneIndex(cfg, value);
  const color = cfg.zones[idx].color;
  const label = I18N.t(labelPrefix + '.' + cfg.zones[idx].key);
  return `<div class="market__section">
    <div class="market__title">${I18N.t(titleKey)}</div>
    <div class="gauge-row">
      ${buildGauge(cfg, value)}
      <span class="market__value" style="color:${color}">${valueText}</span>
    </div>
    <div class="market__label" style="color:${color}">${label}</div>
  </div>`;
}
function renderMarket() {
  const fng = marketData.fng, mvrv = marketData.mvrv;
  $('market').innerHTML =
    sectionHtml(FNG, 'market.fearGreed', 'fng', fng == null ? null : fng, fng == null ? '' : String(fng)) +
    `<div class="market__divider"></div>` +
    sectionHtml(MVRV, 'market.mvrv', 'mvrv', mvrv == null ? null : mvrv, mvrv == null ? '' : mvrv.toFixed(2));
}
async function loadMarket() {
  renderMarket();
  // Both proxied through the Worker (cached, CORS-safe, no client-side API variance).
  fetch(`${CONFIG.workerBase}/web/fng`)
    .then((r) => r.json())
    .then((d) => { if (typeof d.value === 'number') { marketData.fng = d.value; renderMarket(); } })
    .catch(() => {});
  fetch(`${CONFIG.workerBase}/web/mvrv`)
    .then((r) => r.json())
    .then((d) => { if (typeof d.value === 'number') { marketData.mvrv = d.value; renderMarket(); } })
    .catch(() => {});
}

// ── Tag filter bar ────────────────────────────────────────────────────
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
    btn.addEventListener('click', () => {
      selectedTag = p.name;
      renderTags();
      renderFeed();
    });
    bar.appendChild(btn);
  });
}

// ── Notion block preview renderer (raw Notion block JSON) ─────────────
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

function renderBlocks(blocks) {
  let html = '', listType = null, listItems = '';
  const flushList = () => {
    if (listType) { html += `<${listType}>${listItems}</${listType}>`; listType = null; listItems = ''; }
  };
  for (const b of blocks) {
    const t = b.type;
    if (t === 'bulleted_list_item' || t === 'numbered_list_item' || t === 'to_do') {
      const tag = t === 'numbered_list_item' ? 'ol' : 'ul';
      if (listType && listType !== tag) flushList();
      listType = tag;
      const check = t === 'to_do' ? (b.to_do && b.to_do.checked ? '☑ ' : '☐ ') : '';
      listItems += `<li>${check}${blockText(b)}</li>`;
      continue;
    }
    flushList();
    switch (t) {
      case 'paragraph': { const x = blockText(b); if (x) html += `<p>${x}</p>`; break; }
      case 'heading_1': html += `<h1>${blockText(b)}</h1>`; break;
      case 'heading_2': html += `<h2>${blockText(b)}</h2>`; break;
      case 'heading_3': html += `<h3>${blockText(b)}</h3>`; break;
      case 'quote': html += `<blockquote>${blockText(b)}</blockquote>`; break;
      case 'callout': {
        const icon = b.callout && b.callout.icon && b.callout.icon.emoji ? b.callout.icon.emoji : '💡';
        html += `<div class="callout"><span class="callout-emoji">${escapeHtml(icon)}</span><div>${blockText(b)}</div></div>`;
        break;
      }
      case 'code': html += `<pre><code>${escapeHtml((b.code.rich_text || []).map((r) => r.plain_text).join(''))}</code></pre>`; break;
      case 'image': { const u = imgUrl(b.image); if (u) html += `<img src="${escapeHtml(u)}" loading="lazy" alt=""/>`; break; }
      default: break; // divider, chart_embed, price_widget, video, table, bookmark → skipped
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
  if (src) {
    const img = el('img', 'avatar');
    img.src = src; img.alt = '';
    return img;
  }
  const ph = el('div', 'avatar avatar--ph', name.charAt(0).toUpperCase());
  return ph;
}
// Title may embed [TAG] chips (e.g. [LONG]/[SHORT]) inline — mirror the app.
function titleHtml(post) {
  let html = post.icon ? `<span class="emoji">${escapeHtml(post.icon)}</span>` : '';
  const parts = (post.title || '').split(/(\[[^\]]+\])/);
  for (const part of parts) {
    const m = part.match(/^\[([^\]]+)\]$/);
    if (m) {
      const tag = m[1].toUpperCase();
      const color = tag === 'LONG' ? '#22C55E' : tag === 'SHORT' ? '#EF4444' : '#6B7280';
      html += `<span class="title-chip" style="background:${color}">${escapeHtml(m[1])}</span>`;
    } else if (part) {
      html += escapeHtml(part);
    }
  }
  return html;
}
function renderCard(post) {
  const card = el('article', 'card');
  if (post.cover) {
    const img = el('img', 'card__cover');
    img.src = post.cover; img.alt = ''; img.loading = 'lazy';
    img.onerror = () => img.remove();
    card.appendChild(img);
  }
  const body = el('div', 'card__body');

  const author = el('div', 'card__author');
  const left = el('div', 'card__author-left');
  left.appendChild(avatarNode(post.author));
  left.appendChild(el('span', 'card__author-name', (post.author && post.author.name) || 'Crypto Bros'));
  author.appendChild(left);
  author.appendChild(el('span', 'card__date', I18N.formatDate(post.publishedAt)));
  body.appendChild(author);

  const title = el('h2', 'card__title');
  title.innerHTML = titleHtml(post);
  body.appendChild(title);

  const preview = el('div', 'card__preview');
  if (post.previewBlocks && post.previewBlocks.length) {
    preview.innerHTML = renderBlocks(post.previewBlocks);
  } else if (post.excerpt) {
    const p = el('p', 'excerpt-clamp', post.excerpt);
    preview.appendChild(p);
  }
  if (preview.childNodes.length || preview.innerHTML) body.appendChild(preview);

  if (post.hasDivider) {
    const more = el('div', 'card__more');
    const btn = el('button');
    btn.innerHTML = `${escapeHtml(I18N.t('post.readMore'))}` +
      `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
    // No detail page yet — button is visual parity for now.
    more.appendChild(btn);
    body.appendChild(more);
  }

  card.appendChild(body);
  return card;
}

// ── Feed ──────────────────────────────────────────────────────────────
function renderFeed() {
  const list = $('feed-list');
  const posts = selectedTag === 'all'
    ? feedPosts
    : feedPosts.filter((p) => (p.tags || []).some((t) => t.name === selectedTag));
  if (!posts.length) {
    list.replaceChildren(stateNode(I18N.t('empty.message'), I18N.t('empty.hint')));
    return;
  }
  const frag = document.createDocumentFragment();
  posts.forEach((p) => frag.appendChild(renderCard(p)));
  list.replaceChildren(frag);
}
function stateNode(title, hint, retry) {
  const wrap = el('div', 'state');
  wrap.appendChild(el('h3', null, title));
  if (hint) wrap.appendChild(el('div', null, hint));
  if (retry) {
    const btn = el('button', null, I18N.t('error.retry'));
    btn.onclick = retry;
    wrap.appendChild(btn);
  }
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
  let res;
  try {
    res = await fetch(`${CONFIG.workerBase}/web/feed?lang=${I18N.notionLang}`, {
      headers: { Authorization: `Bearer ${getSession()}` },
    });
  } catch (e) {
    $('feed-list').replaceChildren(stateNode(I18N.t('offline.message'), null, loadFeed));
    return;
  }
  if (res.status === 401) { localStorage.removeItem(SESSION_KEY); showLogin(); return; }
  if (!res.ok) {
    $('feed-list').replaceChildren(stateNode(I18N.t('error.title'), I18N.t('error.message'), loadFeed));
    return;
  }
  const data = await res.json();
  feedPosts = data.posts || [];
  feedTags = data.tags || [];
  selectedTag = 'all';
  renderTags();
  renderFeed();
}

// ── Preview (localhost, no real session) ──────────────────────────────
function loadPreviewFeed() {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
  const dayAgo = new Date(Date.now() - 26 * 3600000).toISOString();
  feedTags = [
    { name: 'Notícias', color: 'blue' }, { name: 'Análises', color: 'purple' },
    { name: 'Trade', color: 'green' }, { name: 'Bitcoin', color: 'orange' },
  ];
  feedPosts = [
    {
      id: 'm1', title: 'Bitcoin rompe resistência e mira nova máxima', icon: '🚀', cover: null,
      author: { name: 'Crypto Bros', avatar: null }, tags: [{ name: 'Notícias', color: 'blue' }],
      publishedAt: twoHoursAgo, hasDivider: true, excerpt: '',
      previewBlocks: [
        { type: 'paragraph', paragraph: { rich_text: [
          { plain_text: 'O par ', annotations: {} },
          { plain_text: 'BTC/USD', annotations: { bold: true } },
          { plain_text: ' superou os US$ 72 mil com volume crescente.', annotations: {} },
        ] } },
        { type: 'heading_3', heading_3: { rich_text: [{ plain_text: 'Pontos-chave', annotations: {} }] } },
        { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Rompimento com volume acima da média', annotations: {} }] } },
        { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Fundamentos on-chain sólidos', annotations: {} }] } },
      ],
    },
    {
      id: 'm2', title: 'Entendendo liquidez em pools automatizadas', icon: '📚', cover: null,
      author: { name: 'Vini Ramos', avatar: null }, tags: [{ name: 'Análises', color: 'purple' }],
      publishedAt: dayAgo, hasDivider: false,
      excerpt: 'Um guia direto sobre AMMs, impermanent loss e como avaliar o risco real de prover liquidez em protocolos descentralizados.',
      previewBlocks: [],
    },
    {
      id: 'm3', title: '[LONG] Setup de continuação no gráfico de 4h', icon: '📈', cover: null,
      author: { name: 'Crypto Bros', avatar: null }, tags: [{ name: 'Trade', color: 'green' }],
      publishedAt: dayAgo, hasDivider: true, excerpt: '',
      previewBlocks: [
        { type: 'callout', callout: { icon: { emoji: '⚠️' }, rich_text: [{ plain_text: 'Não é recomendação de investimento.', annotations: { italic: true } }] } },
        { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Estrutura de alta preservada, pullback na média de 50 e gatilho acima do topo anterior.', annotations: {} }] } },
      ],
    },
  ];
  selectedTag = 'all';
  renderTags();
  renderFeed();
}

// ── Boot ──────────────────────────────────────────────────────────────
$('theme-btn').addEventListener('click', toggleTheme);
$('signout-btn').addEventListener('click', signOut);
document.querySelectorAll('#lang-toggle button').forEach((b) =>
  b.addEventListener('click', () => onLangChange(b.dataset.lang)));

if (getSession() || isPreview()) { showApp(); } else { showLogin(); }
