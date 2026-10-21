/* Service Worker para Web Push Notifications - Valore */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {
      title: 'Valore',
      body: event.data ? event.data.text() : 'Seu resultado está pronto!',
    };
  }

  const title = data.title || 'Valore - Análise Concluída';
  const options = {
    body: data.body || 'Seu limite foi aprovado! Toque para conferir e liberar seu valor.',
    icon: data.iconUrl || data.icon || '/favicon.svg',
    badge: data.badgeUrl || data.badge || '/favicon.svg',
    image: data.bannerUrl || data.image || undefined,
    data: {
      url: data.targetUrl || data.url || '/retomar',
      timestamp: Date.now(),
      ...data.data,
    },
    vibrate: [200, 100, 200],
    tag: data.tag || 'valore-push-' + Date.now(),
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  const fullUrl = new URL(targetUrl, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url === fullUrl && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(fullUrl);
      }
    })
  );
});
