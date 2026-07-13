// Crypto Bros — service worker for Web Push (payload-less: fetch latest on push).
'use strict';

const WORKER_BASE = 'https://crypto-bros-notion-proxy.crypto-bros.workers.dev';
const CACHE = 'cb-cache-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // Drop stale asset caches from older SW versions.
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k.startsWith('cb-cache') && k !== CACHE).map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

// Caching: same-origin assets = stale-while-revalidate; navigations = network-first
// (so a fresh index.html always pulls the latest versioned ?v= assets). The Worker
// API (cross-origin, gated) is never cached.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Worker API + Google fonts/GIS → network

  if (req.mode === 'navigate') {
    // `cache: 'no-cache'` is what makes this network-FIRST for real. A plain fetch() reads
    // the browser's HTTP cache, and GitHub Pages serves index.html with max-age=600 — so
    // for ten minutes after a deploy this handler happily replayed the OLD index.html,
    // which then pulled the OLD ?v= assets. It forces a revalidation (304 when unchanged,
    // so it stays cheap) instead of trusting the stale copy.
    e.respondWith(
      fetch(req.url, { cache: 'no-cache' })
        .catch(() => caches.match(req).then((r) => r || caches.match('/'))),
    );
    return;
  }
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || fetch(req);
  })());
});

// Push has no payload (avoids encryption); fetch the newest post to build the notification.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let lang = 'PT-BR';
    try {
      const r = await caches.match('cb-lang');
      if (r) lang = (await r.text()) === 'en' ? 'EN' : 'PT-BR';
    } catch (e) {}

    let title = 'Crypto Bros', url = '/';
    try {
      const res = await fetch(`${WORKER_BASE}/web/latest?lang=${lang}`);
      if (res.ok) {
        const p = await res.json();
        if (p && p.title) { title = p.title; if (p.id) url = `/?post=${encodeURIComponent(p.id)}`; }
      }
    } catch (e) {}

    await self.registration.showNotification(title, {
      body: lang === 'EN' ? 'New post on the Feed' : 'Novo post no Feed',
      icon: '/icon.png',
      badge: '/favicon.png',
      data: { url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
