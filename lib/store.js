'use strict';
/**
 * Persistência em JSON (data/store.json) — visitantes, leads e ordens.
 * O objeto de visitante segue EXATAMENTE o formato devolvido pela API original:
 *
 *   { id, createdAt, lastSeenAt, stage, stageIndex, purchased, pushSubscribed, status,
 *     ip, browser, os, device, utmSource, utmMedium, utmCampaign, utmTerm, utmContent,
 *     brand, cpf, name, birthDate, gender, motherName, phone, email, password,
 *     amount, installments, purpose, salary, bank, pixKey, pixKeyType }
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const supabase = require('./supabase');

const FILE = path.join(config.dataDir, 'store.json');
const LOCK_FILE = path.join(config.dataDir, 'store.lock');
const UUID = () => globalThis.crypto.randomUUID();

const VISITOR_DEFAULTS = {
  stage: 'inicio',
  stageIndex: 0,
  purchased: false,
  pushSubscribed: false,
  ip: '',
  browser: '',
  os: '',
  device: '',
  utmSource: '',
  utmMedium: '',
  utmCampaign: '',
  utmTerm: '',
  utmContent: '',
  src: '',
  sck: '',
  brand: '',
  cpf: '',
  name: '',
  birthDate: '',
  gender: '',
  motherName: '',
  phone: '',
  email: '',
  password: '',
  amount: 0,
  installments: 0,
  purpose: '',
  salary: '',
  bank: '',
  pixKey: '',
  pixKeyType: '',
};

const VISITOR_FIELDS = Object.keys(VISITOR_DEFAULTS);

let db = null;
let flushTimer = null;

function withFileLock(fn, { timeoutMs = 3000, pollIntervalMs = 25 } = {}) {
  const start = Date.now();
  let fd = null;
  fs.mkdirSync(config.dataDir, { recursive: true });
  while (Date.now() - start < timeoutMs) {
    try {
      fd = fs.openSync(LOCK_FILE, 'wx');
      break;
    } catch (e) {
      if (e.code === 'EEXIST') {
        try {
          const stats = fs.statSync(LOCK_FILE);
          if (Date.now() - stats.mtimeMs > 10000) {
            try { fs.unlinkSync(LOCK_FILE); } catch {}
          }
        } catch {}
        const waitStart = Date.now();
        while (Date.now() - waitStart < pollIntervalMs) {}
      } else {
        throw e;
      }
    }
  }
  if (!fd) {
    throw new Error('Falha ao adquirir trava de arquivo do store (timeout)');
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
      fs.unlinkSync(LOCK_FILE);
    } catch {}
  }
}

function load(forceReload = false) {
  if (db && !forceReload) return db;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushNow();
  }
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    db = null;
  }
  db ||= {};
  db.visitors ||= {};
  db.orders ||= {};
  db.settings ||= { activeGatewayId: 'nitropay', disabledGateways: ['bspay', 'quantumpay'] };
  db.settings.activeGatewayId = 'nitropay';
  db.settings.disabledGateways = ['bspay', 'quantumpay'];
  db.gatewayFee ||= { fixed: config.gatewayFee.fixed, percent: config.gatewayFee.percent };
  db.integrations ||= {};

  for (const [id, cfg] of Object.entries(db.integrations)) {
    applyIntegrationConfig(id, cfg);
  }

  return db;
}

function applyIntegrationConfig(id, cfg = {}) {
  if (!cfg || typeof cfg !== 'object') return;
  if (id === 'bspay') {
    if (cfg.clientId !== undefined) config.bspay.clientId = cfg.clientId;
    if (cfg.clientSecret !== undefined) config.bspay.clientSecret = cfg.clientSecret;
    config.bspay.configured = Boolean(config.bspay.clientId && config.bspay.clientSecret);
  } else if (id === 'quantumpay') {
    if (cfg.accountId !== undefined) config.quantumpay.accountId = cfg.accountId;
    if (cfg.apiKey !== undefined) config.quantumpay.apiKey = cfg.apiKey;
    if (cfg.apiSecret !== undefined) config.quantumpay.apiSecret = cfg.apiSecret;
    config.quantumpay.configured = Boolean(config.quantumpay.apiKey && config.quantumpay.apiSecret);
  } else if (id === 'nitropay') {
    if (cfg.publicKey !== undefined) {
      config.nitropay.publicKey = cfg.publicKey;
      config.nitropaySecondary.publicKey = cfg.publicKey;
    }
    if (cfg.secretKey !== undefined) {
      config.nitropay.secretKey = cfg.secretKey;
      config.nitropaySecondary.secretKey = cfg.secretKey;
    }
    config.nitropay.configured = Boolean(config.nitropay.publicKey && config.nitropay.secretKey);
    config.nitropaySecondary.configured = Boolean(config.nitropaySecondary.publicKey && config.nitropaySecondary.secretKey);
  } else if (id === 'api-cpf') {
    if (cfg.baseUrl !== undefined) config.cpf.base = cfg.baseUrl;
    if (cfg.token !== undefined) config.cpf.token = cfg.token;
    config.cpf.configured = Boolean(config.cpf.token);
  } else if (id === 'utmify') {
    if (cfg.token !== undefined) config.utmify.apiToken = cfg.token;
    config.utmify.configured = Boolean(config.utmify.apiToken);
  }
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushNow, 150);
}

function flushNow() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    try {
      fs.renameSync(tmp, FILE);
    } catch (renameErr) {
      if (renameErr.code === 'EPERM' || renameErr.code === 'EBUSY') {
        fs.copyFileSync(tmp, FILE);
        try { fs.unlinkSync(tmp); } catch {}
      } else {
        throw renameErr;
      }
    }
  } catch (e) {
    console.error('[store] falha ao gravar:', e.message);
  }
}

const nowIso = () => new Date().toISOString();

function makeId(prefix, n = 8) {
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
  return `${prefix}-${s}`;
}

/** Status derivado igual ao painel: comprador / abandonado / em_andamento. */
function deriveStatus(v, { lastStageIndex = 8 } = {}) {
  if (v.purchased) return 'comprador';
  const idleMs = Date.now() - new Date(v.lastSeenAt || v.createdAt || Date.now()).getTime();
  if ((v.stageIndex || 0) >= lastStageIndex || idleMs > 30 * 60 * 1000) return 'abandonado';
  return 'em_andamento';
}

function shapeVisitor(v) {
  const out = {};
  for (const f of VISITOR_FIELDS) out[f] = v[f] ?? VISITOR_DEFAULTS[f];
  out.id = v.id;
  out.createdAt = v.createdAt;
  out.lastSeenAt = v.lastSeenAt;
  out.purchased = !!v.purchased;
  out.pushSubscribed = !!v.pushSubscribed;
  out.status = deriveStatus(v);
  return out;
}

function parseUa(ua = '') {
  const u = String(ua);
  const browser = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera'
    : /Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari'
      : /Firefox\//.test(u) ? 'Firefox' : 'Outro';
  const os = /Windows/.test(u) ? 'Windows' : /Android/.test(u) ? 'Android'
    : /iPhone|iPad|iOS/.test(u) ? 'iOS' : /Mac OS X/.test(u) ? 'macOS'
      : /Linux/.test(u) ? 'Linux' : 'Outro';
  const device = /Mobi|Android/i.test(u) ? 'mobile' : /iPad|Tablet/i.test(u) ? 'tablet' : 'desktop';
  return { browser, os, device };
}

const utf8len = (s) => Buffer.byteLength(String(s), 'utf8');

/** Trunca strings longas (evita payload abusivo vindo do cliente). */
function sanitize(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!VISITOR_FIELDS.includes(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, k === 'password' ? 200 : 300);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

const store = {
  load,
  flushNow,

  /* -------------------------------- visitantes ------------------------------- */
  createVisitor(payload = {}, reqInfo = {}) {
    const d = load();
    const id = payload.id || UUID();
    const ua = parseUa(reqInfo.userAgent);
    d.visitors[id] = shapeVisitor({
      ...VISITOR_DEFAULTS,
      ...sanitize(payload),
      ...ua,
      ip: reqInfo.ip || '',
      utmSource: payload.utmSource || reqInfo.utm?.utm_source || '',
      utmMedium: payload.utmMedium || reqInfo.utm?.utm_medium || '',
      utmCampaign: payload.utmCampaign || reqInfo.utm?.utm_campaign || '',
      utmTerm: payload.utmTerm || reqInfo.utm?.utm_term || '',
      utmContent: payload.utmContent || reqInfo.utm?.utm_content || '',
      src: payload.src || reqInfo.utm?.src || '',
      sck: payload.sck || reqInfo.utm?.sck || '',
      id,
      createdAt: nowIso(),
      lastSeenAt: nowIso(),
    });
    flush();
    const created = d.visitors[id];
    supabase.upsertVisitor(created).catch(() => {});
    return created;
  },

  getVisitor(id) {
    return load().visitors[id] || null;
  },

  upsertVisitorMemory(v) {
    if (!v || !v.id) return null;
    const d = load();
    d.visitors[v.id] = shapeVisitor({
      ...(d.visitors[v.id] || VISITOR_DEFAULTS),
      ...v,
    });
    return d.visitors[v.id];
  },

  updateVisitor(id, patch = {}) {
    const d = load();
    let current = d.visitors[id];
    if (!current) {
      current = { ...VISITOR_DEFAULTS, id };
    }
    d.visitors[id] = shapeVisitor({
      ...current,
      ...sanitize(patch),
      id,
      lastSeenAt: nowIso(),
    });
    flush();
    const updated = d.visitors[id];
    supabase.upsertVisitor(updated).catch(() => {});
    return updated;
  },

  markPurchased(id) {
    const d = load();
    if (!d.visitors[id]) return null;
    d.visitors[id] = shapeVisitor({ ...d.visitors[id], purchased: true, stage: 'pago', lastSeenAt: nowIso() });
    flush();
    const marked = d.visitors[id];
    supabase.upsertVisitor(marked).catch(() => {});
    return marked;
  },

  listVisitors() {
    const d = load();
    return Object.values(d.visitors)
      .map(shapeVisitor)
      .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));
  },

  /* ---------------------------------- ordens --------------------------------- */
  createOrder(order) {
    const d = load();
    const orderId = order.id || makeId('ord', 8);
    d.orders[orderId] = {
      ...order,
      id: orderId,
      status: order.status || 'PENDING',
      createdAt: nowIso(),
      paidAt: null,
    };
    flushNow();
    const created = d.orders[orderId];
    supabase.upsertOrder(created).catch(() => {});
    return created;
  },

  getOrder(id) {
    return load().orders[id] || null;
  },

  findByExternalId(externalId) {
    return Object.values(load().orders).find((o) => o.externalId === externalId) || null;
  },

  findByTransactionId(txId) {
    if (!txId) return null;
    return Object.values(load().orders).find((o) => o.transactionId === txId) || null;
  },

  updateOrder(id, patch) {
    const d = load();
    if (!d.orders[id]) return null;
    d.orders[id] = { ...d.orders[id], ...patch };
    flushNow();
    const updated = d.orders[id];
    supabase.upsertOrder(updated).catch(() => {});
    return updated;
  },

  /** Marca a ordem como COMPLETED (valor de status usado pelo frontend) — idempotente. */
  completeOrder(id, source, payload) {
    const d = load();
    const o = d.orders[id];
    if (!o) return null;
    if (o.status === 'COMPLETED') return o;
    o.status = 'COMPLETED';
    o.paidAt = nowIso();
    o.paidSource = source;
    o.events = [...(o.events || []), { at: nowIso(), type: `completed:${source}`, payload: payload || null }];
    if (o.visitorId) store.markPurchased(o.visitorId);
    flushNow();
    supabase.upsertOrder(o).catch(() => {});
    return o;
  },

  expireStale() {
    const d = load();
    let n = 0;
    for (const o of Object.values(d.orders)) {
      if (o.status === 'PENDING' && o.expiresAt && new Date(o.expiresAt).getTime() < Date.now()) {
        o.status = 'EXPIRED';
        n++;
      }
    }
    if (n) flush();
    return n;
  },

  getNextGateway() {
    const s = load().settings || {};
    const disabled = Array.isArray(s.disabledGateways) ? s.disabledGateways : [];
    const active = String(s.activeGatewayId || process.env.ACTIVE_GATEWAY_ID || config.activeGatewayId || 'nitropay').toLowerCase();

    // 1. Tenta usar o gateway ativo escolhido pelo usuário no painel, se configurado e não desativado
    if (!disabled.includes(active)) {
      if ((active === 'nitropay' || active === 'nitro') && (config.nitropaySecondary?.configured || config.nitropay?.configured)) {
        return 'nitropay';
      }
      if ((active === 'bspay' || active === 'bs') && config.bspay?.configured) {
        return 'bspay';
      }
      if ((active === 'quantumpay' || active === 'quantum') && config.quantumpay?.configured) {
        return 'quantumpay';
      }
    }

    // 2. Se o escolhido estiver desativado ou sem credenciais, faz fallback para outro gateway configurado
    if (!disabled.includes('nitropay') && (config.nitropaySecondary?.configured || config.nitropay?.configured)) return 'nitropay';
    if (!disabled.includes('bspay') && config.bspay?.configured) return 'bspay';
    if (!disabled.includes('quantumpay') && config.quantumpay?.configured) return 'quantumpay';

    if (config.allowMockPix) return 'mock';
    return active || 'nitropay';
  },

  getNextNitroAccount() {
    return 'primary';
  },

  /* --------------------------------- configuração ---------------------------- */
  getSettings() {
    const s = load().settings || {};
    return {
      activeGatewayId: s.activeGatewayId || process.env.ACTIVE_GATEWAY_ID || config.activeGatewayId || 'nitropay',
      disabledGateways: Array.isArray(s.disabledGateways) ? s.disabledGateways : ['bspay', 'quantumpay'],
      ...s,
    };
  },

  setSettings(patch) {
    const d = load();
    d.settings = { ...d.settings, ...patch };
    flush();
    supabase.setSetting('gateways', d.settings).catch(() => {});
    return this.getSettings();
  },

  getGatewayFee() {
    return load().gatewayFee;
  },

  setGatewayFee(patch) {
    const d = load();
    d.gatewayFee = {
      fixed: Number(patch.fixed ?? d.gatewayFee.fixed) || 0,
      percent: Number(patch.percent ?? d.gatewayFee.percent) || 0,
    };
    flush();
    return d.gatewayFee;
  },

  getIntegrations() {
    const d = load();
    d.integrations = d.integrations || {};
    return d.integrations;
  },

  setIntegration(id, patch) {
    const d = load();
    d.integrations = d.integrations || {};
    d.integrations[id] = { ...(d.integrations[id] || {}), ...patch };
    applyIntegrationConfig(id, d.integrations[id]);
    flush();
    supabase.setIntegration(id, d.integrations[id]).catch(() => {});
    return d.integrations[id];
  },

  stats() {
    const d = load();
    const orders = Object.values(d.orders);
    const visitors = Object.values(d.visitors);
    return {
      visitors: visitors.length,
      buyers: visitors.filter((v) => v.purchased).length,
      orders: orders.length,
      paid: orders.filter((o) => o.status === 'COMPLETED').length,
      revenue: Number(orders.filter((o) => o.status === 'COMPLETED').reduce((s, o) => s + (o.amount || 0), 0).toFixed(2)),
      pending: orders.filter((o) => o.status === 'PENDING').length,
      avgTicket: orders.length
        ? Number((orders.reduce((s, o) => s + (o.amount || 0), 0) / orders.length).toFixed(2))
        : 0,
    };
  },

  /* ------------------------------- outbox ga4 ------------------------------- */
  acquireGa4Outbox(orderId, { staleTimeoutMs = 60000, maxRetries = 5, lockId } = {}) {
    return withFileLock(() => {
      const d = load(true);
      const o = d.orders[orderId];
      if (!o) return { acquired: false, reason: 'order_not_found' };

      const outbox = o.ga4Outbox || {};
      if (outbox.status === 'SENT') {
        return { acquired: false, reason: 'already_sent' };
      }

      if (outbox.status === 'IN_PROGRESS') {
        const lockAge = Date.now() - new Date(outbox.lockedAt || 0).getTime();
        if (lockAge <= staleTimeoutMs) {
          return { acquired: false, reason: 'in_progress_active', lockedBy: outbox.lockedBy };
        }
        console.warn(`[ga4-outbox] lock abandonado detectado para ordem ${orderId} (${Math.round(lockAge / 1000)}s atrás). Recuperando lock.`);
      }

      const currentAttempts = Number(outbox.attempts || 0);
      if (currentAttempts >= maxRetries) {
        o.ga4Outbox = {
          ...outbox,
          status: 'FAILED_PERMANENT',
          lastError: outbox.lastError || 'max_retries_exceeded',
          failedAt: nowIso(),
        };
        flushNow();
        return { acquired: false, reason: 'max_retries_exceeded', attempts: currentAttempts };
      }

      const nextAttempt = currentAttempts + 1;
      const workerId = lockId || `${process.pid}-${UUID().slice(0, 8)}`;
      o.ga4Outbox = {
        ...outbox,
        status: 'IN_PROGRESS',
        attempts: nextAttempt,
        lockedAt: nowIso(),
        lockedBy: workerId,
        lastAttemptAt: nowIso(),
        transactionId: o.id,
      };
      flushNow();
      return { acquired: true, order: o, attempt: nextAttempt, workerId };
    });
  },

  releaseGa4Outbox(orderId, { success, httpStatus, error, transportStatus } = {}) {
    return withFileLock(() => {
      const d = load(true);
      const o = d.orders[orderId];
      if (!o) return null;

      const current = o.ga4Outbox || {};
      if (success) {
        o.ga4Outbox = {
          ...current,
          status: 'SENT',
          // NOTA: HTTP 204 confirma o recebimento no edge do Google Analytics, não validação síncrona
          transportStatus: transportStatus || 'ACCEPTED_BY_EDGE',
          sentAt: nowIso(),
          httpStatus: httpStatus || 204,
          error: null,
        };
      } else {
        o.ga4Outbox = {
          ...current,
          status: 'FAILED',
          lastError: error || 'transmission_failed',
          failedAt: nowIso(),
          httpStatus: httpStatus || null,
        };
      }
      flushNow();
      return o.ga4Outbox;
    });
  },

  listPendingOrFailedGa4Outbox({ maxRetries = 5, staleTimeoutMs = 60000 } = {}) {
    const d = load(true);
    const now = Date.now();
    return Object.values(d.orders).filter((o) => {
      if (o.status !== 'COMPLETED') return false;
      const ob = o.ga4Outbox;
      if (!ob || ob.status === 'PENDING') return true;
      if (ob.status === 'FAILED' && (ob.attempts || 0) < maxRetries) return true;
      if (ob.status === 'IN_PROGRESS' && now - new Date(ob.lockedAt || 0).getTime() > staleTimeoutMs) return true;
      return false;
    });
  },

  async reconcileGa4Outbox({ ga4Module, maxRetries = 5, staleTimeoutMs = 60000 } = {}) {
    const ga4 = ga4Module || require('./ga4');
    const candidates = store.listPendingOrFailedGa4Outbox({ maxRetries, staleTimeoutMs });
    if (!candidates.length) return { processed: 0, successes: 0, failures: 0 };

    let successes = 0;
    let failures = 0;

    for (const order of candidates) {
      const lockRes = store.acquireGa4Outbox(order.id, { staleTimeoutMs, maxRetries });
      if (!lockRes.acquired) continue;

      const visitor = order.visitorId ? store.getVisitor(order.visitorId) : null;
      const combinedUser = {
        ...(visitor || {}),
        ...(order.customer || {}),
      };

      try {
        const res = await ga4.sendPurchase(order, combinedUser);
        if (res && res.success) {
          store.releaseGa4Outbox(order.id, {
            success: true,
            httpStatus: res.status,
            transportStatus: 'ACCEPTED_BY_EDGE',
          });
          successes++;
        } else {
          store.releaseGa4Outbox(order.id, {
            success: false,
            httpStatus: res?.status,
            error: res?.error || 'reconciliation_failed',
          });
          failures++;
        }
      } catch (err) {
        store.releaseGa4Outbox(order.id, {
          success: false,
          error: err.message,
        });
        failures++;
      }
    }

    return { processed: candidates.length, successes, failures };
  },

  uuid: UUID,
  id: makeId,
  utf8len,
  withFileLock,
};

module.exports = store;
