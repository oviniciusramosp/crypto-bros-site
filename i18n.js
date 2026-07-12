// i18n for the Crypto Bros site — PT/EN, mirrors the app's feed/dates/widgets strings.
'use strict';

const STRINGS = {
  pt: {
    'header.title': 'Feed',
    'login.subtitle': 'Entre para acessar o feed.',
    'login.hint': 'Primeiro acesso? Sua conta é criada automaticamente ao entrar com o Google.',
    'login.error': 'Não foi possível entrar. Tente novamente.',
    'login.google': 'Continuar com o Google',
    'filters.all': 'Tudo',
    'empty.message': 'Nada Encontrado',
    'empty.hint': 'Tente outro filtro ou volte mais tarde.',
    'error.title': 'Erro ao carregar',
    'error.message': 'Não foi possível carregar os posts. Verifique sua conexão e tente novamente.',
    'error.retry': 'Tentar de novo',
    'offline.message': 'Sem conexão.',
    'post.readMore': 'Continuar Lendo',
    'older.title': 'Mais antigos',
    'menu.language': 'Idioma',
    'menu.appearance': 'Aparência',
    'appearance.system': 'Sistema',
    'appearance.light': 'Claro',
    'appearance.dark': 'Escuro',
    'menu.logout': 'Sair',
    'modal.error': 'Não foi possível abrir o post.',
    'share.copied': 'Link copiado',
    'banner.install': 'Baixe o app Crypto Bros',
    'banner.cta': 'Abrir',
    'notif.enable': 'Ativar notificações',
    'notif.enabled': 'Notificações ativas',
    'notif.blocked': 'Notificações bloqueadas no navegador',
    'market.fearGreed': 'Fear & Greed',
    'market.mvrv': 'MVRV',
    'market.unavailable': 'Indisponível',
    'fng.extremeFear': 'Medo Extremo',
    'fng.fear': 'Medo',
    'fng.neutral': 'Neutro',
    'fng.greed': 'Ganância',
    'fng.extremeGreed': 'Ganância Extrema',
    'mvrv.extremeUndervalued': 'Extremamente Subvalorizado',
    'mvrv.undervalued': 'Subvalorizado',
    'mvrv.fairValue': 'Valor Justo',
    'mvrv.overvalued': 'Sobrevalorizado',
    'mvrv.extremeOvervalued': 'Extremamente Sobrevalorizado',
    'date.minutesAgo': '{n}min atrás',
    'date.hoursAgo': '{n}h atrás',
    'date.today': 'Hoje',
    'date.yesterday': 'Ontem',
  },
  en: {
    'header.title': 'Feed',
    'login.subtitle': 'Sign in to access the feed.',
    'login.hint': 'First time? Your account is created automatically when you sign in with Google.',
    'login.error': "Couldn't sign in. Please try again.",
    'login.google': 'Continue with Google',
    'filters.all': 'All',
    'empty.message': 'Nothing Found',
    'empty.hint': 'Try another filter or come back later.',
    'error.title': 'Failed to load',
    'error.message': 'Could not load posts. Check your connection and try again.',
    'error.retry': 'Try again',
    'offline.message': 'No connection.',
    'post.readMore': 'Read More',
    'older.title': 'Older posts',
    'menu.language': 'Language',
    'menu.appearance': 'Appearance',
    'appearance.system': 'System',
    'appearance.light': 'Light',
    'appearance.dark': 'Dark',
    'menu.logout': 'Sign out',
    'modal.error': "Couldn't open the post.",
    'share.copied': 'Link copied',
    'banner.install': 'Get the Crypto Bros app',
    'banner.cta': 'Open',
    'notif.enable': 'Enable notifications',
    'notif.enabled': 'Notifications on',
    'notif.blocked': 'Notifications blocked in browser',
    'market.fearGreed': 'Fear & Greed',
    'market.mvrv': 'MVRV',
    'market.unavailable': 'Unavailable',
    'fng.extremeFear': 'Extreme Fear',
    'fng.fear': 'Fear',
    'fng.neutral': 'Neutral',
    'fng.greed': 'Greed',
    'fng.extremeGreed': 'Extreme Greed',
    'mvrv.extremeUndervalued': 'Extremely Undervalued',
    'mvrv.undervalued': 'Undervalued',
    'mvrv.fairValue': 'Fair Value',
    'mvrv.overvalued': 'Overvalued',
    'mvrv.extremeOvervalued': 'Extremely Overvalued',
    'date.minutesAgo': '{n}min ago',
    'date.hoursAgo': '{n}h ago',
    'date.today': 'Today',
    'date.yesterday': 'Yesterday',
  },
};

const LANG_KEY = 'cb-lang';

function resolveLang() {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'pt' || saved === 'en') return saved;
  } catch (e) {}
  try {
    return (navigator.language || 'pt').toLowerCase().startsWith('en') ? 'en' : 'pt';
  } catch (e) {
    return 'pt';
  }
}

let currentLang = resolveLang();

const I18N = {
  get lang() { return currentLang; },
  /** Notion Language select value for the current UI language. */
  get notionLang() { return currentLang === 'en' ? 'EN' : 'PT-BR'; },
  set(lang) {
    currentLang = lang === 'en' ? 'en' : 'pt';
    try { localStorage.setItem(LANG_KEY, currentLang); } catch (e) {}
  },
  t(key, vars) {
    let s = (STRINGS[currentLang] && STRINGS[currentLang][key]) || STRINGS.pt[key] || key;
    if (vars) for (const k in vars) s = s.replace('{' + k + '}', vars[k]);
    return s;
  },
  /** Relative date like the app: minutes, hours, then localized "d MMM". */
  formatDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return this.t('date.today');
    if (diffMin < 60) return this.t('date.minutesAgo', { n: diffMin });
    if (diffMin < 1440) return this.t('date.hoursAgo', { n: Math.floor(diffMin / 60) });
    const locale = currentLang === 'en' ? 'en-US' : 'pt-BR';
    return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' }).format(d).replace('.', '');
  },
};

window.I18N = I18N;
