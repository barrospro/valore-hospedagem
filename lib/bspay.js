'use strict';
/**
 * Cliente BSPay — API v2 (https://dev.bspay.co)
 *
 *   POST /v2/oauth/token                Basic {base64(client_id:client_secret)} + {"grant_type":"client_credentials"}
 *   POST /v2/transactions/cashin        Bearer + { amount, currency:"BRL", external_id, payer, postback_url }
 *                                       -> data.payment_info.qrcode (PIX copia-e-cola)
 *   POST /v2/account/transactions/list  Bearer + { page, page_size, ... } (reconciliação)
 *   POST /v2/consult-transaction        Bearer + { pix_id } (legado)
 *
 * Rotas financeiras (cashout/transfer/conversão) exigem HMAC:
 *   X-Signature = hex(hmac_sha256(`${timestamp}.${nonce}.${rawBody}`, signing_key))
 *   X-Timestamp = unix seconds · X-Nonce = uuid v4
 */
const crypto = require('crypto');
const config = require('./config');

let tokenCache = { value: null, expiresAt: 0 };
let tokenInflight = null;

class BspayError extends Error {
  constructor(message, { status = 502, code = 'BSPAY_ERROR', details = null } = {}) {
    super(message);
    this.name = 'BspayError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const authHeaderBasic = () =>
  'Basic ' + Buffer.from(`${config.bspay.clientId}:${config.bspay.clientSecret}`).toString('base64');

async function request(pathname, { method = 'POST', body, token, timeoutMs = 20000, hmac = false } = {}) {
  const url = `${config.bspay.apiBase.replace(/\/+$/, '')}${pathname}`;
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const headers = { Accept: 'application/json' };

  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  if (hmac) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID();
    const signingKey = config.bspay.signingKey;
    headers['X-Timestamp'] = timestamp;
    headers['X-Nonce'] = nonce;
    headers['X-Signature'] = crypto
      .createHmac('sha256', signingKey)
      .update(`${timestamp}.${nonce}.${rawBody}`)
      .digest('hex');
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : rawBody, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(t);
    throw new BspayError(`Falha de rede na BSPay: ${e.message}`, { code: 'NETWORK_ERROR' });
  } finally {
    clearTimeout(t);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }

  if (!res.ok) {
    /* A BSPay responde {success:false, error:{code, message, group, retryable}}
       ou {error:"...", error_description:"..."} (OAuth padrão). */
    const errObj = json?.error && typeof json.error === 'object' ? json.error : null;
    const code = errObj?.code || (typeof json?.error === 'string' ? json.error : null) || `HTTP_${res.status}`;
    const message = errObj?.message || json?.error_description
      || (typeof json?.error === 'string' ? json.error : null)
      || json?.message || `BSPay HTTP ${res.status}`;
    throw new BspayError(message, {
      status: res.status >= 500 ? 502 : res.status,
      code,
      details: { http: res.status, group: errObj?.group, retryable: errObj?.retryable, body: json || text.slice(0, 300) },
    });
  }
  return json;
}

/** Token OAuth2 com cache em memória (validade 1h, renova 60s antes). */
async function getToken(force = false) {
  if (!config.bspay.configured) {
    throw new BspayError('Credenciais da BSPay não configuradas (.env: BSPAY_CLIENT_ID / BSPAY_CLIENT_SECRET)', {
      code: 'NOT_CONFIGURED',
      status: 500,
    });
  }
  const now = Date.now();
  if (!force && tokenCache.value && now < tokenCache.expiresAt) return tokenCache.value;
  if (tokenInflight) return tokenInflight;

  tokenInflight = (async () => {
    try {
      // Este endpoint usa Basic Auth (não Bearer), por isso não passa por request().
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let res;
      try {
        res = await fetch(`${config.bspay.apiBase.replace(/\/+$/, '')}/v2/oauth/token`, {
          method: 'POST',
          headers: { Authorization: authHeaderBasic(), 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ grant_type: 'client_credentials' }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* ignore */ }

      if (!res.ok || !body?.access_token) {
        const errObj = body?.error && typeof body.error === 'object' ? body.error : null;
        const code = errObj?.code || (typeof body?.error === 'string' ? body.error : null)
          || (res.status === 401 ? 'INVALID_CREDENTIALS' : `HTTP_${res.status}`);
        const message = errObj?.message || body?.error_description
          || (typeof body?.error === 'string' ? body.error : null)
          || body?.message || `Falha ao autenticar na BSPay (HTTP ${res.status})`;
        throw new BspayError(message, {
          code,
          status: res.status === 401 ? 401 : 502,
          details: { http: res.status, group: errObj?.group, retryable: errObj?.retryable, body },
        });
      }

      const expiresIn = Number(body.expires_in || 3600);
      tokenCache = { value: body.access_token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
      return tokenCache.value;
    } finally {
      tokenInflight = null;
    }
  })();

  return tokenInflight;
}

/** Status considerados "pago" na BSPay. */
const PAID_STATUSES = ['paid', 'confirmed', 'completed', 'succeeded', 'approved'];

/** URLs que não valem como postback (o gateway exige HTTPS público válido). */
const INVALID_POSTBACK = /(SEU_DOMINIO|seudominio|example\.com|localhost|127\.0\.0\.1|0\.0\.0\.0)/i;

/**
 * Escolhe a URL de postback: parâmetro explícito > .env > PUBLIC_BASE_URL.
 * Devolve null quando nenhuma é válida — aí a BSPay usa o webhook padrão da
 * credencial, em vez de receber uma URL inválida e recusar a cobrança.
 */
function pickPostbackUrl(explicit) {
  const candidates = [
    explicit,
    config.bspay.postbackUrl,
    config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/+$/, '')}/api/webhooks/bspay` : '',
  ];
  for (const c of candidates) {
    if (c && /^https:\/\//i.test(c) && !INVALID_POSTBACK.test(c)) return c;
  }
  return null;
}

/**
 * O gateway resolve o DNS do postback_url e recusa a cobrança quando o domínio
 * ainda não está no ar (INVALID_POSTBACK_URL). Quando isso acontece, criamos a
 * cobrança sem postback e evitamos mandar de novo por alguns minutos — o
 * pagamento continua sendo reconhecido pela reconciliação.
 */
let postbackDisabledUntil = 0;

function postbackBlocked() {
  return Date.now() < postbackDisabledUntil;
}

function blockPostback(minutes = 10, reason = '') {
  postbackDisabledUntil = Date.now() + minutes * 60000;
  console.warn(`[bspay] postback desativado por ${minutes} min (${reason}). O pagamento será confirmado pela reconciliação.`);
}

/** Cria cobrança PIX (cash-in). Retorna a transação crua da BSPay. */
async function createPixCharge({ amount, externalId, payer, postbackUrl, description }) {
  const token = await getToken();
  const base = {
    amount: Number(Number(amount).toFixed(2)),
    currency: 'BRL',
    external_id: externalId,
  };
  if (payer && (payer.name || payer.document || payer.email)) {
    base.payer = {
      ...(payer.name ? { name: payer.name } : {}),
      ...(payer.document ? { document: String(payer.document).replace(/\D/g, '') } : {}),
      ...(payer.email ? { email: payer.email } : {}),
    };
  }
  if (description) base.description = description;

  const postback = postbackBlocked() ? null : pickPostbackUrl(postbackUrl);

  const attempt = async (withPostback) => {
    const payload = withPostback ? { ...base, postback_url: postback } : { ...base };
    const json = await request('/v2/transactions/cashin', { method: 'POST', body: payload, token });
    return { json, payload };
  };

  let json;
  let usedPostback = postback;
  try {
    ({ json } = await attempt(!!postback));
  } catch (e) {
    if (postback && e.code === 'INVALID_POSTBACK_URL') {
      blockPostback(10, 'o gateway não conseguiu resolver o domínio do postback');
      usedPostback = null;
      ({ json } = await attempt(false));
    } else {
      throw e;
    }
  }

  const data = json?.data || json;
  return {
    transactionId: data?.transaction_id || null,
    externalId: data?.external_id || externalId,
    amount: data?.amount ?? base.amount,
    fee: data?.fee ?? null,
    method: data?.payment_method || 'pix',
    qrcode: data?.payment_info?.qrcode || '',
    expiresAt: data?.payment_info?.expires_at || null,
    expirationSeconds: data?.payment_info?.expiration || null,
    postbackUrl: usedPostback,
    raw: json,
  };
}

/** Lista transações (usado para reconciliar ordens pendentes). */
async function listTransactions({ page = 1, pageSize = 20, status = null, type = null, currency = null, fromDate = null, toDate = null } = {}) {
  const token = await getToken();
  const json = await request('/v2/account/transactions/list', {
    method: 'POST',
    token,
    body: {
      page,
      page_size: pageSize,
      status,
      type,
      currency,
      from_date: fromDate,
      to_date: toDate,
    },
  });
  return json?.data || json?.transactions || json || [];
}

/** Consulta legada por pix_id. */
async function consultTransaction(pixId) {
  const token = await getToken();
  const json = await request('/v2/consult-transaction', { method: 'POST', token, body: { pix_id: pixId } });
  return json?.data || json;
}

async function balance() {
  const token = await getToken();
  const json = await request('/v2/account/balance', { method: 'GET', token });
  return json?.data || json;
}

/** Procura a transação da ordem no extrato do gateway. */
async function findTransaction({ externalId, transactionId }) {
  const list = await listTransactions({ page: 1, pageSize: 100, type: 'cashin', currency: 'BRL' });
  const arr = Array.isArray(list) ? list : (list?.items || list?.data || []);
  return arr.find(
    (t) => (externalId && t.external_id === externalId)
      || (transactionId && t.transaction_id === transactionId),
  ) || null;
}

/**
 * Confirma no gateway se a cobrança foi realmente paga.
 * Usado como fonte da verdade quando o webhook não pode ser verificado
 * por assinatura (sem webhook_secret configurado).
 */
async function isChargePaid({ externalId, transactionId }) {
  const tx = await findTransaction({ externalId, transactionId });
  if (!tx) return { paid: false, found: false, tx: null };
  const status = String(tx.status || '').toLowerCase();
  return { paid: PAID_STATUSES.includes(status), found: true, status, tx };
}

/** Valida a assinatura HMAC-SHA256 do webhook sobre o body RAW. */
function verifyWebhook(rawBody, signature, secret = config.bspay.webhookSecret) {
  if (!signature || !config.isFilled(secret)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Janela anti-replay do webhook (±5 min), quando o timestamp vem no header. */
function webhookTimestampOk(headerValue, toleranceSec = 300) {
  const ts = Number(headerValue);
  if (!ts) return true; // gateway não mandou timestamp: não é motivo para rejeitar
  return Math.abs(Math.floor(Date.now() / 1000) - ts) <= toleranceSec;
}

module.exports = {
  getToken,
  createPixCharge,
  listTransactions,
  consultTransaction,
  balance,
  findTransaction,
  isChargePaid,
  verifyWebhook,
  webhookTimestampOk,
  pickPostbackUrl,
  PAID_STATUSES,
  BspayError,
  _request: request,
};
