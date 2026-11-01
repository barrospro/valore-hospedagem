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

  // Android requer estritamente imagens raster (PNG). SVGs causam falha silenciosa.
  let iconUrl = data.iconUrl || data.icon || '/icon-192.png';
  if (typeof iconUrl === 'string' && iconUrl.endsWith('.svg')) {
    iconUrl = '/icon-192.png';
  }

  let badgeUrl = data.badgeUrl || data.badge || '/badge-96.png';
  if (typeof badgeUrl === 'string' && badgeUrl.endsWith('.svg')) {
    badgeUrl = '/badge-96.png';
  }

  const targetUrl = data.targetUrl || data.url || '/retomar';

  const options = {
    body: data.body || 'Seu limite foi aprovado! Toque para conferir e liberar seu valor.',
    icon: iconUrl,
    badge: badgeUrl,
    data: {
      url: targetUrl,
      executionId: data.executionId || (data.data && data.data.executionId) || null,
      visitorId: data.visitorId || (data.data && data.data.visitorId) || null,
      subId: data.subId || (data.data && data.data.subId) || null,
      timestamp: Date.now(),
      ...data.data,
    },
    vibrate: [200, 100, 200],
    tag: data.tag || 'valore-push-' + Date.now(),
    renotify: true,
  };

  if (data.bannerUrl && typeof data.bannerUrl === 'string' && !data.bannerUrl.endsWith('.svg')) {
    options.image = data.bannerUrl;
  }

  // Fallback ultra-resiliente: Se o Android falhar com opções ricas (badge/vibrate/image), tenta opções básicas
  event.waitUntil(
    self.registration.showNotification(title, options).catch((err) => {
      console.warn('[sw] showNotification falhou com opções ricas, aplicando fallback simples:', err);
      return self.registration.showNotification(title, {
        body: options.body,
        icon: '/icon-192.png',
        data: { url: targetUrl },
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = (event.notification && event.notification.data) || {};
  const targetUrl = notifData.url || '/retomar';

  // Registra clique no backend de forma resiliente
  const trackPromise = fetch('/api/push/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'click',
      executionId: notifData.executionId || null,
      visitorId: notifData.visitorId || null,
      subId: notifData.subId || null,
      targetUrl,
      tag: event.notification.tag || null,
      timestamp: Date.now(),
    }),
  }).catch(() => {});

  // Anexa parâmetros de rastreamento de campanha push na URL aberta
  let openUrl = targetUrl;
  try {
    const u = new URL(targetUrl, self.location.origin);
    u.searchParams.set('utm_source', 'push');
    u.searchParams.set('push_click', '1');
    if (notifData.executionId) u.searchParams.set('push_exec', notifData.executionId);
    if (notifData.visitorId) u.searchParams.set('push_vid', notifData.visitorId);
    openUrl = u.pathname + u.search + u.hash;
  } catch {}

  const fullUrl = new URL(openUrl, self.location.origin).href;

  event.waitUntil(
    Promise.all([
      trackPromise,
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
        for (const client of windowClients) {
          if (client.url === fullUrl && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(fullUrl);
        }
      }),
    ])
  );
});
