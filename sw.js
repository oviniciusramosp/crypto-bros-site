// Crypto Bros — service worker for Web Push (payload-less: fetch latest on push).
'use strict';

const WORKER_BASE = 'https://crypto-bros-notion-proxy.crypto-bros.workers.dev';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
