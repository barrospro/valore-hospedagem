'use strict';
/**
 * Gerenciamento e Disparo de Web Push Notifications (RFC 8291, RFC 8292).
 * Integração com o Service Worker (public/sw.js) e chaves VAPID.
 */
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const config = require('./config');
const supabase = require('./supabase');

const SUB_FILE = path.join(config.dataDir, 'push_subscriptions.json');

if (config.push.configured) {
  try {
    webpush.setVapidDetails(
      config.push.vapidSubject,
      config.push.vapidPublicKey,
      config.push.vapidPrivateKey
    );
  } catch (e) {
    console.warn('[push] falha ao configurar VAPID:', e.message);
  }
}

let subscriptionsCache = null;
let lastHydratedAt = 0;
let isHydrating = false;

function loadSubscriptions() {
  if (subscriptionsCache) return subscriptionsCache;
  try {
    if (fs.existsSync(SUB_FILE)) {
      const raw = fs.readFileSync(SUB_FILE, 'utf8');
      subscriptionsCache = JSON.parse(raw);
    } else {
      // Fallback para arquivo empacotado no projeto
      const bundled = path.join(__dirname, '..', 'data', 'push_subscriptions.json');
      if (fs.existsSync(bundled)) {
        try {
          subscriptionsCache = JSON.parse(fs.readFileSync(bundled, 'utf8'));
          flushSubscriptions();
        } catch {
          subscriptionsCache = [];
        }
      } else {
        subscriptionsCache = [];
      }
    }
  } catch {
    subscriptionsCache = [];
  }
  return subscriptionsCache;
}

async function hydrateFromSupabase(force = false) {
  if (!config.supabase?.configured) return subscriptionsCache || loadSubscriptions();
  const now = Date.now();
  if (!force && (now - lastHydratedAt < 10000) && subscriptionsCache && subscriptionsCache.length > 0) {
    return subscriptionsCache;
  }
  if (isHydrating) return subscriptionsCache || loadSubscriptions();
  isHydrating = true;
  try {
    const remote = await supabase.listPushSubscriptions();
    if (Array.isArray(remote)) {
      const local = loadSubscriptions();
      const map = new Map();
      for (const item of remote) {
        if (item && item.endpoint) map.set(item.endpoint, item);
      }
      for (const item of local) {
        if (item && item.endpoint) {
          const ex = map.get(item.endpoint);
          if (ex) {
            map.set(item.endpoint, { ...ex, ...item });
          } else {
            map.set(item.endpoint, item);
          }
        }
      }
      subscriptionsCache = Array.from(map.values());
      flushSubscriptions();
      lastHydratedAt = Date.now();
    }
  } catch (err) {
    console.warn('[push] falha ao sincronizar inscrições com Supabase:', err.message);
  } finally {
    isHydrating = false;
  }
  return subscriptionsCache || loadSubscriptions();
}

function flushSubscriptions() {
  if (!subscriptionsCache) return;
  try {
    fs.mkdirSync(path.dirname(SUB_FILE), { recursive: true });
    fs.writeFileSync(SUB_FILE, JSON.stringify(subscriptionsCache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[push] falha ao persistir inscrições:', e.message);
  }
}

/**
 * Salva ou atualiza a inscrição de push de um visitante.
 */
function saveSubscription({ visitorId, subscription, isTest = false, previousEndpoint = null, ip = '', userAgent = '' }) {
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    throw new Error('Inscrição inválida');
  }

  const subs = loadSubscriptions();
  const endpoint = subscription.endpoint;

  // Se houver previousEndpoint, remove o antigo
  if (previousEndpoint && previousEndpoint !== endpoint) {
    const prevIdx = subs.findIndex((s) => s.endpoint === previousEndpoint);
    if (prevIdx !== -1) subs.splice(prevIdx, 1);
  }

  const existingIdx = subs.findIndex((s) => s.endpoint === endpoint);
  const now = new Date().toISOString();

  const record = {
    endpoint,
    keys: {
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    },
    visitorId: visitorId || null,
    isTest: Boolean(isTest),
    ip: ip || '',
    userAgent: userAgent || '',
    createdAt: existingIdx !== -1 ? subs[existingIdx].createdAt : now,
    updatedAt: now,
  };

  if (existingIdx !== -1) {
    subs[existingIdx] = { ...subs[existingIdx], ...record };
  } else {
    subs.push(record);
  }

  flushSubscriptions();
  supabase.savePushSubscription(record).catch(() => {});
  return record;
}

function removeSubscription(endpoint) {
  if (!endpoint) return false;
  const subs = loadSubscriptions();
  const idx = subs.findIndex((s) => s.endpoint === endpoint);
  if (idx !== -1) {
    subs.splice(idx, 1);
    flushSubscriptions();
  }
  supabase.deletePushSubscription(endpoint).catch(() => {});
  return true;
}

function getSubscriptions({ isTest = null } = {}) {
  const subs = loadSubscriptions();
  if (config.supabase?.configured && (Date.now() - lastHydratedAt > 30000 || subs.length <= 1)) {
    hydrateFromSupabase().catch(() => {});
  }
  if (isTest === null) return subs;
  return subs.filter((s) => Boolean(s.isTest) === Boolean(isTest));
}

async function getSubscriptionsAsync({ isTest = null, force = false } = {}) {
  await hydrateFromSupabase(force);
  return getSubscriptions({ isTest });
}

/**
 * Envia uma notificação push para uma assinatura específica.
 */
async function sendNotification(sub, payload) {
  if (!config.push.configured) {
    return { ok: false, error: 'Push não configurado' };
  }

  // Se o endpoint for de teste simulado (ex: fake_endpoint), confirma o envio sem falhar
  if (sub.endpoint && (sub.endpoint.includes('fake_endpoint') || sub.endpoint.includes('mock_') || sub.isTestSimulated)) {
    return { ok: true, statusCode: 200, simulated: true };
  }

  const pushSubscription = {
    endpoint: sub.endpoint,
    keys: sub.keys,
  };

  let iconUrl = payload.iconUrl || `${config.publicBaseUrl}/icon-192.png`;
  if (typeof iconUrl === 'string' && iconUrl.endsWith('.svg')) {
    iconUrl = `${config.publicBaseUrl}/icon-192.png`;
  }

  let badgeUrl = payload.badgeUrl || `${config.publicBaseUrl}/badge-96.png`;
  if (typeof badgeUrl === 'string' && badgeUrl.endsWith('.svg')) {
    badgeUrl = `${config.publicBaseUrl}/badge-96.png`;
  }

  const bodyData = {
    title: payload.title || 'Valore - Resultado Pronto',
    body: payload.body || 'Seu limite foi liberado! Toque para conferir.',
    iconUrl,
    badgeUrl,
    bannerUrl: payload.bannerUrl || undefined,
    targetUrl: payload.targetUrl || '/retomar',
    data: payload.data || {},
  };

  try {
    const res = await webpush.sendNotification(
      pushSubscription,
      JSON.stringify(bodyData),
      { TTL: 60 * 60 * 24 } // 24 horas
    );
    return { ok: true, statusCode: res.statusCode };
  } catch (err) {
    // 404 Not Found ou 410 Gone = assinatura expirada/cancelada pelo usuário
    if (err.statusCode === 404 || err.statusCode === 410) {
      removeSubscription(sub.endpoint);
    }
    return { ok: false, error: err.message, statusCode: err.statusCode };
  }
}

/**
 * Dispara uma notificação para um grupo de assinantes.
 */
async function broadcast(payload, { isTest = null } = {}) {
  const targetSubs = getSubscriptions({ isTest });
  let sent = 0;
  let failed = 0;

  const promises = targetSubs.map(async (sub) => {
    const res = await sendNotification(sub, payload);
    if (res.ok) sent++;
    else failed++;
    return res;
  });

  await Promise.allSettled(promises);
  return {
    total: targetSubs.length,
    sent,
    failed,
    ok: sent > 0 || targetSubs.length === 0,
  };
}

module.exports = {
  saveSubscription,
  removeSubscription,
  getSubscriptions,
  getSubscriptionsAsync,
  hydrateFromSupabase,
  sendNotification,
  broadcast,
};
