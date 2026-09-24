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

const FILE = path.join(config.dataDir, 'store.json');
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

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    db = null;
  }
  db ||= {};
  db.visitors ||= {};
  db.orders ||= {};
  db.settings ||= { activeGatewayId: config.bspay.activeGatewayId };
  db.gatewayFee ||= { fixed: config.gatewayFee.fixed, percent: config.gatewayFee.percent };
  return db;
}

function flush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushNow, 150);
}

function flushNow() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(db, null, 2));
    fs.renameSync(`${FILE}.tmp`, FILE);
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
      id,
      createdAt: nowIso(),
      lastSeenAt: nowIso(),
    });
    flush();
    return d.visitors[id];
  },

  getVisitor(id) {
    return load().visitors[id] || null;
  },

  updateVisitor(id, patch) {
    const d = load();
    const current = d.visitors[id];
    if (!current) return null;
    d.visitors[id] = shapeVisitor({
      ...current,
      ...sanitize(patch),
      id,
      lastSeenAt: nowIso(),
    });
    flush();
    return d.visitors[id];
  },

  markPurchased(id) {
    const d = load();
    if (!d.visitors[id]) return null;
    d.visitors[id] = shapeVisitor({ ...d.visitors[id], purchased: true, stage: 'pago', lastSeenAt: nowIso() });
    flush();
    return d.visitors[id];
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
    flush();
    return d.orders[orderId];
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
    flush();
    return d.orders[id];
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
    flush();
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

  /* --------------------------------- configuração ---------------------------- */
  getSettings() {
    return load().settings;
  },

  setSettings(patch) {
    const d = load();
    d.settings = { ...d.settings, ...patch };
    flush();
    return d.settings;
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

  uuid: UUID,
  id: makeId,
  utf8len,
};

module.exports = store;
