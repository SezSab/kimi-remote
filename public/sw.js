// Service worker: PWA installability + Web Push.
// Never intercept /term (live terminal) or /api (session state).
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/term') || e.request.url.includes('/api')) return;
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(d.title || 'Kimi Remote', {
    body: d.body || '',
    tag: d.tag || 'nux',
    data: { url: d.url || '/' },
    icon: '/icon-180.png',
    badge: '/icon-180.png',
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) { await w.focus(); if ('navigate' in w) await w.navigate(url).catch(() => {}); return; }
    }
    await clients.openWindow(url);
  })());
});
