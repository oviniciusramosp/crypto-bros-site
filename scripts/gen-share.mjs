// Pre-generates static /p/<id>/index.html share pages carrying per-post OG/Twitter meta,
// a same-origin copy of the cover (og:image), JSON-LD, and sitemap.xml.
//
// Why this exists: social crawlers (WhatsApp, Facebook, iMessage, Slack) do NOT run JS,
// and GitHub Pages returns the same index.html for every ?post=<id>. Per-post previews
// need real HTML per post. Humans hitting these URLs are JS-redirected into the app.
//
// Do NOT add <meta http-equiv="refresh">. Facebook/WhatsApp treat delay=0 as a redirect
// and scrape the homepage instead, which is why shares were showing the generic site card.
import { mkdir, writeFile, rm } from 'node:fs/promises';

const WORKER = 'https://crypto-bros-notion-proxy.crypto-bros.workers.dev';
const SITE = 'https://crypto-bros.com';
const KEY = process.env.SHARE_KEY;
const CONCURRENCY = 8;
const FALLBACK_DESC = 'Feed do Crypto Bros — mercado, estudos e trade cripto.';
const FALLBACK_IMAGE = `${SITE}/og.png`;
const MAX_COVER_BYTES = 7 * 1024 * 1024; // Facebook's hard cap is 8 MB.

if (!KEY) {
  console.error('SHARE_KEY is not set');
  process.exit(1);
}

const esc = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.replace(KEY, '***')} → ${res.status}`);
  return res.json();
}

const { posts } = await json(`${WORKER}/web/share-index?key=${KEY}`);
console.log(`share-index: ${posts.length} posts`);

// Wipe previous output so unpublished posts (and stale covers) do not linger in the
// Pages artifact. p/ is gitignored; this only affects the deploy workspace.
await rm('p', { recursive: true, force: true });

// Descriptions are one-per-request on purpose (the Worker would blow Cloudflare's
// 50-subrequest cap deriving them all at once), so fan them out from here.
const extras = new Array(posts.length);
for (let i = 0; i < posts.length; i += CONCURRENCY) {
  const chunk = posts.slice(i, i + CONCURRENCY);
  const got = await Promise.all(chunk.map((p) => loadExtras(p)));
  got.forEach((e, j) => { extras[i + j] = e; });
}

// Map id → lang so hreflang can name the alternate correctly.
const langById = new Map(posts.map((p) => [p.id, p.lang]));

let written = 0;
let covers = 0;
for (const [i, p] of posts.entries()) {
  const extra = extras[i];
  const desc = extra.description || FALLBACK_DESC;
  const target = `/?post=${p.id}`;
  const isEn = p.lang === 'EN';
  const locale = isEn ? 'en_US' : 'pt_BR';
  const altId = p.altId && langById.has(p.altId) ? p.altId : null;
  const altLang = altId ? langById.get(altId) : null;
  const altHreflang = altLang === 'EN' ? 'en' : altLang === 'PT-BR' ? 'pt-BR' : null;
  const altLocale = altLang === 'EN' ? 'en_US' : altLang === 'PT-BR' ? 'pt_BR' : null;
  const selfHreflang = isEn ? 'en' : 'pt-BR';
  const pageUrl = `${SITE}/p/${p.id}/`;
  const published = p.publishedAt || '';

  let image = FALLBACK_IMAGE;
  let imageType = 'image/png';
  let imageWidth = 1200;
  let imageHeight = 630;
  let imageFile = null;
  if (extra.cover) {
    imageFile = `cover.${extra.cover.ext}`;
    image = `${SITE}/p/${p.id}/${imageFile}`;
    imageType = extra.cover.mime;
    imageWidth = extra.cover.width || 0;
    imageHeight = extra.cover.height || 0;
    covers++;
  }

  const xDefaultId = isEn && altId && altLang === 'PT-BR' ? altId : p.id;
  const alternateLinks = altId && altHreflang && altLocale
    ? `<link rel="alternate" hreflang="${selfHreflang}" href="${pageUrl}">
<link rel="alternate" hreflang="${altHreflang}" href="${SITE}/p/${altId}/">
<link rel="alternate" hreflang="x-default" href="${SITE}/p/${xDefaultId}/">
<meta property="og:locale:alternate" content="${altLocale}">`
    : `<link rel="alternate" hreflang="${selfHreflang}" href="${pageUrl}">
<link rel="alternate" hreflang="x-default" href="${pageUrl}">`;

  const publishedMeta = published
    ? `<meta property="article:published_time" content="${esc(published)}">`
    : '';

  const imageSizeMeta = imageWidth && imageHeight
    ? `<meta property="og:image:width" content="${imageWidth}">
<meta property="og:image:height" content="${imageHeight}">`
    : '';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: p.title,
    description: desc,
    image: [image],
    mainEntityOfPage: pageUrl,
    url: pageUrl,
    inLanguage: isEn ? 'en' : 'pt-BR',
    author: { '@type': 'Organization', name: 'Crypto Bros', url: SITE },
    publisher: {
      '@type': 'Organization',
      name: 'Crypto Bros',
      url: SITE,
      logo: { '@type': 'ImageObject', url: `${SITE}/icon.png` },
    },
    isAccessibleForFree: true,
  };
  if (published) jsonLd.datePublished = published;

  const cta = isEn ? 'Read on Crypto Bros' : 'Ler no Crypto Bros';
  const coverDims = extra.cover?.width && extra.cover?.height
    ? ` width="${extra.cover.width}" height="${extra.cover.height}"`
    : '';
  const coverImg = extra.cover
    ? `<img src="${imageFile}" alt="${esc(p.title)}"${coverDims}>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="${isEn ? 'en' : 'pt-BR'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(p.title)} — Crypto Bros</title>
<meta name="description" content="${esc(desc)}">
<meta name="robots" content="max-image-preview:large">
<link rel="canonical" href="${pageUrl}">
${alternateLinks}
<meta property="og:type" content="article">
<meta property="og:site_name" content="Crypto Bros">
<meta property="og:locale" content="${locale}">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:image" content="${image}">
<meta property="og:image:secure_url" content="${image}">
<meta property="og:image:type" content="${imageType}">
<meta property="og:image:alt" content="${esc(p.title)}">
${imageSizeMeta}
${publishedMeta}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(p.title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${image}">
<meta name="twitter:image:alt" content="${esc(p.title)}">
<link rel="image_src" href="${image}">
<link rel="icon" type="image/png" href="${SITE}/favicon.png">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #000; color: #f5f5f5; }
  article { max-width: 720px; margin: 0 auto; padding: 24px 20px 64px; }
  img { width: 100%; height: auto; border-radius: 12px; display: block; margin-bottom: 20px; }
  h1 { font-size: 1.75rem; line-height: 1.2; margin: 0 0 12px; }
  p { color: #b5b5b5; line-height: 1.5; margin: 0 0 24px; }
  a.cta { display: inline-block; padding: 12px 18px; background: #fff; color: #000; border-radius: 999px; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<article>
${coverImg}
<h1>${esc(p.title)}</h1>
<p>${esc(desc)}</p>
<p><a class="cta" href="${target}">${cta}</a></p>
</article>
<script>
(function () {
  var ua = navigator.userAgent || '';
  if (/googlebot|bingbot|yandex|baiduspider|duckduckbot|applebot/i.test(ua)) return;
  location.replace(${JSON.stringify(target)});
})();
</script>
</body>
</html>
`;

  await mkdir(`p/${p.id}`, { recursive: true });
  await writeFile(`p/${p.id}/index.html`, html);
  if (extra.cover) await writeFile(`p/${p.id}/${imageFile}`, extra.cover.bytes);
  written++;
}

await writeFile('sitemap.xml', buildSitemap(posts));
console.log(`generated ${written} share pages (${covers} with cover) under p/`);

async function loadExtras(p) {
  const [description, cover] = await Promise.all([
    fetchDesc(p.id),
    p.hasCover ? fetchCover(p.id) : Promise.resolve(null),
  ]);
  return { description, cover };
}

async function fetchDesc(id) {
  try {
    return (await json(`${WORKER}/web/share-desc?key=${KEY}&id=${id}`)).description || '';
  } catch {
    return '';
  }
}

async function fetchCover(id) {
  try {
    const res = await fetch(`${WORKER}/web/cover?id=${id}`);
    if (!res.ok) return null;
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_COVER_BYTES) return null;
    const { ext, width, height } = sniffImage(bytes, mime);
    return { bytes, ext, mime: mimeForExt(ext, mime), width, height };
  } catch {
    return null;
  }
}

function mimeForExt(ext, fallback) {
  return ({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' })[ext] || fallback;
}

function sniffImage(buf, mime) {
  let ext = 'jpg';
  if (mime === 'image/png' || (buf[0] === 0x89 && buf[1] === 0x50)) ext = 'png';
  else if (mime === 'image/webp' || (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57)) ext = 'webp';
  else if (mime === 'image/gif' || (buf[0] === 0x47 && buf[1] === 0x49)) ext = 'gif';
  else if (mime === 'image/jpeg' || (buf[0] === 0xff && buf[1] === 0xd8)) ext = 'jpg';

  let width = 0;
  let height = 0;
  try {
    if (ext === 'png' && buf.length >= 24) {
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    } else if (ext === 'gif' && buf.length >= 10) {
      width = buf.readUInt16LE(6);
      height = buf.readUInt16LE(8);
    } else if (ext === 'jpg') {
      const d = jpegSize(buf);
      width = d.width;
      height = d.height;
    } else if (ext === 'webp') {
      const d = webpSize(buf);
      width = d.width;
      height = d.height;
    }
  } catch { /* keep 0 — OG still works without width/height */ }
  return { ext, width, height };
}

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { width: 0, height: 0 };
}

function webpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    return { width: 0, height: 0 };
  }
  const kind = buf.toString('ascii', 12, 16);
  if (kind === 'VP8X' && buf.length >= 30) {
    return {
      width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1,
      height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1,
    };
  }
  if (kind === 'VP8 ' && buf.length >= 30) {
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  return { width: 0, height: 0 };
}

function buildSitemap(list) {
  const urls = [
    sitemapUrl(`${SITE}/`, 'daily', '1.0'),
    ...list.map((p) => sitemapUrl(`${SITE}/p/${p.id}/`, 'weekly', '0.8', p.publishedAt)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>
`;
}

function sitemapUrl(loc, changefreq, priority, lastmod) {
  const lm = lastmod ? `\n    <lastmod>${esc(String(lastmod).slice(0, 10))}</lastmod>` : '';
  return `  <url>
    <loc>${loc}</loc>${lm}
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
}
