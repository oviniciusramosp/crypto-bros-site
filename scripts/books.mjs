// Library (Biblioteca) maintenance CLI — adds and validates entries in data/books.json.
//
// Why this exists: affiliate links are the one thing on this site that silently rot.
// An ASIN gets repurposed to another product, a cover 404s, a Mercado Livre short link
// is forgotten — and the page keeps rendering a buy button that earns nothing or sends
// the reader to the wrong book. Everything here is a link check, not a scraper: it reads
// the same <meta name="title"> that WhatsApp/Slack read to build a preview, and pulls
// book metadata from Open Library's public API (no key, no credentials).
//
// There is NO product API in play. Amazon retired PA-API 5.0 in 2026; its replacement
// (Creators API) needs 10 qualifying sales in a rolling 30-day window plus OAuth
// credentials, and Mercado Livre publishes no affiliate API at all. Neither could live
// in this repo anyway — it is public, and the site has no backend of its own.
//
//   node scripts/books.mjs add <amazon-url|ASIN> [--ml <link>] [--title T] [--author A] [--tags a,b]
//   node scripts/books.mjs check
//   node scripts/books.mjs tag <seu-id-20>
//
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = join(ROOT, 'data', 'books.json');
const COVER_DIR = join(ROOT, 'assets', 'books');
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

// ── data/books.json ───────────────────────────────────────────────────
const EMPTY_DB = {
  affiliate: { amazonTag: '', amazonDomain: 'www.amazon.com.br' },
  books: [],
};

async function loadDb() {
  try {
    return JSON.parse(await readFile(DB, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return structuredClone(EMPTY_DB);
    throw e;
  }
}

async function saveDb(db) {
  await mkdir(dirname(DB), { recursive: true });
  await writeFile(DB, `${JSON.stringify(db, null, 2)}\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────
const slug = (s) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Pull the ASIN out of any amazon.com.br URL shape, or accept a bare ASIN. */
function parseAsin(input) {
  const raw = String(input || '').trim();
  if (/^[A-Z0-9]{10}$/i.test(raw)) return raw.toUpperCase();
  const m = raw.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})/i);
  if (m) return m[1].toUpperCase();
  const q = raw.match(/[?&]asin=([A-Z0-9]{10})/i);
  return q ? q[1].toUpperCase() : null;
}

/** A printed book's ASIN is its ISBN-10 — that is what unlocks Open Library. */
const isIsbn10 = (asin) => /^[0-9]{9}[0-9X]$/i.test(asin);

/** The tag already baked into a SiteStripe link, so pasting one configures the site. */
function parseAmazonTag(input) {
  try {
    return new URL(String(input)).searchParams.get('tag') || '';
  } catch (e) {
    return '';
  }
}

/**
 * Mercado Livre hands out several shapes for the same affiliate link — meli.la/<code>,
 * mercadolivre.com/sec/<code> and mercadolivre.com.br/social/<user>?matt_word=… — and
 * the product itself rides in an opaque `ref` blob. Match on host, never on path.
 */
const ML_HOSTS = /(^|\.)(meli\.la|mercadoli(?:v|b)re\.com(?:\.[a-z]{2})?)$/i;
function isMlLink(raw) {
  try {
    return ML_HOSTS.test(new URL(String(raw)).hostname);
  } catch (e) {
    return false;
  }
}

async function get(url, as = 'text') {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9' },
    redirect: 'follow',
  });
  if (!res.ok) return null;
  return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.text();
}

const decodeEntities = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();

/**
 * Reads the product page the way a link-preview crawler does.
 *
 * `<meta name="title">` comes in two shapes:
 *   "Title: subtitle | Amazon.com.br"
 *   "Title : Author, Name: Amazon.com.br: Livros"
 * HTTP status is useless here — an unknown ASIN still answers 200 with some other
 * book — so this string is the only thing that proves which product the link opens.
 *
 * Also lifts the byline authors and the hi-res cover URL, which is what SiteStripe
 * would hand you for the same product.
 */
async function amazonMeta(asin) {
  const html = await get(`https://www.amazon.com.br/dp/${asin}`);
  if (!html) return null;
  const rawMeta = (html.match(/<meta\s+name="title"\s+content="([^"]*)"/i) || [])[1];
  if (!rawMeta) return null;
  const raw = decodeEntities(rawMeta);

  let full = raw
    .replace(/\s*\|\s*Amazon\.com\.br.*$/i, '')
    .replace(/\s*:\s*Amazon\.com\.br:.*$/i, '')
    .trim();
  let bylineFromTitle = '';
  const split = full.match(/^(.*?)\s+:\s+(.+)$/);
  if (split) {
    full = split[1].trim();
    bylineFromTitle = split[2].trim();
  }
  // "O padrão bitcoin: a alternativa…" → title + subtitle, so the slug and the card
  // headline stay short while the subtitle survives as its own line.
  const colon = full.match(/^([^:]{3,}?):\s*(.+)$/);
  const title = colon ? colon[1].trim() : full;
  const subtitle = colon ? colon[2].trim() : '';

  // Byline: every <span class="author …"> whose contribution reads (Autor)/(Author).
  const authors = [];
  for (const block of html.match(/class="author[^"]*"[\s\S]{0,400}?<\/span>\s*<\/span>/g) || []) {
    if (!/\((?:Autor|Author)[^)]*\)/i.test(block)) continue;
    const name = (block.match(/<a[^>]*>([^<]{2,80})<\/a>/) || [])[1];
    if (name) authors.push(decodeEntities(name));
  }

  const image = (html.match(/data-old-hires="(https:\/\/m\.media-amazon\.com\/images\/[^"]+)"/) || [])[1] || '';

  return {
    raw,
    title,
    subtitle,
    author: authors.length ? [...new Set(authors)].join(', ') : bylineFromTitle,
    image,
  };
}

/** Open Library: free, documented, no key. Only reachable when the ASIN is an ISBN-10. */
async function openLibrary(isbn) {
  const json = await get(`https://openlibrary.org/isbn/${isbn}.json`);
  if (!json) return null;
  let book;
  try {
    book = JSON.parse(json);
  } catch (e) {
    return null;
  }
  const authors = [];
  for (const ref of book.authors || []) {
    const a = await get(`https://openlibrary.org${ref.key}.json`);
    if (!a) continue;
    try {
      authors.push(JSON.parse(a).name);
    } catch (e) {}
  }
  return {
    title: book.title || '',
    author: authors.join(', '),
    year: Number(String(book.publish_date || '').match(/\d{4}/)?.[0]) || null,
  };
}

async function saveCover(url, id) {
  const buf = await get(url, 'buffer');
  if (!buf || buf.length < 2000) return null; // tiny body = placeholder, not a cover
  await mkdir(COVER_DIR, { recursive: true });
  await writeFile(join(COVER_DIR, `${id}.jpg`), buf);
  return `./assets/books/${id}.jpg`;
}

/**
 * Cover, in order of preference:
 *   1. --cover (a file you already have, or any URL you may rehost)
 *   2. assets/books/<id>.jpg you dropped in by hand
 *   3. Open Library — public domain-ish metadata, downloaded same-origin
 *   4. Amazon's own hi-res URL, left REMOTE on purpose: hotlinking m.media-amazon.com
 *      is what SiteStripe itself emits, while rehosting their file is not ours to do
 *   5. null → the page draws the typographic fallback
 * `default=false` makes the Open Library covers API 404 instead of serving a blank.
 */
async function resolveCover({ coverArg, id, asin, amazonImage }) {
  if (coverArg) {
    if (/^https?:/i.test(coverArg)) {
      const local = await saveCover(coverArg, id);
      if (local) return { cover: local, how: `baixada de ${coverArg}` };
      return { cover: null, how: 'URL de capa não respondeu' };
    }
    return { cover: coverArg, how: 'caminho informado' };
  }

  try {
    await access(join(COVER_DIR, `${id}.jpg`));
    return { cover: `./assets/books/${id}.jpg`, how: 'arquivo local já existente' };
  } catch (e) {}

  if (isIsbn10(asin)) {
    const local = await saveCover(`https://covers.openlibrary.org/b/isbn/${asin}-L.jpg?default=false`, id);
    if (local) return { cover: local, how: 'Open Library (salva no repo)' };
  }
  if (amazonImage) return { cover: amazonImage, how: 'Amazon (remota, igual ao SiteStripe)' };
  return { cover: null, how: 'nenhuma — a página usa o fallback tipográfico' };
}

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i] ?? true;
    else out._.push(a);
  }
  return out;
}

// ── add ───────────────────────────────────────────────────────────────
async function cmdAdd(argv) {
  const args = flags(argv);
  const asin = parseAsin(args._[0]);
  if (!asin) {
    console.error(c.red('Passe a URL da Amazon ou o ASIN. Ex.: node scripts/books.mjs add https://www.amazon.com.br/dp/8550827673'));
    process.exit(1);
  }

  // Validate every argument BEFORE any network call: a later bail-out would already
  // have written a cover into assets/books/ for a book that never gets added.
  const ml = args.ml ? String(args.ml).trim() : '';
  if (ml && !isMlLink(ml)) {
    console.error(c.red('O --ml não parece um link do Mercado Livre (meli.la, mercadolivre.com/sec, /social).'));
    process.exit(1);
  }

  const db = await loadDb();
  if (db.books.some((b) => b.links?.amazon?.asin === asin)) {
    console.error(c.red(`ASIN ${asin} já está em data/books.json.`));
    process.exit(1);
  }

  // A pasted SiteStripe URL already carries the tag, so configuring the site is free.
  const urlTag = parseAmazonTag(args._[0]);
  if (urlTag && !db.affiliate.amazonTag) {
    db.affiliate.amazonTag = urlTag;
    console.log(c.green(`→ tag de afiliado adotada do link: ${urlTag}`));
  } else if (urlTag && db.affiliate.amazonTag !== urlTag) {
    console.log(c.yellow(`! o link traz tag=${urlTag}, mas a configurada é ${db.affiliate.amazonTag} (mantida)`));
  }

  console.log(c.dim(`→ conferindo ${asin} na Amazon…`));
  const meta = await amazonMeta(asin);
  if (!meta) console.log(c.yellow('  ! não consegui ler o título na Amazon (segue com o que você passou)'));
  else console.log(`  ${c.dim('Amazon diz:')} ${c.bold(meta.raw)}`);

  let ol = null;
  if (isIsbn10(asin)) {
    console.log(c.dim('→ buscando metadados na Open Library…'));
    ol = await openLibrary(asin);
    if (ol) console.log(`  ${c.dim('Open Library:')} ${ol.title} — ${ol.author || '?'}${ol.year ? ` (${ol.year})` : ''}`);
    else console.log(c.yellow('  ! sem registro na Open Library para esse ISBN'));
  } else {
    console.log(c.dim('→ ASIN não é ISBN-10 (provável Kindle): Open Library não se aplica'));
  }

  const title = args.title || meta?.title || ol?.title || '';
  const subtitle = args.subtitle || meta?.subtitle || '';
  const author = args.author || meta?.author || ol?.author || '';
  if (!title) {
    console.error(c.red('Não achei o título. Passe --title "Nome do livro".'));
    process.exit(1);
  }

  const id = slug(args.id || title);
  const { cover, how } = await resolveCover({
    coverArg: args.cover,
    id,
    asin,
    amazonImage: meta?.image,
  });
  console.log(c.dim(`  capa: ${how}`));

  db.books.push({
    id,
    title,
    subtitle,
    author,
    year: ol?.year ?? null,
    cover,
    tags: args.tags ? String(args.tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
    blurb: { pt: args['blurb-pt'] || '', en: args['blurb-en'] || '' },
    links: {
      amazon: { asin },
      // productId is the affiliate panel's own identifier — not URL-addressable,
      // kept only so you can find the product again in the panel.
      ml: ml ? { url: ml, productId: args['ml-id'] ? String(args['ml-id']).trim() : null } : null,
    },
  });
  await saveDb(db);

  console.log(c.green(`\n✓ "${title}" adicionado (id: ${id}).`));
  if (!ml) {
    console.log(
      c.yellow('→ falta o link do Mercado Livre.') +
        ' Gere em https://afiliados.mercadolivre.com.br (Ferramentas → Gerador de link)\n' +
        c.dim(`  e cole em data/books.json → ${id} → links.ml.url`),
    );
  }
  if (!db.affiliate.amazonTag) {
    console.log(c.yellow('→ a tag da Amazon ainda está vazia:') + ' node scripts/books.mjs tag SEU-ID-20');
  }
  console.log(c.dim('→ escreva a sinopse em blurb.pt / blurb.en.'));
}

// ── check ─────────────────────────────────────────────────────────────
/** Loose match: Amazon's title carries subtitle + author noise, so compare word overlap. */
function titlesAgree(stored, amazon) {
  const words = (s) =>
    new Set(
      String(s)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3),
    );
  const a = words(stored);
  if (!a.size) return true;
  const b = words(amazon);
  let hit = 0;
  for (const w of a) if (b.has(w)) hit++;
  return hit / a.size >= 0.5;
}

async function cmdCheck() {
  const db = await loadDb();
  let problems = 0;
  const warn = (msg) => {
    problems++;
    console.log(`  ${c.red('✗')} ${msg}`);
  };

  if (!db.affiliate?.amazonTag) {
    problems++;
    console.log(c.red('✗ affiliate.amazonTag está vazio — nenhum link da Amazon credita comissão.'));
  } else {
    console.log(c.dim(`tag Amazon: ${db.affiliate.amazonTag}`));
  }
  console.log(c.dim(`${db.books.length} livro(s)\n`));

  for (const b of db.books) {
    console.log(c.bold(b.title || b.id));
    const asin = b.links?.amazon?.asin;
    if (!asin) warn('sem ASIN da Amazon');
    else {
      const meta = await amazonMeta(asin);
      if (!meta) warn(`ASIN ${asin}: não consegui ler a página`);
      else if (!titlesAgree(b.title, meta.raw)) warn(`ASIN ${asin} abre outro produto → "${meta.raw}"`);
      else console.log(`  ${c.green('✓')} Amazon ${c.dim(asin)}`);
    }

    const mlUrl = b.links?.ml?.url;
    if (!mlUrl) warn('sem link do Mercado Livre (o botão não aparece na página)');
    else if (!isMlLink(mlUrl)) warn(`link do ML com host inesperado: ${mlUrl}`);
    else {
      // Short links are opaque, so the only thing provable is that one still resolves
      // into mercadolivre with the affiliate params attached.
      const res = await fetch(mlUrl, { headers: { 'user-agent': UA }, redirect: 'follow' }).catch(() => null);
      const dest = res && res.url ? res.url : '';
      if (!dest) warn(`link do ML não respondeu: ${mlUrl}`);
      else if (!/matt_word=|matt_tool=|tracking_id=/i.test(dest)) {
        warn(`link do ML resolve sem parâmetro de afiliado → ${dest.slice(0, 90)}`);
      } else console.log(`  ${c.green('✓')} Mercado Livre ${c.dim(`(${(dest.match(/matt_word=([^&]+)/i) || [])[1] || 'rastreado'})`)}`);
    }

    if (!b.cover) console.log(`  ${c.yellow('–')} sem capa (fallback tipográfico)`);
    else if (/^https?:/i.test(b.cover)) {
      const ok = await get(b.cover, 'buffer');
      if (ok && ok.length > 2000) console.log(`  ${c.green('✓')} capa ${c.dim('(remota)')}`);
      else warn(`capa remota não responde: ${b.cover}`);
    } else {
      try {
        await access(join(ROOT, b.cover.replace(/^\.\//, '')));
        console.log(`  ${c.green('✓')} capa`);
      } catch (e) {
        warn(`capa não existe: ${b.cover}`);
      }
    }

    if (!b.blurb?.pt) console.log(`  ${c.yellow('–')} sem sinopse em PT`);
    console.log('');
  }

  if (problems) {
    console.log(c.red(`${problems} problema(s).`));
    process.exit(1);
  }
  console.log(c.green('Tudo certo.'));
}

// ── tag ───────────────────────────────────────────────────────────────
async function cmdTag(argv) {
  const tag = (argv[0] || '').trim();
  if (!tag) {
    console.error(c.red('Uso: node scripts/books.mjs tag SEU-ID-20'));
    process.exit(1);
  }
  const db = await loadDb();
  db.affiliate.amazonTag = tag;
  await saveDb(db);
  console.log(c.green(`✓ tag da Amazon = ${tag}`));
}

// ── main ──────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const commands = { add: cmdAdd, check: () => cmdCheck(), tag: cmdTag };
if (!commands[cmd]) {
  console.log(`Biblioteca — data/books.json

  node scripts/books.mjs add <url-amazon|ASIN> [opções]
      --ml <link>        link de afiliado do ML (meli.la / mercadolivre.com/sec / /social)
      --ml-id <id>       ID do produto no painel do ML (só referência)
      --title / --subtitle / --author / --cover / --tags a,b
      --blurb-pt / --blurb-en
  node scripts/books.mjs check     confere ASIN, link do ML, capa e sinopse
  node scripts/books.mjs tag <sua-tag-20>
`);
  process.exit(cmd ? 1 : 0);
}
await commands[cmd](rest);
