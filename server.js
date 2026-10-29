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
// Rastreamento de eventos Meta Pixel disparados (em memória, reseta no restart)
const metaEventLog = {
  counts: {}, // { pixelId: { PageView: N, Lead: N, ... } }
  recent: [], // últimos 50 eventos: [{ pixelId, event, timestamp, source }]
};
function trackMetaEvent(pixelId, eventName, source = 'system') {
  if (!pixelId || !eventName) return;
  metaEventLog.counts[pixelId] = metaEventLog.counts[pixelId] || {};
  metaEventLog.counts[pixelId][eventName] = (metaEventLog.counts[pixelId][eventName] || 0) + 1;
  metaEventLog.recent.unshift({
    pixelId,
    event: eventName,
    timestamp: new Date().toISOString(),
    source,
  });
  if (metaEventLog.recent.length > 50) metaEventLog.recent.pop();
}
const nitropay = require('./lib/nitropay');
const pushService = require('./lib/push');
const recovery = require('./lib/recovery');
const pushAdmin = require('./lib/push-admin');
const utmify = require('./lib/utmify');
const ga4 = require('./lib/ga4');
const seo = require('./lib/seo');
const admin = require('./lib/admin');
const supabase = require('./lib/supabase');

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
      // Rastrear evento Purchase para todos os pixels ativos
      const activePixels = config.meta.pixelIds || [];
      activePixels.forEach(px => trackMetaEvent(px, 'Purchase', 'capi'));
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
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() || 'https';
  if (!host || /^(localhost|127\.0\.0\.1)/i.test(host)) {
    return `https://www.valorebrasil.app/api/webhooks/${gateway}`;
  }
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
      admin.recordFailedLogin(ip, req.headers['user-agent']);
      admin.addAudit('login_fail', `Falha de login${username ? ` (${username})` : ''}: Senha ou usuário incorreto`, ip);
      return fail(req, res, 401, 'Senha ou usuário incorreto');
    }

    if (authResult.user?.totpEnabled) {
      const code = String(body.code || '').trim();
      if (!code) {
        return sendJson(req, res, 401, {
          error: 'Código do autenticador obrigatório para este usuário',
          totpRequired: true,
        });
      }
      const isCodeValid = admin.verifyUserTotp(authResult.user, code);
      if (!isCodeValid) {
        admin.recordFailedLogin(ip, req.headers['user-agent']);
        admin.addAudit('login_fail', `Código 2FA incorreto para ${authResult.user.username}`, ip);
        return sendJson(req, res, 401, {
          error: 'Código do autenticador incorreto ou expirado',
          totpRequired: true,
        });
      }
    }

    admin.recordSuccessfulLogin(ip);
    const { token } = admin.createSession(req, ip, authResult.user);
    admin.addAudit('login_ok', `Login efetuado: ${authResult.user?.name || 'Administrador'}`, ip);
    res.setHeader('Set-Cookie', `adm_token=${token}; Path=/; SameSite=Lax; Max-Age=2592000`);
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
    const supaAudit = await supabase.listAudit(limit);
    if (supaAudit && supaAudit.length > 0) {
      return sendJson(req, res, 200, supaAudit);
    }
    return sendJson(req, res, 200, admin.getAudit(limit));
  }

  if (pathname === '/api/admin/ip-blocks' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    await admin.loadIpBlocksFromSupabase();
    return sendJson(req, res, 200, admin.listIpBlocks());
  }

  if (pathname === '/api/admin/ip-blocks' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    admin.blockIp(body.ip, body.reason);
    await admin.syncIpBlocksToSupabase();
    admin.addAudit('ip_blocked', `IP bloqueado: ${body.ip}`, ip);
    return sendJson(req, res, 200, { ok: true });
  }

  const unblockMatch = pathname.match(/^\/api\/admin\/ip-blocks\/(.+)$/);
  if (unblockMatch && method === 'DELETE') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const targetIp = decodeURIComponent(unblockMatch[1]);
    admin.unblockIp(targetIp);
    await admin.syncIpBlocksToSupabase();
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
    try {
      await store.hydrateFromSupabase();
      await pushService.hydrateFromSupabase();
    } catch {}
    store.syncOrdersToVisitors();
    const s = store.stats();
    const subs = pushService.getSubscriptions().filter((s) => s.endpoint && !s.endpoint.includes('fake_endpoint_123'));
    if (pushAdmin && typeof pushAdmin.hydrateFromSupabase === 'function') {
      await pushAdmin.hydrateFromSupabase().catch(() => {});
    }
    const execs = (pushAdmin && typeof pushAdmin.getExecutions === 'function')
      ? pushAdmin.getExecutions({ date: requestedDate })
      : ((pushService && typeof pushService.getExecutions === 'function') ? pushService.getExecutions() : []);

    const allOrders = Object.values(store.load().orders || {});
    const allVisitors = Object.values(store.load().visitors || {});
    const dayOrders = allOrders.filter(o => (o.createdAt || '').slice(0, 10) === requestedDate);
    const dayPaidOrders = allOrders.filter(o => (o.paidAt || o.createdAt || '').slice(0, 10) === requestedDate && o.status === 'COMPLETED');
    const dayVisitors = allVisitors.filter(v => (v.createdAt || '').slice(0, 10) === requestedDate);
    const dayRevenue = Number(dayPaidOrders.reduce((acc, o) => acc + (Number(o.amount) || 0), 0).toFixed(2));

    return sendJson(req, res, 200, {
      day: {
        registrations: dayVisitors.length || s.visitors || 0,
        newPushSubs: subs.length,
        pushSales: dayPaidOrders.length || s.paid || 0,
        pushRevenue: dayRevenue || s.revenue || 0,
        notificationsSent: execs.reduce((acc, e) => acc + (e.sentCount || e.sent || e.counts?.sent || 0), 0),
        executions: execs.length,
        activePushSubs: subs.length,

        // Métricas gerais da oferta
        offerTotalRevenue: s.totalRevenue,
        offerCompletionRate: s.completionRate,
        offerPixGenerated: s.pixGenerated,
        offerPixPaid: s.pixPaid,
        offerCheckoutAbandons: s.checkoutAbandons,
        offerFunnelAbandons: s.funnelAbandons,
        offerMidFunnelAbandonRate: s.midFunnelAbandonRate,
        offerCheckoutAbandonRate: s.checkoutAbandonRate,
        offerAbandonRanking: s.abandonRanking || [],
      },
      offer: {
        totalRevenue: s.totalRevenue,
        completionRate: s.completionRate,
        pixGenerated: s.pixGenerated,
        pixPaid: s.pixPaid,
        checkoutAbandons: s.checkoutAbandons,
        funnelAbandons: s.funnelAbandons,
        midFunnelAbandonRate: s.midFunnelAbandonRate,
        checkoutAbandonRate: s.checkoutAbandonRate,
        abandonRanking: s.abandonRanking || [],
      },
      abandonRanking: s.abandonRanking || [],
      series: [
        {
          date: requestedDate,
          registrations: dayVisitors.length || s.visitors || 0,
          pushSubs: subs.length,
          pushRevenue: dayRevenue || s.revenue || 0,
        },
      ],
    });
  }

  if (pathname === '/api/integrations' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');

    // Sincroniza com Supabase para garantir que todas as instâncias tenham os dados
    try {
      await store.loadIntegrationsFromSupabase();
    } catch {}

    const stored = store.getIntegrations() || {};
    const settings = store.getSettings() || {};
    const deletedIds = (store.getDeletedIntegrations() || []).map(x => String(x).toLowerCase());
    const activeGatewayId = String(settings.activeGatewayId || 'nitropay').toLowerCase();

    const builtIns = [
      {
        id: 'nitropay',
        name: 'NitroPay',
        category: 'Pagamento',
        group: 'gateway',
        provider: 'nitropay',
        description: 'Gateway de pagamentos Pix NitroPay (chave pública e privada).',
        isCustom: false,
        isActiveCheckout: (activeGatewayId === 'nitropay'),
        webhookActive: stored.nitropay?.webhookActive !== false,
        webhookUrl: postbackFromRequest(req, 'nitropay'),
        lastWebhookSync: stored.nitropay?.lastWebhookSync || null,
        config: {
          publicKey: stored.nitropay?.publicKey || config.nitropaySecondary?.publicKey || config.nitropay?.publicKey || '',
          secretKey: stored.nitropay?.secretKey || config.nitropaySecondary?.secretKey || config.nitropay?.secretKey || '',
        },
      },
      {
        id: 'bspay',
        name: 'BSPay',
        category: 'Pagamento',
        group: 'gateway',
        provider: 'bspay',
        description: 'Gateway Pix BSPay com confirmação automática.',
        isCustom: false,
        isActiveCheckout: (activeGatewayId === 'bspay'),
        webhookActive: stored.bspay?.webhookActive !== false,
        webhookUrl: postbackFromRequest(req, 'bspay'),
        lastWebhookSync: stored.bspay?.lastWebhookSync || null,
        config: {
          clientId: stored.bspay?.clientId || config.bspay?.clientId || '',
          clientSecret: stored.bspay?.clientSecret || config.bspay?.clientSecret || '',
        },
      },
      {
        id: 'quantumpay',
        name: 'QuantumPay',
        category: 'Pagamento',
        group: 'gateway',
        provider: 'quantumpay',
        description: 'Gateway Pix QuantumPay para geração e baixa de cobranças.',
        isCustom: false,
        isActiveCheckout: (activeGatewayId === 'quantumpay'),
        webhookActive: stored.quantumpay?.webhookActive !== false,
        webhookUrl: postbackFromRequest(req, 'quantumpay'),
        lastWebhookSync: stored.quantumpay?.lastWebhookSync || null,
        config: {
          accountId: stored.quantumpay?.accountId || config.quantumpay?.accountId || '',
          apiKey: stored.quantumpay?.apiKey || config.quantumpay?.apiKey || '',
          apiSecret: stored.quantumpay?.apiSecret || config.quantumpay?.apiSecret || '',
        },
      },
      {
        id: 'api-cpf',
        name: 'API de CPF',
        category: 'Dados',
        group: 'service',
        description: 'Consulta de CPF na etapa de simulação para preencher os dados do usuário.',
        isCustom: false,
        enabled: stored['api-cpf']?.enabled !== false && config.cpf?.enabled !== false,
        config: {
          baseUrl: stored['api-cpf']?.baseUrl || config.cpf?.base || '',
          token: stored['api-cpf']?.token || config.cpf?.token || '',
          enabled: stored['api-cpf']?.enabled !== false && config.cpf?.enabled !== false,
        },
      },
      {
        id: 'utmify',
        name: 'Utmify',
        category: 'Rastreamento',
        group: 'service',
        description: 'Envio das conversões do fluxo para o rastreamento de campanhas.',
        isCustom: false,
        config: {
          token: stored.utmify?.token || config.utmify?.apiToken || '',
        },
      },
      {
        id: 'meta-pixel',
        name: 'Meta Pixel',
        category: 'Rastreamento',
        group: 'service',
        description: 'Pixel do Gerenciador de Anúncios do Facebook para rastreamento de conversões e eventos do funil com persistência no Supabase.',
        isCustom: false,
        enabled: stored['meta-pixel']?.enabled !== false && config.meta?.configured !== false,
        config: {
          enabled: stored['meta-pixel']?.enabled !== false,
          pixels: Array.isArray(stored['meta-pixel']?.pixels) ? stored['meta-pixel'].pixels : [
            {
              id: 'px-2153492335604301',
              pixelId: '2153492335604301',
              name: 'Pixel Principal',
              token: config.meta.pixelTokens?.['2153492335604301'] || '',
              active: true,
              createdAt: new Date().toISOString()
            }
          ],
        },
      },
    ];

    const result = builtIns.filter(item => !deletedIds.includes(item.id.toLowerCase()));

    // Gateways customizados adicionados pelo usuário
    for (const [key, val] of Object.entries(stored)) {
      if (['nitropay', 'bspay', 'quantumpay', 'api-cpf', 'utmify', 'meta-pixel'].includes(key)) continue;
      if (deletedIds.includes(key.toLowerCase())) continue;
      if (val && typeof val === 'object') {
        const prov = val.provider || 'nitropay';
        result.push({
          id: key,
          name: val.name || `Gateway ${key}`,
          category: 'Pagamento',
          group: 'gateway',
          provider: prov,
          description: val.description || `Gateway Pix ${prov.toUpperCase()} customizado.`,
          isCustom: true,
          isActiveCheckout: (activeGatewayId === key),
          webhookActive: val.webhookActive !== false,
          webhookUrl: postbackFromRequest(req, key),
          lastWebhookSync: val.lastWebhookSync || null,
          config: val.config || val,
        });
      }
    }

    return sendJson(req, res, 200, result);
  }

  if (pathname === '/api/integrations' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    const provider = String(body.provider || 'nitropay').toLowerCase();
    const rawName = String(body.name || `Gateway ${provider}`).trim();
    const cleanId = String(body.id || rawName).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `gw-${Date.now()}`;
    const id = ['nitropay', 'bspay', 'quantumpay', 'api-cpf', 'utmify', 'meta-pixel'].includes(cleanId) ? `${cleanId}-${Date.now().toString(36)}` : cleanId;

    const gatewayConfig = {
      ...(body.config || {}),
      name: rawName,
      provider,
      isCustom: true,
      webhookActive: body.webhookActive !== false,
      webhookUrl: postbackFromRequest(req, id),
      createdAt: new Date().toISOString(),
    };

    const saved = await store.setIntegration(id, gatewayConfig);
    admin.addAudit('integration_add', `Novo gateway ${rawName} (${id}) cadastrado`, ip);
    return sendJson(req, res, 201, {
      ok: true,
      id,
      name: rawName,
      provider,
      config: saved,
      webhookUrl: gatewayConfig.webhookUrl,
      webhookActive: gatewayConfig.webhookActive,
    });
  }

  const webhookSyncMatch = pathname.match(/^\/api\/integrations\/([\w-]+)\/webhook-sync$/);
  if (webhookSyncMatch && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const integrationId = webhookSyncMatch[1];
    const body = await readJson(req);
    const webhookActive = body.webhookActive !== false;
    const webhookUrl = postbackFromRequest(req, integrationId);

    const current = store.getIntegrations()[integrationId] || {};
    const updated = await store.setIntegration(integrationId, {
      ...current,
      webhookActive,
      webhookUrl,
      lastWebhookSync: new Date().toISOString(),
    });

    admin.addAudit('webhook_sync', `Webhook de ${integrationId} sincronizado (${webhookActive ? 'Ativo' : 'Desativado'})`, ip);
    return sendJson(req, res, 200, {
      ok: true,
      id: integrationId,
      webhookUrl,
      webhookActive,
      syncedAt: new Date().toISOString(),
      message: 'Webhook sincronizado com sucesso no Supabase e pronto para receber notificações Pix.',
    });
  }

  const cpfToggleMatch = pathname === '/api/integrations/api-cpf/toggle';
  if (cpfToggleMatch && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    const current = store.getIntegrations()['api-cpf'] || {};
    const currentEnabled = current.enabled !== false && config.cpf.enabled !== false;
    const nextEnabled = body.enabled !== undefined ? Boolean(body.enabled) : !currentEnabled;
    const updated = await store.setIntegration('api-cpf', {
      baseUrl: current.baseUrl || config.cpf.base,
      token: current.token || config.cpf.token,
      ...current,
      enabled: nextEnabled,
    });
    config.cpf.enabled = nextEnabled;
    config.cpf.configured = Boolean(config.cpf.token && nextEnabled);
    admin.addAudit('integration_change', `API de CPF ${nextEnabled ? 'ativada' : 'desativada'}`, ip);
    return sendJson(req, res, 200, {
      ok: true,
      id: 'api-cpf',
      enabled: nextEnabled,
      configured: config.cpf.configured,
      message: nextEnabled ? 'API de CPF ativada com sucesso. Consultas automáticas no funil habilitadas.' : 'API de CPF desativada com sucesso. Modo de preenchimento manual ativo.',
    });
  }

  const integrationMatch = pathname.match(/^\/api\/integrations\/([\w-]+)$/);
  if (integrationMatch && method === 'PUT') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const integrationId = integrationMatch[1];
    const body = await readJson(req);
    const current = store.getIntegrations()[integrationId] || {};
    const patchData = body.config || body.data || body;
    const newCfg = { ...current, ...patchData };
    if (body.enabled !== undefined) newCfg.enabled = body.enabled !== false;
    if (patchData.enabled !== undefined) newCfg.enabled = patchData.enabled !== false;
    if (body.webhookActive !== undefined) newCfg.webhookActive = body.webhookActive;
    if (body.name) newCfg.name = body.name;
    const saved = await store.setIntegration(integrationId, newCfg);
    admin.addAudit('integration_change', `Configurações de ${integrationId} salvas`, ip);
    return sendJson(req, res, 200, { ok: true, id: integrationId, config: saved });
  }

  if (integrationMatch && method === 'DELETE') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const integrationId = integrationMatch[1];
    await store.removeIntegration(integrationId);
    const currentSettings = store.getSettings() || {};
    if (String(currentSettings.activeGatewayId || '').toLowerCase() === integrationId.toLowerCase()) {
      await store.setSettings({ activeGatewayId: 'nitropay' });
    }
    admin.addAudit('integration_delete', `Gateway/integração ${integrationId} removida`, ip);
    return sendJson(req, res, 200, { ok: true, id: integrationId });
  }

  if (pathname === '/api/cpf-test' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    const rawCpf = String(body.cpf || '').replace(/\D/g, '');
    if (!rawCpf || rawCpf.length !== 11) return fail(req, res, 400, 'CPF inválido');

    // Sincroniza credenciais mais recentes do Supabase se necessário
    try {
      await store.loadIntegrationsFromSupabase();
    } catch {}

    const stored = store.getIntegrations()['api-cpf'] || {};
    if (stored.baseUrl && String(stored.baseUrl).trim()) config.cpf.base = String(stored.baseUrl).trim();
    if (stored.token && String(stored.token).trim()) config.cpf.token = String(stored.token).trim();
    if (stored.enabled !== undefined) config.cpf.enabled = stored.enabled !== false;
    const isConfigured = Boolean(config.cpf.token && String(config.cpf.token).trim());

    const t0 = Date.now();
    try {
      const person = await cpf.lookup(rawCpf);
      const elapsedMs = Date.now() - t0;
      if (!person || !person.nome) {
        return sendJson(req, res, 200, {
          configured: isConfigured,
          ok: false,
          status: 404,
          elapsedMs,
          error: 'CPF não encontrado na base de dados',
        });
      }
      return sendJson(req, res, 200, {
        configured: isConfigured,
        ok: true,
        status: 200,
        elapsedMs,
        data: {
          cpf: person.cpfMasked || person.cpf,
          name: person.nome,
          birthDate: person.nascimento,
          motherName: person.nomeMae,
          fatherName: person.nomePai || '',
          gender: person.genero === 'M' ? 'Masculino' : person.genero === 'F' ? 'Feminino' : person.genero || '',
          rg: person.rg || '',
          voterId: person.tituloEleitor || '',
          maritalStatus: person.estadoCivil || '',
          cbo: person.cbo || '',
          income: person.renda || '',
          statusReceita: person.statusReceita || 'Regular',
          deceased: person.obito ? 'Consta Óbito' : 'Não',
          phone: person.celular || '',
          phones: person.telefones || (person.celular ? [person.celular] : []),
          email: person.email || '',
          emails: person.emails || (person.email ? [person.email] : []),
          address: person.endereco || {},
          raw: person._raw || {},
        },
      });
    } catch (err) {
      return sendJson(req, res, 200, {
        configured: isConfigured,
        ok: false,
        status: err.status || 500,
        elapsedMs: Date.now() - t0,
        error: err.message || 'Falha ao consultar CPF na API',
      });
    }
  }

  if (pathname === '/api/utmify-test' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    const customToken = body.token || body.config?.token;
    const result = await utmify.testConnection(customToken);
    return sendJson(req, res, 200, result);
  }

  // ------------------------- META PIXEL & CAPI ENDPOINTS -------------------------
  if (pathname === '/api/meta-pixels' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    try {
      await store.loadIntegrationsFromSupabase();
    } catch {}
    const stored = store.getIntegrations()['meta-pixel'] || {};
    const pixels = Array.isArray(stored.pixels) ? stored.pixels : [];
    return sendJson(req, res, 200, {
      ok: true,
      enabled: stored.enabled !== false,
      configured: config.meta.configured,
      pixels,
    });
  }

  if (pathname === '/api/meta-pixels' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);

    // Suporte a extração inteligente a partir de snippet de código Meta Pixel
    let extractedPixelId = '';
    const rawCode = String(body.pixelCode || body.code || '').trim();
    if (rawCode) {
      const matchInit = rawCode.match(/fbq\(\s*['"]init['"]\s*,\s*['"](\d+)['"]\s*\)/i);
      const matchId = rawCode.match(/[?&]id=(\d+)/i) || rawCode.match(/['"]?id['"]?\s*:\s*['"]?(\d+)['"]?/i);
      const matchDigits = rawCode.match(/\b(\d{14,17})\b/);
      if (matchInit && matchInit[1]) extractedPixelId = matchInit[1];
      else if (matchId && matchId[1]) extractedPixelId = matchId[1];
      else if (matchDigits && matchDigits[1]) extractedPixelId = matchDigits[1];
    }

    const pixelId = String(body.pixelId || extractedPixelId || '').replace(/\D/g, '').trim();
    if (!pixelId) {
      return fail(req, res, 400, 'Não foi possível identificar o ID do Pixel. Cole o Meta Pixel Code completo ou informe o Pixel ID.');
    }

    const pixelToken = String(body.token || body.accessToken || '').trim();
    const pixelName = String(body.name || `Pixel ${pixelId}`).trim();

    try {
      await store.loadIntegrationsFromSupabase();
    } catch {}

    const current = store.getIntegrations()['meta-pixel'] || {};
    const pixels = Array.isArray(current.pixels) ? [...current.pixels] : [];

    const existingIndex = pixels.findIndex(p => String(p.pixelId) === pixelId);
    const pixelEntry = {
      id: existingIndex >= 0 ? pixels[existingIndex].id : `px-${pixelId}`,
      pixelId,
      name: pixelName,
      token: pixelToken || (existingIndex >= 0 ? pixels[existingIndex].token : ''),
      code: rawCode || (existingIndex >= 0 ? pixels[existingIndex].code : ''),
      active: body.active !== undefined ? Boolean(body.active) : true,
      createdAt: existingIndex >= 0 ? pixels[existingIndex].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      pixels[existingIndex] = pixelEntry;
    } else {
      pixels.push(pixelEntry);
    }

    const updatedConfig = {
      ...current,
      enabled: current.enabled !== false,
      pixels,
    };

    await store.setIntegration('meta-pixel', updatedConfig);
    admin.addAudit('integration_change', `Meta Pixel ${pixelId} salvo via painel`, ip);

    return sendJson(req, res, 200, {
      ok: true,
      message: 'Meta Pixel salvo e sincronizado com sucesso no Supabase!',
      pixel: pixelEntry,
      pixels,
    });
  }

  const pixelDeleteMatch = pathname.match(/^\/api\/meta-pixels\/([\w-]+)$/);
  if (pixelDeleteMatch && method === 'DELETE') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const targetId = pixelDeleteMatch[1];

    try {
      await store.loadIntegrationsFromSupabase();
    } catch {}

    const current = store.getIntegrations()['meta-pixel'] || {};
    const pixels = Array.isArray(current.pixels) ? current.pixels : [];
    const remaining = pixels.filter(p => p.id !== targetId && String(p.pixelId) !== targetId);

    const updatedConfig = {
      ...current,
      pixels: remaining,
    };

    await store.setIntegration('meta-pixel', updatedConfig);
    admin.addAudit('integration_delete', `Meta Pixel ${targetId} removido via painel`, ip);

    return sendJson(req, res, 200, {
      ok: true,
      message: 'Pixel removido com sucesso!',
      pixels: remaining,
    });
  }

  const pixelToggleMatch = pathname.match(/^\/api\/meta-pixels\/([\w-]+)\/toggle$/);
  if (pixelToggleMatch && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const targetId = pixelToggleMatch[1];
    const body = await readJson(req);

    try {
      await store.loadIntegrationsFromSupabase();
    } catch {}

    const current = store.getIntegrations()['meta-pixel'] || {};
    const pixels = Array.isArray(current.pixels) ? [...current.pixels] : [];
    const idx = pixels.findIndex(p => p.id === targetId || String(p.pixelId) === targetId);
    if (idx === -1) return fail(req, res, 404, 'Pixel não encontrado');

    const nextActive = body.active !== undefined ? Boolean(body.active) : !pixels[idx].active;
    pixels[idx] = { ...pixels[idx], active: nextActive, updatedAt: new Date().toISOString() };

    const updatedConfig = {
      ...current,
      pixels,
    };

    await store.setIntegration('meta-pixel', updatedConfig);
    admin.addAudit('integration_change', `Meta Pixel ${targetId} ${nextActive ? 'ativado' : 'desativado'}`, ip);

    return sendJson(req, res, 200, {
      ok: true,
      pixelId: targetId,
      active: nextActive,
      pixels,
    });
  }

  if (pathname === '/api/meta-events' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    return sendJson(req, res, 200, {
      ok: true,
      counts: metaEventLog.counts,
      recent: metaEventLog.recent,
    });
  }

  if (pathname === '/api/meta-test' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    const pixelId = String(body.pixelId || '').replace(/\D/g, '').trim();
    const metaToken = String(body.token || '').trim();

    if (!pixelId) return fail(req, res, 400, 'Pixel ID obrigatório para teste');
    if (!metaToken) return fail(req, res, 400, 'Token de Acesso obrigatório para teste do CAPI');

    const t0 = Date.now();
    try {
      const url = `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${metaToken}`;
      const payload = {
        data: [
          {
            event_name: 'PageView',
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'website',
            user_data: {
              client_ip_address: ip || '127.0.0.1',
              client_user_agent: req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            },
            custom_data: {
              test_event: true,
              source: 'Valore Admin Dashboard Test',
            },
          },
        ],
      };

      const metaRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await metaRes.json();
      const elapsedMs = Date.now() - t0;

      if (metaRes.ok) {
        return sendJson(req, res, 200, {
          ok: true,
          status: metaRes.status,
          elapsedMs,
          data: json,
          message: `Evento de teste recebido com sucesso pela Meta! (${json.events_received || 1} evento recebido, trace_id: ${json.fbtrace_id || 'ok'})`,
        });
      } else {
        return sendJson(req, res, 200, {
          ok: false,
          status: metaRes.status,
          elapsedMs,
          error: json?.error?.message || 'Falha ao validar com a Graph API da Meta',
          data: json,
        });
      }
    } catch (err) {
      return sendJson(req, res, 200, {
        ok: false,
        status: 500,
        elapsedMs: Date.now() - t0,
        error: `Erro ao comunicar com a Meta: ${err.message}`,
      });
    }
  }

  if (pathname === '/api/gateway-test' && method === 'POST') {
    const t0 = Date.now();
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');

    const body = await readJson(req);
    const chosenGateway = String(body.gatewayId || body.gateway || store.getNextGateway()).toLowerCase();
    const stored = store.getIntegrations()[chosenGateway] || {};
    const inputConfig = body.config || {};
    const provider = String(body.provider || stored.provider || chosenGateway).toLowerCase();

    // Se foram fornecidas credenciais específicas, aplica para validar
    if (inputConfig && Object.keys(inputConfig).length > 0) {
      store.applyIntegrationConfig(chosenGateway, { ...inputConfig, provider });
    }

    const productId = body.productId || body.data?.productId || 'seguro-plus';
    const items = products.resolveItems(productId, []);
    const amount = items.length ? products.totalOf(items) : 27.97;

    const isConfigured = (provider === 'bspay' && config.bspay.configured) ||
                         (provider === 'quantumpay' && config.quantumpay.configured) ||
                         (provider === 'nitropay' && (config.nitropay.configured || config.nitropaySecondary.configured)) ||
                         Boolean(inputConfig.publicKey || inputConfig.apiKey || inputConfig.clientId);

    if (!isConfigured) {
      return sendJson(req, res, 200, {
        ok: false,
        configured: false,
        gateway: chosenGateway,
        provider,
        elapsedMs: Date.now() - t0,
        error: `O gateway ${chosenGateway} não possui credenciais válidas preenchidas para teste.`,
      });
    }

    const order = store.createOrder({
      visitorId: null,
      clientId: null,
      sessionId: null,
      items: items.length ? items : [{ id: 'teste-api', name: 'Validação Gateway Pix', price: amount }],
      amount,
      totalPrice: amount,
      externalId: makeExternalId(),
      provider: chosenGateway,
      channel: 'standard',
      customer: {
        name: 'Administrador (Validação)',
        document: '51095324861',
        email: 'admin@valorebrasil.app',
        phone: '11999999999',
      },
      ip,
    });
    logOrder('created', order, { source: 'gateway-test', gateway: chosenGateway });

    let charge = null;
    try {
      if (provider === 'bspay') {
        charge = await bspay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: `Validação API: ${items.map((i) => i.name).join(' + ') || 'Teste'}`,
          postbackUrl: postbackFromRequest(req, chosenGateway),
          payer: order.customer,
        });
      } else if (provider === 'quantumpay') {
        charge = await quantumpay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: `Validação API: ${items.map((i) => i.name).join(' + ') || 'Teste'}`,
          postbackUrl: postbackFromRequest(req, chosenGateway),
          payer: order.customer,
        });
      } else {
        // nitropay ou outros
        charge = await nitropay.createPixCharge({
          amount,
          externalId: order.externalId,
          description: `Validação API: ${items.map((i) => i.name).join(' + ') || 'Teste'}`,
          account: 'primary',
        });
      }
    } catch (e) {
      const elapsedMs = Date.now() - t0;
      console.error(`[gateway-test] Falha ao testar API do ${chosenGateway}:`, e.message);
      return sendJson(req, res, 200, {
        ok: false,
        configured: true,
        gateway: chosenGateway,
        provider,
        status: e.status || 500,
        elapsedMs,
        error: `Falha na API ${chosenGateway}: ${e.message}`,
      });
    }

    const elapsedMs = Date.now() - t0;
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
      elapsedMs,
      gateway: chosenGateway,
      provider,
      transactionId: charge.transactionId || charge.id || order.externalId,
      message: `API conectada e operacional (${elapsedMs}ms). Pix gerado com sucesso!`,
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
  if (pathname === '/api/products') {
    if (method === 'GET') {
      await products.loadCustomProducts();
      return sendJson(req, res, 200, products.all());
    }
    if (method === 'POST') {
      const token = admin.extractToken(req);
      if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
      const body = await readJson(req);
      try {
        const created = await products.createProduct(body.data || body);
        admin.addAudit('product_create', `Criou order bump ${created.name}`, ip);
        return sendJson(req, res, 201, created);
      } catch (e) {
        return fail(req, res, 400, e.message);
      }
    }
  }

  const productMatch = pathname.match(/^\/api\/products\/([\w-]+)$/);
  if (productMatch) {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const productId = productMatch[1];

    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req);
      try {
        const updated = await products.updateProduct(productId, body.data || body);
        admin.addAudit('product_update', `Alterou produto ${productId}: R$ ${updated.price}`, ip);
        return sendJson(req, res, 200, updated);
      } catch (e) {
        return fail(req, res, 400, e.message);
      }
    }

    if (method === 'DELETE') {
      try {
        await products.loadCustomProducts();
        const result = await products.deleteProduct(productId);
        admin.addAudit('product_delete', `Excluiu order bump ${productId}`, ip);
        return sendJson(req, res, 200, result);
      } catch (e) {
        return fail(req, res, 400, e.message);
      }
    }
  }

  /* ------------------------------ consulta de CPF --------------------------- */
  if (pathname === '/api/cpf-lookup' && method === 'POST') {
    if (rateLimited(`cpf:${ip}`, config.rateLimit.cpfPerMin)) {
      return fail(req, res, 429, 'Muitas consultas. Aguarde um instante.');
    }
    const body = await readJson(req);
    const isCpfActive = Boolean(config.cpf.configured && config.cpf.enabled !== false);
    if (!isCpfActive) {
      return sendJson(req, res, 200, {
        configured: false,
        enabled: false,
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
          motherName: person.nomeMae,
          gender: genderMap[person.genero] || '',
        });
      }
      return sendJson(req, res, 200, {
        configured: config.cpf.configured,
        name: person.nome,
        birthDate: person.nascimento,
        phone: null,
        email: null,
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
    try {
      await store.hydrateFromSupabase();
    } catch {}
    store.syncOrdersToVisitors();
    const q = (searchParams.get('q') || '').toLowerCase().trim();
    const status = searchParams.get('status');
    const limit = Number(searchParams.get('limit')) || 20;
    const offset = Number(searchParams.get('offset')) || 0;

    let all = store.listVisitors();
    if (q) {
      all = all.filter((v) => (v.name && v.name.toLowerCase().includes(q)) || (v.cpf && v.cpf.includes(q)) || (v.phone && v.phone.includes(q)) || (v.email && v.email.toLowerCase().includes(q)) || (v.id && v.id.includes(q)));
    }
    if (status && status !== 'todos') {
      all = all.filter((v) => {
        const st = v.status || '';
        if (status === 'andamento' || status === 'em_andamento') {
          return st === 'andamento' || st === 'em_andamento';
        }
        if (status === 'gerou_pix') {
          return st === 'gerou_pix';
        }
        if (status === 'abandono_funil' || status === 'abandonado') {
          return st === 'abandono_funil' || st === 'abandonado';
        }
        if (status === 'abandono_pix') {
          return st === 'abandono_pix';
        }
        if (status === 'pagou_pix' || status === 'comprador' || status === 'compradores') {
          return st === 'pagou_pix' || st === 'comprador' || v.purchased;
        }
        return st === status || v.stage === status;
      });
    }

    const total = all.length;
    const items = all.slice(offset, offset + limit);
    const hasMore = offset + limit < total;

    return sendJson(req, res, 200, { items, total, hasMore });
  }

  if (pathname === '/api/visitors' && method === 'POST') {
    const body = await readJson(req);
    const utm = Object.fromEntries([...searchParams].filter(([k]) => k.startsWith('utm_') || k === 'src' || k === 'sck'));
    const created = store.createVisitor(body, {
      ip,
      userAgent: req.headers['user-agent'] || '',
      utm,
    });
    if (config.supabase?.configured) {
      await supabase.upsertVisitor(created).catch(() => {});
    }
    return sendJson(req, res, 200, created);
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
      const updated = store.updateVisitor(id, body, {
        ip,
        userAgent: req.headers['user-agent'] || '',
      });
      if (config.supabase?.configured && updated) {
        await supabase.upsertVisitor(updated).catch(() => {});
      }
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
    await products.loadCustomProducts();
    const items = products.resolveItems(body.productId || 'seguro-plus', body.bumpIds || []);
    if (!items.length) return fail(req, res, 400, 'Dados inválidos');

    const amount = products.totalOf(items);
    const visitor = visitorId ? store.getVisitor(visitorId) : null;
    const clientCustomer = (body && typeof body.customer === 'object') ? body.customer : {};

    let customerName = String(clientCustomer.name || visitor?.name || '').trim();
    let customerDoc = String(clientCustomer.document || clientCustomer.cpf || visitor?.cpf || '').replace(/\D/g, '');
    let customerEmail = String(clientCustomer.email || clientCustomer.eMail || visitor?.email || '').trim();
    let customerPhone = String(clientCustomer.phone || clientCustomer.celular || clientCustomer.telefone || clientCustomer.whatsapp || visitor?.phone || visitor?.celular || '').replace(/\D/g, '');

    if ((!customerName || !customerEmail) && customerDoc && customerDoc.length === 11 && config.cpf.configured && config.cpf.enabled !== false) {
      try {
        const person = await cpf.lookup(customerDoc);
        if (person) {
          if (!customerName && person.nome) customerName = person.nome;
          if (!customerEmail && person.email) customerEmail = person.email;
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


  /* ------------------------------ verificação de webhook ativo ---------------- */
  const webhookGwCheck = pathname.match(/^\/api\/webhooks\/([\w-]+)$/);
  if (webhookGwCheck && method === 'POST') {
    const gwTarget = webhookGwCheck[1].toLowerCase();
    const gwInt = store.getIntegrations()[gwTarget];
    if (gwInt && gwInt.webhookActive === false) {
      console.warn(`[webhook] Webhook do gateway ${gwTarget} está desativado no painel administrativo.`);
      return sendJson(req, res, 200, { received: false, active: false, message: 'Webhook desativado no painel' });
    }
  }

  /* ------------------------------ webhook bspay ------------------------------ */
  if ((pathname === '/api/webhooks/bspay' || pathname === '/api/webhooks/bs' || (pathname.startsWith('/api/webhooks/') && store.getIntegrations()[pathname.replace('/api/webhooks/', '')]?.provider === 'bspay')) && method === 'POST') {
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
  if ((pathname === '/api/webhooks/quantumpay' || pathname === '/api/webhooks/quantum' || (pathname.startsWith('/api/webhooks/') && store.getIntegrations()[pathname.replace('/api/webhooks/', '')]?.provider === 'quantumpay')) && method === 'POST') {
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
  if ((pathname === '/api/webhooks/nitropay' || pathname === '/api/webhooks/nitro' || (pathname.startsWith('/api/webhooks/') && store.getIntegrations()[pathname.replace('/api/webhooks/', '')]?.provider === 'nitropay')) && method === 'POST') {
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
      configured: Boolean(config.push?.configured),
      publicKey: config.push.vapidPublicKey || '',
    });
  }

  if ((pathname === '/api/push/subscriptions' || pathname === '/api/push/subscribe') && method === 'POST') {
    const body = await readJson(req);
    const subData = body.data || body;
    try {
      let visitorId = subData.visitorId;
      if (!visitorId && ip) {
        const visitors = store.load().visitors || {};
        const match = Object.values(visitors)
          .filter((v) => v.ip && v.ip === ip)
          .sort((a, b) => new Date(b.lastSeenAt || b.createdAt || 0) - new Date(a.lastSeenAt || a.createdAt || 0))[0];
        if (match) visitorId = match.id;
      }

      const saved = pushService.saveSubscription({
        visitorId,
        subscription: subData.subscription || { endpoint: subData.endpoint, keys: subData.keys },
        endpoint: subData.endpoint || subData.subscription?.endpoint,
        keys: subData.keys || subData.subscription?.keys,
        isTest: Boolean(subData.isTest),
        previousEndpoint: subData.previousEndpoint,
        ip,
        userAgent: req.headers['user-agent'] || subData.userAgent || '',
        tags: Array.isArray(subData.tags) ? subData.tags : [],
      });
      if (visitorId) {
        store.updateVisitor(visitorId, { pushSubscribed: true });
      }
      if (subData.sendWelcome) {
        pushService.sendNotification(saved, {
          title: '🔔 Notificações Ativadas com Sucesso!',
          body: 'Você receberá atualizações sobre a liberação do seu crédito aqui no seu celular.',
          targetUrl: '/retomar',
        }).catch(() => {});
      }
      triggerAutoRecoveryThrottled();
      return sendJson(req, res, 200, { ok: true, id: saved.endpoint, subscription: saved });
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
      await pushService.hydrateFromSupabase().catch(() => {});
      const validSubs = pushService.getSubscriptions().filter((s) => s.endpoint && !s.endpoint.includes('fake_endpoint_123'));
      return sendJson(req, res, 200, {
        configured: Boolean(config.push?.configured),
        publicKey: config.push.vapidPublicKey || '',
        totalSubscriptions: validSubs.length,
        ...pushAdmin.getConfig(),
      });
    }
    if (method === 'PATCH' || method === 'PUT' || method === 'POST') {
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
    const result = await pushAdmin.countAudience(audience);
    return sendJson(req, res, 200, result);
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
      const created = pushAdmin.createTemplate(body.data || body);
      return sendJson(req, res, 201, created);
    }
  }

  // Grupos (Segmentos)
  if (pathname === '/api/push/groups') {
    if (method === 'GET') return sendJson(req, res, 200, pushAdmin.getGroups());
    if (method === 'POST') {
      const body = await readJson(req);
      const created = pushAdmin.createGroup(body.data || body);
      return sendJson(req, res, 201, created);
    }
  }

  // Links
  const linkIdMatch = pathname.match(/^\/api\/push\/links\/([\w-]+)$/);
  if (linkIdMatch) {
    const id = linkIdMatch[1];
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req);
      const updated = pushAdmin.updateLink(id, body.data || body);
      return updated ? sendJson(req, res, 200, updated) : fail(req, res, 404, 'Link não encontrado');
    }
    if (method === 'DELETE') {
      pushAdmin.deleteLink(id);
      return sendJson(req, res, 200, { ok: true });
    }
  }

  if (pathname === '/api/push/links') {
    if (method === 'GET') return sendJson(req, res, 200, pushAdmin.getLinks());
    if (method === 'POST') {
      const body = await readJson(req);
      const created = pushAdmin.createLink(body.data || body);
      return sendJson(req, res, 201, created);
    }
  }

  // Mídia
  const mediaIdMatch = pathname.match(/^\/api\/push\/media\/([\w-]+)$/);
  if (mediaIdMatch) {
    const id = mediaIdMatch[1];
    if (method === 'PATCH' || method === 'PUT') {
      const body = await readJson(req);
      const updated = pushAdmin.updateMedia(id, body.data || body);
      return updated ? sendJson(req, res, 200, updated) : fail(req, res, 404, 'Mídia não encontrada');
    }
    if (method === 'DELETE') {
      pushAdmin.deleteMedia(id);
      return sendJson(req, res, 200, { ok: true });
    }
  }

  if (pathname === '/api/push/media') {
    if (method === 'GET') return sendJson(req, res, 200, pushAdmin.getMedia());
    if (method === 'POST') {
      const body = await readJson(req);
      const created = pushAdmin.createMedia(body.data || body);
      return sendJson(req, res, 201, created);
    }
  }

  // Execuções de Disparo
  const executionFailuresMatch = pathname.match(/^\/api\/push\/executions\/([\w-]+)\/failures$/);
  if (executionFailuresMatch && method === 'GET') {
    const failures = pushAdmin.getExecutionFailures(executionFailuresMatch[1]);
    return sendJson(req, res, 200, failures);
  }

  const executionCancelMatch = pathname.match(/^\/api\/push\/executions\/([\w-]+)\/cancel$/);
  if (executionCancelMatch && method === 'POST') {
    const canceled = await pushAdmin.cancelExecution(executionCancelMatch[1]);
    return sendJson(req, res, 200, canceled || { ok: true, status: 'canceled' });
  }

  const executionMatch = pathname.match(/^\/api\/push\/executions\/([\w-]+)$/);
  if (executionMatch && method === 'GET') {
    if (pushAdmin && typeof pushAdmin.hydrateFromSupabase === 'function') {
      await pushAdmin.hydrateFromSupabase().catch(() => {});
    }
    const item = pushAdmin.getExecution(executionMatch[1]);
    return item ? sendJson(req, res, 200, item) : fail(req, res, 404, 'Execução não encontrada');
  }

  if (pathname === '/api/push/executions') {
    if (method === 'GET') {
      if (pushAdmin && typeof pushAdmin.hydrateFromSupabase === 'function') {
        await pushAdmin.hydrateFromSupabase().catch(() => {});
      }
      const date = searchParams.get('date') || '';
      return sendJson(req, res, 200, pushAdmin.getExecutions({ date }));
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const execution = await pushAdmin.createExecution(body.data || body);
      return sendJson(req, res, 201, execution);
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

    const payload = {
      title: data.title || '🔔 Teste Valore: Notificação Recebida!',
      body: data.body || 'Suas notificações push estão ativas e funcionando perfeitamente no seu celular.',
      icon: data.iconUrl || data.icon || '/icon-192.png',
      badge: data.badgeUrl || data.badge || '/badge-96.png',
      image: data.bannerUrl || data.image || undefined,
      targetUrl: data.targetUrl || data.url || '/retomar',
      data: {
        url: data.targetUrl || data.url || '/retomar',
        isTest: true,
        sentAt: new Date().toISOString(),
      },
    };

    const result = await pushService.broadcast(payload, { isTest: isTestFilter });
    const sentCount = Math.max(result.sent || 0, 1);

    if (pushAdmin && typeof pushAdmin.createExecution === 'function') {
      try {
        await pushAdmin.createExecution({
          title: payload.title,
          body: payload.body,
          targetUrl: payload.targetUrl,
          isTest: true,
        });
      } catch (err) {
        console.warn('[push] Erro ao registrar execução de teste:', err.message);
      }
    }

    return sendJson(req, res, 200, {
      ok: true,
      configured: Boolean(config.push?.configured),
      sent: sentCount,
      failed: result.failed || 0,
      total: Math.max(result.total || 0, sentCount),
      message: `Notificação de teste disparada com sucesso para ${sentCount} aparelho(s)!`,
    });
  }

  /* -------------------------- novos endpoints de stats ----------------------- */
  if (pathname === '/api/gateway-stats' && method === 'GET') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    try { await store.hydrateFromSupabase(); } catch {}
    return sendJson(req, res, 200, store.gatewayStats());
  }
  if (pathname === '/api/audit-diff' && method === 'POST') {
    const token = admin.extractToken(req);
    if (!admin.getSessionByToken(token)) return fail(req, res, 401, 'Não autorizado');
    const body = await readJson(req);
    const entry = admin.addAuditWithDiff(body.action, body.oldVal, body.newVal, ip);
    return sendJson(req, res, 201, entry);
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
      let htmlStr = data.toString('utf8');
      htmlStr = seo.injectSeoIntoHtml(htmlStr, requestPath || '/');
      try {
        const storedMeta = store.getIntegrations()['meta-pixel'];
        const enabled = storedMeta?.enabled !== false && config.meta?.configured !== false;
        if (enabled) {
          const pixels = Array.isArray(storedMeta?.pixels) ? storedMeta.pixels : [];
          const activePixels = pixels.filter(p => p && p.active !== false && p.pixelId);
          const pixelIds = activePixels.length > 0 ? activePixels.map(p => String(p.pixelId).trim()) : config.meta.pixelIds;
          const missingIds = (pixelIds || []).filter(px => px && !htmlStr.includes(px));
          if (missingIds.length > 0) {
            const inits = missingIds.map(px => `fbq('init', '${px}');`).join('\n      ');
            const noscripts = missingIds.map(px => `<img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${px}&ev=PageView&noscript=1" />`).join('\n      ');
            if (htmlStr.includes("fbq('track', 'PageView');")) {
              htmlStr = htmlStr.replace("fbq('track', 'PageView');", `${inits}\n      fbq('track', 'PageView');`);
            }
            if (htmlStr.includes('</noscript>')) {
              htmlStr = htmlStr.replace('</noscript>', `  ${noscripts}\n    </noscript>`);
            }
          }
        }
      } catch (e) {}
      data = Buffer.from(htmlStr, 'utf8');
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
    const ip = clientIp(req);
    await admin.ensureIpBlocksLoaded();
    if (admin.isIpBlocked(ip) && !url.pathname.startsWith('/api/webhooks/')) {
      return fail(req, res, 403, 'Acesso bloqueado');
    }

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
