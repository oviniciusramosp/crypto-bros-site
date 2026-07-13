// Pre-generates static /p/<id>/index.html share pages carrying per-post OG/Twitter meta.
//
// Why this exists: social crawlers (WhatsApp, Twitter, iMessage, Slack) do NOT run JS, and
// GitHub Pages returns the same index.html for every ?post=<id>. So per-post link previews
// need real HTML per post. These pages carry the meta and redirect humans into the app.
import { mkdir, writeFile } from 'node:fs/promises';

const WORKER = 'https://crypto-bros-notion-proxy.crypto-bros.workers.dev';
const SITE = 'https://crypto-bros.com';
const KEY = process.env.SHARE_KEY;
const CONCURRENCY = 8;
const FALLBACK_DESC = 'Feed do Crypto Bros — mercado, estudos e trade cripto.';

if (!KEY) {
  console.error('SHARE_KEY is not set');
  process.exit(1);
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url.replace(KEY, '***')} → ${res.status}`);
  return res.json();
}

const { posts } = await json(`${WORKER}/web/share-index?key=${KEY}`);
console.log(`share-index: ${posts.length} posts`);

// Descriptions are one-per-request on purpose (the Worker would blow Cloudflare's
// 50-subrequest cap deriving them all at once), so fan them out from here.
const descs = new Array(posts.length).fill('');
for (let i = 0; i < posts.length; i += CONCURRENCY) {
  const chunk = posts.slice(i, i + CONCURRENCY);
  const got = await Promise.all(
    chunk.map(async (p) => {
      try {
        return (await json(`${WORKER}/web/share-desc?key=${KEY}&id=${p.id}`)).description;
      } catch {
        return '';
      }
    }),
  );
  got.forEach((d, j) => { descs[i + j] = d; });
}

let written = 0;
for (const [i, p] of posts.entries()) {
  const desc = descs[i] || FALLBACK_DESC;
  // Notion `file` cover URLs are signed and expire (~1h), so point at the Worker's stable
  // cover route instead of baking the signed URL into a static page.
  const image = p.hasCover ? `${WORKER}/web/cover?id=${p.id}` : `${SITE}/og.png`;
  const target = `/?post=${p.id}`;
  const isEn = p.lang === 'EN';

  const html = `<!DOCTYPE html>
<html lang="${isEn ? 'en' : 'pt-BR'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(p.title)} — Crypto Bros</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}/p/${p.id}/">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Crypto Bros">
<meta property="og:locale" content="${isEn ? 'en_US' : 'pt_BR'}">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}/p/${p.id}/">
<meta property="og:image" content="${image}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(p.title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${image}">
<meta http-equiv="refresh" content="0;url=${target}">
<script>location.replace(${JSON.stringify(target)});</script>
</head>
<body></body>
</html>
`;
  await mkdir(`p/${p.id}`, { recursive: true });
  await writeFile(`p/${p.id}/index.html`, html);
  written++;
}

console.log(`generated ${written} share pages under p/`);
