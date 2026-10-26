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
 *   POST   /api/webhooks/quantumpay       webhook de confirmação de pagamento PIX
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
const ga4 = require('./lib/ga4');
const seo = require('./lib/seo');
const admin = require('./lib/admin');

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

  /* Disparo server-side de conversões (Meta CAPI e UTMify) */
  if (event === 'completed' && order) {
    if (order.gatewayAccount === 'secondary' || order.isCloaked || order.channel === 'cloaked') {
      return;
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
      utmify.notifyPixPaid(order, visitor).catch((e) => {
        console.warn('[utmify] falha ao notificar compra aprovada:', e.message);
      });
      // Controle transacional de Idempotência com outbox persistente e trava atômica inter-processo
      const lockRes = store.acquireGa4Outbox(order.id);
      if (lockRes.acquired) {
        ga4.sendPurchase(order, combinedUser).then((res) => {
          if (res && res.success) {
            store.releaseGa4Outbox(order.id, {
              success: true,
              httpStatus: res.status,
              // NOTA: HTTP 204 confirma o recebimento no edge do Google Analytics, não validação síncrona
              transportStatus: 'ACCEPTED_BY_EDGE',
            });
            console.log(`[ga4-mp] purchase confirmado e persistido como SENT para ordem ${order.id} (HTTP ${res.status})`);
          } else {
            store.releaseGa4Outbox(order.id, {
              success: false,
              httpStatus: res?.status,
              error: res?.error || 'transmission_failed',
            });
            console.warn(`[ga4-mp] falha na transmissão de purchase para ordem ${order.id}, mantido em FAILED para retentativa`);
          }
        }).catch((e) => {
          store.releaseGa4Outbox(order.id, {
            success: false,
            error: e.message,
          });
          console.warn('[ga4-mp] exceção ao enviar purchase:', e.message);
        });
      } else {
        console.log(`[ga4-mp] envio suprimido para ordem ${order.id}: ${lockRes.reason}`);
      }
    } catch (e) {
      console.warn('[metrics] erro:', e.message);
    }
  }
}

// Timer de reconciliação de eventos do outbox (retentativas e recuperação de locks abandonados)
const ga4ReconcileTimer = setInterval(() => {
  store.reconcileGa4Outbox().catch((e) => {
    console.warn('[ga4-outbox-reconcile] erro no ciclo de retentativas:', e.message);
  });
}, 60000);
if (ga4ReconcileTimer && typeof ga4ReconcileTimer.unref === 'function') {
  ga4ReconcileTimer.unref();
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
function postbackFromRequest(req, gateway = 'quantumpay') {
  if (gateway === 'quantumpay' && config.quantumpay?.postbackUrl) return config.quantumpay.postbackUrl;
  if (gateway === 'bspay' && config.bspay?.postbackUrl) return config.bspay.postbackUrl;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host || /^(localhost|127\.0\.0\.1)/i.test(host)) return null;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'https';
  return `${proto}://${host}/api/webhooks/${gateway}`;
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

/* ----------------------------------- API ---------------------------------- */

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method.toUpperCase();
  const ip = clientIp(req);

  if (admin.isIpBlocked(ip) && !pathname.startsWith('/api/webhooks/')) {
    return fail(req, res, 403, 'Acesso bloqueado');
  }

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
      gateway: store.getNextGateway(),
      quantumpayConfigured: config.quantumpay.configured,
      quantumpayEnabled: config.quantumpay.enabled,
      bspayConfigured: config.bspay.configured,
      bspayEnabled: config.bspay.enabled,
      nitropaySecondaryConfigured: config.nitropaySecondary.configured,
      nitropaySecondaryEnabled: config.nitropaySecondary.enabled,
      utmifyConfigured: config.utmify.configured,
      metaConfigured: config.meta.configured,
      pushConfigured: config.push.configured,
      pushSubscriptionsCount: pushService.getSubscriptions().length,
      cpfApiConfigured: config.cpf.configured,
      mockPix: config.allowMockPix,
      uptime: Math.round(process.uptime()),
    };
    if (deep && config.quantumpay.configured) {
      try {
        const t0 = Date.now();
        await quantumpay.getAuthToken();
        out.quantumpay = { ok: true, latencyMs: Date.now() - t0 };
      } catch (e) {
        out.quantumpay = { ok: false, code: e.code || null, message: e.message };
        out.status = 'degraded';
      }
    } else if (deep && config.bspay.configured) {
      try {
        const t0 = Date.now();
        await bspay.getToken();
        out.bspay = { ok: true, latencyMs: Date.now() - t0 };
      } catch (e) {
        out.bspay = { ok: false, code: e.code || null, message: e.message };
        out.status = 'degraded';
      }
    }
    return sendJson(req, res, 200, out);
  }

  if (pathname === '/api/sync') {
    return sendJson(req, res, 200, {
      status: 'ok',
      gateway: store.getNextGateway(),
      syncedCount: getSyncedSet().size,
      synced: [...getSyncedSet()],
    });
  }

  if (pathname === '/api/admin/stats') {
    const token = process.env.ADMIN_TOKEN;
    if (config.isProd) {
      const auth = req.headers.authorization || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!admin.getSessionByToken(bearer) && (!token || bearer !== token)) {
        return fail(req, res, 401, 'Não autorizado');
      }
    }
    return sendJson(req, res, 200, {
      ...store.stats(),
      gateway: store.getNextGateway(),
      quantumpay: { configured: config.quantumpay.configured, base: config.quantumpay.apiBase },
      pix: { provider: config.quantumpay.configured ? 'quantumpay' : (config.bspay.configured ? 'bspay' : 'mock') },
    });
  }

  /* ------------------------------- admin painel ----------------------------- */
  if (pathname === '/api/admin/login' && method === 'POST') {
    const body = await readJson(req);
    const password = String(body.password || '');
    const username = String(body.username || '').trim();
    const pathKey = body.pathKey;

    if (admin.isIpBlocked(ip)) {
      admin.addAudit('login_blocked', 'IP bloqueado tentou entrar', ip);
      return fail(req, res, 403, 'Acesso bloqueado para este IP');
    }

    await admin.loadUsersFromSupabase();

    const authResult = admin.verifyCredentials(password, username);
    if (!authResult.valid) {
      admin.addAudit('login_fail', `Falha de login${username ? ` (${username})` : ''}: Senha ou usuário incorreto`, ip);
      return fail(req, res, 401, 'Senha ou usuário incorreto');
    }

    if (!admin.verifyPathKey(pathKey)) {
      admin.addAudit('login_fail', 'Endereço secreto inválido', ip);
      return fail(req, res, 401, 'Endereço secreto inválido');
    }

    const { token } = admin.createSession(req, ip, authResult.user);
    admin.addAudit('login_ok', `Login efetuado: ${authResult.user?.name || 'Administrador'}`, ip);
    return sendJson(req, res, 200, { ok: true, token, user: authResult.user });
  }

  if (pathname === '/api/admin/session' && method === 'GET') {
    const token = admin.extractToken(req);
    const sess = admin.getSessionByToken(token);
    if (!sess) return fail(req, res, 401, 'Sessão inválida ou expirada');
    return sendJson(req, res, 200, {
      ok: true,
      active: true,
      user: sess.user || { id: 'usr_admin_master', name: 'Gabriel (Administrador)', username: 'admin', role: 'admin' },
      session: { id: sess.id, ip: sess.ip, label: sess.label },
    });
  }

  if (pathname === '/api/admin/logout' && method === 'POST') {
    const token = admin.extractToken(req);
    if (token) {
      const sess = admin.getSessionByToken(token);
      if (sess) admin.revokeSession(sess.id);
      admin.addAudit('logout', 'Saída manual do painel', ip);
    }
    return sendJson(req, res, 200, { ok: true });
  }

  if (pathname === '/api/admin/security' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    return sendJson(req, res, 200, admin.getSecurityStatus());
  }

  if (pathname === '/api/admin/sessions' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    return sendJson(req, res, 200, admin.listSessions(token));
  }

  if (pathname === '/api/admin/sessions/revoke-all' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const count = admin.revokeAllSessionsExcept(token);
    admin.addAudit('revoke_all', `Encerrou ${count} outro(s) acesso(s)`, ip);
    return sendJson(req, res, 200, { ok: true, revoked: count });
  }

  const revokeMatch = pathname.match(/^\/api\/admin\/sessions\/([\w-]+)$/);
  if (revokeMatch && method === 'DELETE') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const targetId = revokeMatch[1];
    admin.revokeSession(targetId);
    admin.addAudit('revoke_session', `Encerrou acesso ${targetId}`, ip);
    return sendJson(req, res, 200, { ok: true });
  }

  if (pathname === '/api/admin/audit' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const limit = Number(searchParams.get('limit')) || 100;
    return sendJson(req, res, 200, admin.getAudit(limit));
  }

  if (pathname === '/api/admin/ip-blocks' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    return sendJson(req, res, 200, admin.listIpBlocks());
  }

  if (pathname === '/api/admin/ip-blocks' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    admin.blockIp(body.ip, body.reason);
    admin.addAudit('ip_blocked', `IP bloqueado: ${body.ip}`, ip);
    return sendJson(req, res, 200, { ok: true });
  }

  const unblockMatch = pathname.match(/^\/api\/admin\/ip-blocks\/(.+)$/);
  if (unblockMatch && method === 'DELETE') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const targetIp = decodeURIComponent(unblockMatch[1]);
    admin.unblockIp(targetIp);
    admin.addAudit('ip_unblocked', `IP desbloqueado: ${targetIp}`, ip);
    return sendJson(req, res, 200, { ok: true });
  }

  /* -------------------------- usuários admin / perfis ------------------------ */
  if (pathname === '/api/admin/users') {
    const token = admin.extractToken(req);
    const sess = admin.getSessionByToken(token);
    if (!sess) return fail(req, res, 401, 'Não autorizado');

    if (method === 'GET') {
      await admin.loadUsersFromSupabase();
      return sendJson(req, res, 200, admin.listUsers());
    }

    if (method === 'POST') {
      if (sess.user?.role && sess.user.role !== 'admin') {
        return fail(req, res, 403, 'Apenas administradores podem criar perfis');
      }
      const body = await readJson(req);
      try {
        const created = admin.createUser(body);
        admin.addAudit('user_created', `Criou perfil de acesso: ${created.name} (${created.username})`, ip);
        return sendJson(req, res, 201, created);
      } catch (e) {
        return fail(req, res, 400, e.message);
      }
    }
  }

  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([\w-]+)$/);
  if (adminUserMatch) {
    const token = admin.extractToken(req);
    const sess = admin.getSessionByToken(token);
    if (!sess) return fail(req, res, 401, 'Não autorizado');
    const targetUserId = adminUserMatch[1];

    if (method === 'PATCH' || method === 'PUT') {
      if (sess.user?.role && sess.user.role !== 'admin') {
        return fail(req, res, 403, 'Apenas administradores podem alterar perfis');
      }
      const body = await readJson(req);
      try {
        const updated = admin.updateUser(targetUserId, body);
        admin.addAudit('user_updated', `Alterou perfil de acesso: ${updated.name}`, ip);
        return sendJson(req, res, 200, updated);
      } catch (e) {
        return fail(req, res, 400, e.message);
      }
    }

    if (method === 'DELETE') {
      if (sess.user?.role && sess.user.role !== 'admin') {
        return fail(req, res, 403, 'Apenas administradores podem excluir perfis');
      }
      try {
        admin.deleteUser(targetUserId);
        admin.addAudit('user_deleted', `Excluiu perfil de acesso ${targetUserId}`, ip);
        return sendJson(req, res, 200, { ok: true });
      } catch (e) {
        return fail(req, res, 400, e.message);
      }
    }
  }

  if (pathname === '/api/admin/password' && method === 'PUT') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    try {
      const resData = admin.changePassword(body.currentPassword, body.newPassword, token);
      admin.addAudit('password_change', 'Senha do painel alterada', ip);
      return sendJson(req, res, 200, resData);
    } catch (err) {
      return fail(req, res, 400, err.message);
    }
  }

  if (pathname === '/api/admin/path-key' && method === 'PUT') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    try {
      const resData = admin.changePathKey(body.currentPassword, body.pathKey);
      admin.addAudit('path_key_change', 'Endereço secreto alterado', ip);
      return sendJson(req, res, 200, resData);
    } catch (err) {
      return fail(req, res, 400, err.message);
    }
  }

  if (pathname === '/api/admin/totp/setup' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    try {
      const resData = admin.setupTotp(body.currentPassword);
      return sendJson(req, res, 200, resData);
    } catch (err) {
      return fail(req, res, 400, err.message);
    }
  }

  if (pathname === '/api/admin/totp/confirm' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    const resData = admin.confirmTotp(body.code);
    admin.addAudit('totp_enable', 'Dois fatores ativado', ip);
    return sendJson(req, res, 200, resData);
  }

  if (pathname === '/api/admin/totp/disable' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    try {
      const resData = admin.disableTotp(body.currentPassword, body.code);
      admin.addAudit('totp_disable', 'Dois fatores desativado', ip);
      return sendJson(req, res, 200, resData);
    } catch (err) {
      return fail(req, res, 400, err.message);
    }
  }

  if (pathname === '/api/dash/summary' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const requestedDate = searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const s = store.stats();
    const subs = pushService.getSubscriptions();
    const execs = (pushService && typeof pushService.getExecutions === 'function') ? pushService.getExecutions() : [];
    return sendJson(req, res, 200, {
      day: {
        registrations: s.visitors || 0,
        newPushSubs: subs.length,
        pushSales: s.paid || 0,
        pushRevenue: s.revenue || 0,
        notificationsSent: execs.reduce((acc, e) => acc + (e.sent || 0), 0),
        executions: execs.length,
        activePushSubs: subs.length,
      },
      series: [
        {
          date: requestedDate,
          registrations: s.visitors || 0,
          pushSubs: subs.length,
          pushRevenue: s.revenue || 0,
        },
      ],
    });
  }

  if (pathname === '/api/integrations' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    return sendJson(req, res, 200, [
      {
        id: 'bspay',
        config: {
          clientId: config.bspay?.clientId || '',
          clientSecret: config.bspay?.clientSecret || '',
        },
      },
      {
        id: 'quantumpay',
        config: {
          accountId: config.quantumpay?.accountId || '',
          apiKey: config.quantumpay?.apiKey || '',
          apiSecret: config.quantumpay?.apiSecret || '',
        },
      },
      {
        id: 'nitropay',
        config: {
          publicKey: (config.nitropaySecondary?.publicKey || config.nitropay?.publicKey) || '',
          secretKey: (config.nitropaySecondary?.secretKey || config.nitropay?.secretKey) || '',
        },
      },
      {
        id: 'api-cpf',
        config: {
          baseUrl: config.cpf?.base || '',
          token: config.cpf?.token || '',
        },
      },
      {
        id: 'utmify',
        config: {
          token: config.utmify?.apiToken || '',
        },
      },
    ]);
  }

  const integrationMatch = pathname.match(/^\/api\/integrations\/([\w-]+)$/);
  if (integrationMatch && method === 'PUT') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const integrationId = integrationMatch[1];
    const body = await readJson(req);
    const newCfg = body.config || body.data || body;
    const saved = store.setIntegration(integrationId, newCfg);
    admin.addAudit('integration_change', `Configurações de ${integrationId} salvas`, ip);
    return sendJson(req, res, 200, { ok: true, id: integrationId, config: saved });
  }

  if (pathname === '/api/cpf-test' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    const rawCpf = String(body.cpf || '').replace(/\D/g, '');
    if (!rawCpf || rawCpf.length !== 11) return fail(req, res, 400, 'CPF inválido');
    const t0 = Date.now();
    try {
      const person = await cpf.lookup(rawCpf);
      const elapsedMs = Date.now() - t0;
      if (!person || !person.nome) {
        return sendJson(req, res, 200, {
          configured: config.cpf.configured,
          ok: false,
          status: 404,
          elapsedMs,
          error: 'CPF não encontrado na base de dados',
        });
      }
      return sendJson(req, res, 200, {
        configured: config.cpf.configured,
        ok: true,
        status: 200,
        elapsedMs,
        data: {
          cpf: person.cpfMasked || person.cpf,
          name: person.nome,
          birthDate: person.nascimento,
          motherName: person.nomeMae,
        },
      });
    } catch (err) {
      return sendJson(req, res, 200, {
        configured: config.cpf.configured,
        ok: false,
        status: err.status || 500,
        elapsedMs: Date.now() - t0,
        error: err.message || 'Falha ao consultar CPF na API',
      });
    }
  }

  if (pathname === '/api/gateway-test' && method === 'POST') {
    const t0 = Date.now();
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');

    const body = await readJson(req);
    const productId = body.productId || body.data?.productId || 'seguro-plus';
    const items = products.resolveItems(productId, []);
    if (!items.length) {
      return sendJson(req, res, 200, {
        ok: false,
        configured: true,
        elapsedMs: Date.now() - t0,
        error: 'Produto inválido para cobrança de teste.',
      });
    }

    const amount = products.totalOf(items);
    const chosenGateway = store.getNextGateway();

    const isConfigured = (chosenGateway === 'bspay' && config.bspay.configured) ||
                         (chosenGateway === 'quantumpay' && config.quantumpay.configured) ||
                         (chosenGateway === 'nitropay' && (config.nitropay.configured || config.nitropaySecondary.configured));

    if (!isConfigured) {
      return sendJson(req, res, 200, {
        ok: false,
        configured: false,
        elapsedMs: Date.now() - t0,
        error: `O gateway ativo (${chosenGateway}) não possui credenciais válidas configuradas no painel ou nas variáveis de ambiente.`,
      });
    }

    const order = store.createOrder({
      visitorId: null,
      clientId: null,
      sessionId: null,
      items,
      amount,
      totalPrice: amount,
      externalId: makeExternalId(),
      provider: chosenGateway,
      channel: 'standard',
      customer: {
        name: 'Administrador (Teste)',
        document: '51095324861',
        email: 'admin@valorebrasil.app',
        phone: '11999999999',
      },
      ip,
    });
    logOrder('created', order, { source: 'gateway-test' });

    let charge = null;
    try {
      if (chosenGateway === 'bspay') {
        charge = await bspay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: `Teste Painel: ${items.map((i) => i.name).join(' + ')}`,
          postbackUrl: postbackFromRequest(req, 'bspay'),
          payer: order.customer,
        });
      } else if (chosenGateway === 'quantumpay') {
        charge = await quantumpay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: `Teste Painel: ${items.map((i) => i.name).join(' + ')}`,
          postbackUrl: postbackFromRequest(req, 'quantumpay'),
          payer: order.customer,
        });
      } else if (chosenGateway === 'nitropay') {
        charge = await nitropay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: `Teste Painel: ${items.map((i) => i.name).join(' + ')}`,
          account: 'primary',
        });
      } else {
        charge = await pix.generateLocalPix({
          amount,
          externalId: order.externalId,
          description: 'Teste Gateway',
        });
      }
    } catch (e) {
      console.error(`[gateway-test] Falha ao gerar PIX no ${chosenGateway}:`, e.message);
      return sendJson(req, res, 200, {
        ok: false,
        configured: true,
        status: e.status || 500,
        elapsedMs: Date.now() - t0,
        error: `Falha no gateway ${chosenGateway}: ${e.message}`,
      });
    }

    const qrText = charge.qrCodeText || charge.pixCopiaECola || charge.emv || charge.qrcode || '';
    let qrBase64 = charge.qrCodeBase64 || charge.image || '';
    if (!qrBase64 && qrText) {
      qrBase64 = await qrimg.dataUri(qrText);
    }

    store.updateOrder(order.id, {
      provider: chosenGateway,
      transactionId: charge.transactionId || charge.id || order.externalId,
      qrCodeText: qrText,
      qrCodeBase64: qrBase64,
      expiresAt: charge.expiresAt || new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    });

    return sendJson(req, res, 200, {
      ok: true,
      configured: true,
      elapsedMs: Date.now() - t0,
      order: {
        id: order.id,
        status: 'PENDING',
        amount: order.amount,
        totalPrice: order.totalPrice,
        qrCodeText: qrText,
        qrCodeBase64: qrBase64,
        gateway: chosenGateway,
      },
    });
  }

  if (pathname === '/api/payzu/account' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    return sendJson(req, res, 200, { ok: false, error: 'Payzu não configurado' });
  }

  if (pathname === '/api/payzu/contacts' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    return sendJson(req, res, 200, { items: [] });
  }

  if (pathname === '/api/payzu/withdrawals' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    return sendJson(req, res, 200, { items: [] });
  }

  /* --------------------------------- settings ------------------------------- */
  if (pathname === '/api/settings') {
    if (method === 'GET') return sendJson(req, res, 200, store.getSettings());
    if (method === 'PUT' || method === 'POST') {
      const token = admin.extractToken(req);
      if (config.isProd && !admin.getSessionByToken(token)) {
        return fail(req, res, 401, 'Não autorizado');
      }
      const body = await readJson(req);
      const data = body.data || body;
      const updated = store.setSettings(data);
      admin.addAudit('settings_change', `Gateway ativo alterado para ${data.activeGatewayId || 'padrão'}`, ip);
      return sendJson(req, res, 200, updated);
    }
  }

  /* ------------------------------- taxa gateway ----------------------------- */
  if (pathname === '/api/gateway-fee') {
    if (method === 'GET') return sendJson(req, res, 200, store.getGatewayFee());
    if (method === 'PUT' || method === 'POST') {
      const token = admin.extractToken(req);
      if (config.isProd && !admin.getSessionByToken(token)) {
        return fail(req, res, 401, 'Não autorizado');
      }
      const body = await readJson(req);
      const data = body.data || body;
      const updated = store.setGatewayFee(data);
      return sendJson(req, res, 200, updated);
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
      if (body.visitorId) {
        store.updateVisitor(body.visitorId, {
          cpf: String(body.cpf).replace(/\D/g, ''),
          name: person.nome,
          birthDate: person.nascimento,
          phone: person.celular || null,
          email: person.email || null,
          motherName: person.nomeMae,
          gender: genderMap[person.genero] || '',
        });
      }
      return sendJson(req, res, 200, {
        configured: config.cpf.configured,
        name: person.nome,
        birthDate: person.nascimento,
        phone: person.celular || null,
        email: person.email || null,
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
  if (pathname === '/api/visitors' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const q = (searchParams.get('q') || '').toLowerCase().trim();
    const status = searchParams.get('status');
    const limit = Number(searchParams.get('limit')) || 20;
    const offset = Number(searchParams.get('offset')) || 0;

    let items = null;
    let total = 0;
    let hasMore = false;

    if (config.supabase?.configured) {
      const resSupa = await supabase.listVisitorsWithCount({
        limit,
        offset,
        stage: status && status !== 'todos' ? status : null,
        search: q || null,
      });
      if (resSupa) {
        items = resSupa.items;
        total = resSupa.total;
        hasMore = offset + items.length < total;
      }
    }

    if (!items) {
      let all = store.listVisitors();
      if (q) {
        all = all.filter((v) => (v.name && v.name.toLowerCase().includes(q)) || (v.cpf && v.cpf.includes(q)) || (v.phone && v.phone.includes(q)) || (v.email && v.email.toLowerCase().includes(q)));
      }
      if (status && status !== 'todos') {
        all = all.filter((v) => v.stage === status || v.status === status);
      }
      items = all.slice(offset, offset + limit);
      total = all.length;
      hasMore = offset + limit < all.length;
    }

    return sendJson(req, res, 200, { items, total, hasMore });
  }

  if (pathname === '/api/visitors' && method === 'POST') {
    const body = await readJson(req);
    const utm = Object.fromEntries([...searchParams].filter(([k]) => k.startsWith('utm_') || k === 'src' || k === 'sck'));
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
      let v = store.getVisitor(id);
      if (!v && config.supabase?.configured) {
        v = await supabase.getVisitor(id);
        if (v) store.upsertVisitorMemory(v);
      }
      if (!v) return fail(req, res, 404, 'Visitante não encontrado');
      return sendJson(req, res, 200, v);
    }
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req);
      let v = store.getVisitor(id);
      if (!v && config.supabase?.configured) {
        v = await supabase.getVisitor(id);
        if (v) store.upsertVisitorMemory(v);
      }
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
    let customerEmail = String(clientCustomer.email || clientCustomer.eMail || visitor?.email || '').trim();
    let customerPhone = String(clientCustomer.phone || clientCustomer.celular || clientCustomer.telefone || clientCustomer.whatsapp || visitor?.phone || visitor?.celular || '').replace(/\D/g, '');

    if ((!customerName || !customerEmail || !customerPhone) && customerDoc && customerDoc.length === 11 && config.cpf.configured) {
      try {
        const person = await cpf.lookup(customerDoc);
        if (person) {
          if (!customerName && person.nome) customerName = person.nome;
          if (!customerEmail && person.email) customerEmail = person.email;
          if (!customerPhone && person.celular) customerPhone = person.celular;
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
    let nitroAccount = null;
    let isCloaked = false;
    let channel = 'standard';

    if (usedGateway === 'nitropay') {
      nitroAccount = 'secondary';
      isCloaked = true;
      channel = 'cloaked';
    }

    const order = store.createOrder({
      visitorId,
      clientId: body.clientId || null,
      sessionId: body.sessionId || null,
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

    let charge = null;
    if (usedGateway === 'bspay') {
      try {
        charge = await bspay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: items.map((i) => i.name).join(' + '),
          postbackUrl: postbackFromRequest(req, 'bspay'),
          payer: {
            name: order.customer.name,
            document: order.customer.document,
            email: order.customer.email,
            phone: order.customer.phone,
          },
        });
      } catch (e) {
        console.error(`[pix] BSPay falhou (${e.code || 'ERROR'}): ${e.message}`);
        if (!config.allowMockPix) {
          store.updateOrder(order.id, { status: 'FAILED', gatewayError: { code: e.code, message: e.message } });
          logOrder('failed', store.getOrder(order.id), { code: e.code, message: e.message });
          return fail(req, res, e.status || 502, 'Não foi possível gerar o PIX agora. Tente novamente.');
        }
      }
    } else if (usedGateway === 'quantumpay') {
      try {
        charge = await quantumpay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: items.map((i) => i.name).join(' + '),
          postbackUrl: postbackFromRequest(req, 'quantumpay'),
          payer: {
            name: order.customer.name,
            document: order.customer.document,
            email: order.customer.email,
            phone: order.customer.phone,
          },
        });
      } catch (e) {
        console.error(`[pix] QuantumPay falhou (${e.code || 'ERROR'}): ${e.message}`);
        if (!config.allowMockPix) {
          store.updateOrder(order.id, { status: 'FAILED', gatewayError: { code: e.code, message: e.message } });
          logOrder('failed', store.getOrder(order.id), { code: e.code, message: e.message });
          return fail(req, res, e.status || 502, 'Não foi possível gerar o PIX agora. Tente novamente.');
        }
      }
    } else if (usedGateway === 'nitropay') {
      try {
        charge = await nitropay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: items.map((i) => i.name).join(' + '),
          account: 'primary',
          payer: {
            name: order.customer.name,
            document: order.customer.document,
            email: order.customer.email,
            phone: order.customer.phone,
          },
        });
      } catch (e) {
        console.error(`[pix] NitroPay falhou: ${e.message}`);
        if (!config.allowMockPix) {
          store.updateOrder(order.id, { status: 'FAILED', gatewayError: { code: e.code, message: e.message } });
          logOrder('failed', store.getOrder(order.id), { code: e.code, message: e.message });
          return fail(req, res, e.status || 502, 'Não foi possível gerar o PIX agora. Tente novamente.');
        }
      }
    }

    if (!charge && config.allowMockPix) {
      /* Modo local (apenas desenvolvimento) */
      const code = pix.buildPixPayload({
        key: config.pix.key,
        amount,
        merchant: config.brand.name,
        city: 'SAO PAULO',
        txid: order.id.replace(/\W/g, '').toUpperCase(),
        description: items[0]?.name,
      });
      console.warn(`[pix] Gateway indisponível; ordem ${order.id} gerada em modo mock local`);
      charge = {
        transactionId: `mock_${order.id}`,
        qrcode: code,
        qrCodeBase64: qrimg.toBase64(code),
      };
      usedGateway = 'mock';
    }

    if (!charge) {
      return fail(req, res, 502, 'Não foi possível gerar a cobrança PIX. Tente novamente.');
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
    if (usedGateway === 'nitropay' || usedGateway === 'bspay' || usedGateway === 'quantumpay') {
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

    // Fast-path: Se a ordem já está concluída, responde instantaneamente em 0ms sem checagens externas
    if (order && order.status === 'COMPLETED') {
      return sendJson(req, res, 200, {
        id: order.id,
        status: order.status,
        amount: order.amount,
        paidAt: order.paidAt,
        channel: order.channel || (order.isCloaked || order.gatewayAccount === 'secondary' ? 'cloaked' : 'standard'),
        isCloaked: !!(order.isCloaked || order.gatewayAccount === 'secondary'),
      });
    }

    /* Fallback para instâncias serverless (Vercel) via BSPay */
    if (!order && config.bspay.configured) {
      try {
        const tx = await bspay.findTransaction({ externalId: orderId, transactionId: orderId });
        if (tx && (tx.transaction_id || tx.external_id)) {
          const statusStr = String(tx.status || '').toLowerCase();
          const isPaid = bspay.PAID_STATUSES.includes(statusStr);
          const paidStatus = isPaid ? 'COMPLETED' : 'PENDING';
          order = store.createOrder({
            id: orderId,
            externalId: tx.external_id || orderId,
            transactionId: tx.transaction_id || orderId,
            status: paidStatus,
            amount: Number(tx.amount || 0),
            totalPrice: Number(tx.amount || 0),
            provider: 'bspay',
            channel: 'standard',
            paidAt: isPaid ? (tx.paid_at || new Date().toISOString()) : null,
            customer: {
              name: tx.payer?.name || '',
              document: tx.payer?.document || '',
              email: tx.payer?.email || '',
              phone: tx.payer?.phone || '',
            },
          });
          if (isPaid) {
            logOrder('completed', order, { source: 'bspay-fallback', payer: tx.payer });
          }
        }
      } catch (e) {
        /* Ordem não encontrada na BSPay */
      }
    }

    /* Fallback para instâncias serverless (Vercel) via QuantumPay */
    if (!order && config.quantumpay.configured) {
      try {
        const tx = await quantumpay.consultTransaction(orderId);
        if (tx && tx.id) {
          const statusStr = String(tx.status || '').toLowerCase();
          const isPaid = ['paid', 'pago', 'completed', 'approved'].includes(statusStr);
          const paidStatus = isPaid ? 'COMPLETED' : 'PENDING';
          order = store.createOrder({
            id: orderId,
            externalId: tx.externalId || orderId,
            transactionId: tx.id || orderId,
            status: paidStatus,
            amount: Number(tx.amountInCents ? tx.amountInCents / 100 : (tx.amount || 0)),
            totalPrice: Number(tx.amountInCents ? tx.amountInCents / 100 : (tx.amount || 0)),
            provider: 'quantumpay',
            channel: 'standard',
            paidAt: isPaid ? (tx.paidAt || new Date().toISOString()) : null,
            customer: {
              name: tx.customer?.name || '',
              document: tx.customer?.document || '',
              email: tx.customer?.email || '',
              phone: tx.customer?.phone || '',
            },
          });
          if (isPaid) {
            logOrder('completed', order, { source: 'quantumpay-fallback', payer: tx.customer });
          }
        }
      } catch (e) {
        /* Ordem não encontrada na QuantumPay */
      }
    }

    /* Fallback para Nitro Oculta (secundária) apenas se explicitamente habilitada */
    if (!order && config.nitropaySecondary?.enabled && config.nitropaySecondary?.configured) {
      try {
        const tx = await nitropay.consultTransaction(orderId, 'secondary');
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
            channel: 'cloaked',
            gatewayAccount: 'secondary',
            isCloaked: true,
            paidAt: isPaid ? (tx.paid_at || new Date().toISOString()) : null,
            customer: {
              name: tx.customer?.name || '',
              document: tx.customer?.document || '',
              email: tx.customer?.email || '',
              phone: tx.customer?.phone || '',
            },
          });
        }
      } catch (e) {
        /* Não encontrada na NitroPay secundária */
      }
    }

    if (!order) return fail(req, res, 404, 'Ordem não encontrada');

    store.expireStale();
    let fresh = store.getOrder(order.id) || order;
    if (fresh.status === 'COMPLETED') {
      return sendJson(req, res, 200, {
        id: fresh.id,
        status: fresh.status,
        amount: fresh.amount,
        paidAt: fresh.paidAt,
        channel: fresh.channel || (fresh.isCloaked || fresh.gatewayAccount === 'secondary' ? 'cloaked' : 'standard'),
        isCloaked: !!(fresh.isCloaked || fresh.gatewayAccount === 'secondary'),
      });
    }

    const ageMs = Date.now() - new Date(fresh.createdAt || Date.now()).getTime();

    /* Reconciliação BSPay: pendente + throttled a cada 3s */
    if (
      fresh.status === 'PENDING'
      && fresh.provider === 'bspay'
      && config.bspay.configured
      && (fresh.transactionId || fresh.id || fresh.externalId)
      && (ageMs > 3000 || !fresh.createdAt)
      && Date.now() - (fresh.lastReconcileAt || 0) > 3000
    ) {
      store.updateOrder(fresh.id, { lastReconcileAt: Date.now() });
      try {
        const check = await bspay.isChargePaid({
          externalId: fresh.externalId || fresh.id,
          transactionId: fresh.transactionId || fresh.id,
        });
        if (check.paid) {
          store.completeOrder(fresh.id, 'bspay-reconcile', { status: check.status });
          fresh = store.getOrder(fresh.id) || fresh;
          fresh.status = 'COMPLETED';
          fresh.paidAt = fresh.paidAt || check.tx?.paid_at || new Date().toISOString();
          logOrder('completed', fresh, { source: 'bspay-reconcile', payer: check.tx?.payer });
          const v = fresh.visitorId ? store.getVisitor(fresh.visitorId) : null;
          utmify.notifyPixPaid(fresh, v).catch(() => {});
        }
      } catch (e) {
        console.warn('[bspay-reconcile] falha:', e.message);
      }
      fresh = store.getOrder(order.id) || fresh;
    }

    /* Reconciliação QuantumPay: pendente + throttled a cada 3s */
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

    /* Reconciliação NitroPay */
    if (
      fresh.status === 'PENDING'
      && fresh.provider === 'nitropay'
      && (config.nitropay?.configured || config.nitropaySecondary?.configured)
      && (fresh.transactionId || fresh.id)
      && (ageMs > 3000 || !fresh.createdAt)
      && Date.now() - (fresh.lastReconcileAt || 0) > 3000
    ) {
      store.updateOrder(fresh.id, { lastReconcileAt: Date.now() });
      try {
        const check = await nitropay.isChargePaid({
          transactionId: fresh.transactionId || fresh.id,
          account: 'primary',
        });
        if (check.paid) {
          store.completeOrder(fresh.id, 'nitropay-reconcile', { status: check.status });
          fresh = store.getOrder(fresh.id) || fresh;
          fresh.status = 'COMPLETED';
          fresh.paidAt = fresh.paidAt || check.tx?.paid_at || new Date().toISOString();
          logOrder('completed', fresh, { source: 'nitropay-reconcile', payer: check.tx?.customer });
          const v = fresh.visitorId ? store.getVisitor(fresh.visitorId) : null;
          utmify.notifyPixPaid(fresh, v).catch(() => {});
        }
      } catch (e) {
        console.warn('[nitropay-reconcile] falha:', e.message);
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

  /* ------------------------------ webhook bspay ------------------------------ */
  if (pathname === '/api/webhooks/bspay' && method === 'POST') {
    const raw = await readRaw(req);
    let payload = {};
    try { payload = JSON.parse(raw.toString('utf8')); } catch { /* corpo não-JSON */ }

    const rawStr = raw.toString('utf8');
    const signature = req.headers['x-signature'] || '';
    const timestamp = req.headers['x-timestamp'] || '';
    let verified = false;

    if (config.bspay.webhookSecret) {
      if (!signature) {
        console.warn('[webhook-bspay] Falta cabeçalho X-Signature');
        return fail(req, res, 401, 'Falta assinatura');
      }
      if (!bspay.webhookTimestampOk(timestamp)) {
        console.warn('[webhook-bspay] Timestamp fora da janela tolerada');
        return fail(req, res, 401, 'Timestamp inválido');
      }
      if (!bspay.verifyWebhook(rawStr, signature)) {
        console.warn('[webhook-bspay] Assinatura X-Signature inválida');
        return fail(req, res, 401, 'Assinatura inválida');
      }
      verified = true;
    }

    const event = String(payload.event || payload.type || '').toLowerCase();
    const data = payload.data || payload;
    const txId = data.transaction_id || data.id || payload.transaction_id || payload.id;
    const externalId = data.external_id || data.externalId || payload.external_id || payload.externalId;
    const status = String(data.status || payload.status || '').toLowerCase();

    let order = (externalId && store.findByExternalId(externalId)) || (txId && store.findByTransactionId(txId));

    if (!order && externalId) {
      order = store.createOrder({
        id: externalId,
        externalId,
        transactionId: txId || null,
        status: 'PENDING',
        amount: Number(data.amount || payload.amount || 0),
        totalPrice: Number(data.amount || payload.amount || 0),
        provider: 'bspay',
        channel: 'standard',
        customer: {
          name: data.payer?.name || '',
          document: data.payer?.document || '',
          email: data.payer?.email || '',
          phone: data.payer?.phone || '',
        },
      });
    }

    const isPaid = event.includes('paid') || event.includes('confirmed') || bspay.PAID_STATUSES.includes(status);

    if (order && isPaid) {
      if (!verified && !config.bspay.webhookSecret) {
        const confirmed = await confirmOnGateway(order, txId);
        if (!confirmed) {
          console.warn('[webhook-bspay] Pagamento não confirmado na consulta direta à BSPay');
          return sendJson(req, res, 200, { received: true, verified: false, confirmed: false });
        }
      }

      store.completeOrder(order.id, verified ? 'bspay-webhook' : 'bspay-webhook-direct', payload);
      const updated = store.getOrder(order.id) || order;
      updated.status = 'COMPLETED';
      logOrder('completed', updated, { source: 'bspay-webhook', payer: data.payer });
      console.log(`[webhook-bspay] Pagamento confirmado para ordem ${order.id} (R$ ${order.amount})`);
      const v = updated.visitorId ? store.getVisitor(updated.visitorId) : null;
      utmify.notifyPixPaid(updated, v).catch(() => {});
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

    const signature = req.headers['quantum-pay-signature'] || req.headers['x-signature'] || '';
    const verified = quantumpay.verifyWebhook(raw.toString('utf8'), signature);

    if (signature && !verified) {
      console.warn('[quantumpay-webhook] Assinatura Quantum-Pay-Signature inválida:', signature);
      return fail(req, res, 401, 'Assinatura inválida');
    }

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

  /* ---------------------------- webhook nitropay ---------------------------- */
  if ((pathname === '/api/webhooks/nitropay' || pathname === '/api/webhooks/nitro') && method === 'POST') {
    const raw = await readRaw(req);
    let payload = {};
    try { payload = JSON.parse(raw.toString('utf8')); } catch { /* corpo não-JSON */ }

    const data = payload.data || payload;
    const txId = data.id || payload.id;
    const externalId = data.metadata?.order_id || data.external_ref || payload.external_ref || payload.metadata?.order_id;
    const status = String(data.status || payload.status || '').toLowerCase();

    let order = (externalId && store.findByExternalId(externalId))
      || (externalId && store.getOrder(externalId))
      || (txId && store.findByTransactionId(txId));

    if (!order && externalId) {
      order = store.createOrder({
        id: externalId,
        externalId,
        transactionId: txId || null,
        status: 'PENDING',
        amount: Number(data.amount || payload.amount || 0),
        totalPrice: Number(data.amount || payload.amount || 0),
        provider: 'nitropay',
        channel: 'standard',
        customer: {
          name: data.customer?.name || '',
          document: data.customer?.document || '',
          email: data.customer?.email || '',
          phone: data.customer?.phone || '',
        },
      });
    }

    const isPaid = ['paid', 'pago', 'completed', 'approved', 'confirmado'].includes(status)
      || String(payload.event || '').toLowerCase().includes('paid');

    if (order && isPaid) {
      store.completeOrder(order.id, 'nitropay-webhook', payload);
      const updated = store.getOrder(order.id) || order;
      updated.status = 'COMPLETED';
      logOrder('completed', updated, { source: 'nitropay-webhook', payer: data.customer });
      console.log(`[webhook-nitropay] Pagamento confirmado para ordem ${order.id} (R$ ${order.amount})`);
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
  if (order.provider === 'bspay' || config.bspay?.configured) {
    try {
      const check = await bspay.isChargePaid({
        externalId: order.externalId,
        transactionId: order.transactionId || txId,
      });
      if (check.paid) return true;
    } catch (e) {
      console.warn('[webhook] não foi possível confirmar na BSPay:', e.message);
    }
  }
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
  if (order.provider === 'nitropay' && config.nitropaySecondary?.configured) {
    try {
      const check = await nitropay.isChargePaid({
        externalId: order.externalId,
        transactionId: order.transactionId || txId,
        account: 'secondary',
      });
      return !!check.paid;
    } catch (e) {
      console.warn('[webhook] não foi possível confirmar na NitroPay:', e.message);
    }
  }
  return false;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function makeExternalId() {
  let r = '';
  for (let i = 0; i < 8; i++) r += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `valore-${Date.now().toString(36)}${r}`;
}

/* ------------------------------ arquivos estáticos ------------------------- */

const staticCache = new Map(); // file -> { data, headers }

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Acesso negado', req);

  const exists = fs.existsSync(file) && fs.statSync(file).isFile();
  if (!exists) {
    /* SPA: rota sem extensão cai no index (roteador client-side). */
    if (path.extname(rel)) return sendText(res, 404, 'Arquivo não encontrado', req);
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), req, url.pathname);
  }
  return serveFile(res, file, req, url.pathname);
}

function serveFile(res, file, req, requestPath) {
  const ext = path.extname(file).toLowerCase();
  const isHtml = ext === '.html';
  const isSw = path.basename(file) === 'sw.js';
  /* Assets têm hash no nome -> cache longo. HTML e sw.js sempre revalidados. */
  const immutable = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(path.basename(file));

  // Serve diretamente da memória RAM se já lido (latência < 1ms)
  if (!isHtml && !isSw) {
    const cached = staticCache.get(file);
    if (cached) {
      res.writeHead(200, cached.headers);
      return res.end(cached.data);
    }
  }

  try {
    let data = fs.readFileSync(file);
    if (isHtml) {
      const htmlStr = data.toString('utf8');
      const injected = seo.injectSeoIntoHtml(htmlStr, requestPath || '/');
      data = Buffer.from(injected, 'utf8');
    }
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': (isHtml || isSw) ? 'no-cache, no-store, must-revalidate' : (immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=86400'),
      'Content-Length': data.length,
      ...baseHeaders(req),
    };
    if (isSw) {
      headers['Service-Worker-Allowed'] = '/';
    }
    if (!isHtml && !isSw) {
      staticCache.set(file, { data, headers });
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
    console.log(`  BSPay       ${config.bspay.configured ? `configurada (100% ativo)` : 'NÃO configurada'}`);
    console.log(`  NitroOculta ${config.nitropaySecondary.enabled ? 'ATIVA (cloaked)' : 'PAUSADA (indetectável)'}`);
    console.log(`  UTMify      ${config.utmify.configured ? 'integrada (apenas BSPAY)' : 'desativada'}`);
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
