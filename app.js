// Crypto Bros website — Google sign-in → gated feed from the Cloudflare Worker.
'use strict';

const CONFIG = {
  workerBase: 'https://crypto-bros-notion-proxy.crypto-bros.workers.dev',
  googleClientId: '947303618125-0k85q1ds1g8gfq3njtgsh1nc8ihug94p.apps.googleusercontent.com',
};

const SESSION_KEY = 'cb-session';
const THEME_KEY = 'cb-theme';

const $ = (id) => document.getElementById(id);
const getSession = () => localStorage.getItem(SESSION_KEY);
const setSession = (t) => localStorage.setItem(SESSION_KEY, t);
const clearSession = () => localStorage.removeItem(SESSION_KEY);

// ── Theme toggle ──────────────────────────────────────────────────────
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem(THEME_KEY, next);
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
    setSession(data.session);
    showFeed();
  } catch (e) {
    errorEl.textContent = 'Não foi possível entrar. Tente novamente.';
    errorEl.classList.remove('hidden');
  }
}

function initGoogle() {
  if (!window.google || !google.accounts) {
    // GIS script not ready yet — retry shortly.
    setTimeout(initGoogle, 200);
    return;
  }
  google.accounts.id.initialize({
    client_id: CONFIG.googleClientId,
    callback: onGoogleCredential,
    ux_mode: 'popup',
  });
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  google.accounts.id.renderButton($('google-btn'), {
    theme: dark ? 'filled_black' : 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'pill',
    logo_alignment: 'left',
  });
}

function signOut() {
  clearSession();
  showLogin();
}

// ── Views ─────────────────────────────────────────────────────────────
function showLogin() {
  $('app').classList.add('hidden');
  $('login').classList.remove('hidden');
  initGoogle();
}

function showFeed() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  loadFeed();
}

// ── Feed ──────────────────────────────────────────────────────────────
const CATEGORY_KNOWN = new Set(['Mercado', 'Estudos', 'Altcoins', 'Trade', 'Video', 'ATH', 'Mais']);

// Notion multi_select colors → hex (mirrors the app's palette intent).
const NOTION_HEX = {
  default: '#A1A1AA', gray: '#A1A1AA', brown: '#B08968', orange: '#F15B24',
  yellow: '#EAB308', green: '#34D399', blue: '#60A5FA', purple: '#A78BFA',
  pink: '#F472B6', red: '#F87171',
};

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const dateFmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
function formatDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : dateFmt.format(d).replace('.', '');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function categoryPill(name) {
  const pill = el('span', 'pill', name);
  if (CATEGORY_KNOWN.has(name)) {
    const color = getComputedStyle(document.documentElement).getPropertyValue(`--cat-${name}`).trim();
    if (color) {
      pill.style.setProperty('--pill-fg', color);
      pill.style.setProperty('--pill-bg', rgba(color, 0.15));
    }
  }
  return pill;
}

function tagPill(tag) {
  const pill = el('span', 'pill', tag.name);
  const hex = NOTION_HEX[tag.color] || NOTION_HEX.default;
  pill.style.setProperty('--pill-fg', hex);
  pill.style.setProperty('--pill-bg', rgba(hex, 0.13));
  return pill;
}

function renderCard(post) {
  const card = el('article', 'card');

  if (post.cover) {
    const img = el('img', 'card__cover');
    img.src = post.cover;
    img.loading = 'lazy';
    img.alt = '';
    img.onerror = () => img.remove();
    card.appendChild(img);
  }

  const body = el('div', 'card__body');

  const pills = [...post.categories.map(categoryPill), ...post.tags.map(tagPill)];
  if (pills.length) {
    const row = el('div', 'card__cats');
    pills.forEach((p) => row.appendChild(p));
    body.appendChild(row);
  }

  const title = el('h2', 'card__title');
  if (post.icon) {
    const emoji = el('span', 'emoji', post.icon);
    title.appendChild(emoji);
  }
  title.appendChild(document.createTextNode(post.title || 'Sem título'));
  body.appendChild(title);

  if (post.excerpt) body.appendChild(el('p', 'card__excerpt', post.excerpt));
  if (post.publishedAt) body.appendChild(el('p', 'card__meta', formatDate(post.publishedAt)));

  card.appendChild(body);
  return card;
}

function renderSkeletons(n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < n; i++) {
    const card = el('article', 'card skeleton');
    card.appendChild(el('div', 'card__cover'));
    const body = el('div', 'card__body');
    body.appendChild(el('div', 'sk-line title'));
    body.appendChild(el('div', 'sk-line'));
    body.appendChild(el('div', 'sk-line short'));
    card.appendChild(body);
    frag.appendChild(card);
  }
  return frag;
}

function renderState(message, retry) {
  const wrap = el('div', 'state', message);
  if (retry) {
    const btn = el('button', null, 'Tentar de novo');
    btn.onclick = retry;
    wrap.appendChild(document.createElement('br'));
    wrap.appendChild(btn);
  }
  return wrap;
}

async function loadFeed() {
  const feed = $('feed');
  feed.replaceChildren(renderSkeletons(3));

  let res;
  try {
    res = await fetch(`${CONFIG.workerBase}/web/feed`, {
      headers: { Authorization: `Bearer ${getSession()}` },
    });
  } catch (e) {
    feed.replaceChildren(renderState('Sem conexão.', loadFeed));
    return;
  }

  if (res.status === 401) {
    clearSession();
    showLogin();
    return;
  }
  if (!res.ok) {
    feed.replaceChildren(renderState('Não foi possível carregar o feed.', loadFeed));
    return;
  }

  const { posts } = await res.json();
  if (!posts || posts.length === 0) {
    feed.replaceChildren(renderState('Nenhum post por aqui ainda.'));
    return;
  }

  const frag = document.createDocumentFragment();
  posts.forEach((p) => frag.appendChild(renderCard(p)));
  feed.replaceChildren(frag);
}

// ── Boot ──────────────────────────────────────────────────────────────
$('theme-btn').addEventListener('click', toggleTheme);
$('signout-btn').addEventListener('click', signOut);

if (getSession()) {
  showFeed();
} else {
  showLogin();
}
