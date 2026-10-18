'use strict';
/**
 * Integração com a API Nitro Pagamentos Hub (v2.0)
 * Documentação: https://doc.nitropagamentoshub.com/
 */
const config = require('./config');
const qrimg = require('./qrimg');

class NitropayError extends Error {
  constructor(message, { code = 'NITROPAY_ERROR', status = 502, details = null } = {}) {
    super(message);
    this.name = 'NitropayError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function getAuthHeader() {
  const pk = config.nitropay?.publicKey;
  const sk = config.nitropay?.secretKey;
  if (!pk || !sk) {
    throw new NitropayError('Credenciais da Nitro Pagamentos não configuradas', { code: 'MISSING_CREDENTIALS', status: 500 });
  }
  const token = Buffer.from(`${pk}:${sk}`).toString('base64');
  return `Basic ${token}`;
}

async function request(path = '', { method = 'GET', body = null } = {}) {
  const base = (config.nitropay?.apiBase || 'https://api.nitropagamento.app').replace(/\/+$/, '');
  const url = path ? `${base}/${path.replace(/^\/+/, '')}` : base;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);

  let res;
  try {
    const opts = {
      method,
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      opts.body = JSON.stringify(body);
    }
    res = await fetch(url, opts);
  } catch (e) {
    clearTimeout(timer);
    throw new NitropayError(`Falha de rede com Nitro Pagamentos: ${e.message}`, { code: 'NETWORK_ERROR', status: 502 });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }

  if (!res.ok) {
    const msg = json?.message || json?.error || `Erro HTTP ${res.status} da Nitro Pagamentos`;
    throw new NitropayError(msg, {
      code: `HTTP_${res.status}`,
      status: res.status >= 400 && res.status < 500 ? res.status : 502,
      details: json,
    });
  }

  return json;
}

/** Cria uma cobrança PIX na Nitro Pagamentos */
async function createPixCharge({
  amount,
  externalId,
  description = 'Pagamento PIX',
  payer = {},
  postbackUrl = null,
} = {}) {
  const cleanDoc = String(payer?.document || '').replace(/\D/g, '') || '57062194867';
  let cleanPhone = String(payer?.phone || payer?.celular || '').replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    cleanPhone = '11999999999';
  }

  const payload = {
    amount: Number(Number(amount || 0).toFixed(2)),
    payment_method: 'pix',
    description: description || 'Serviços Financeiros',
    customer: {
      name: payer?.name || 'Cliente',
      email: payer?.email || 'contato@cliente.com',
      document: cleanDoc,
      phone: cleanPhone,
    },
    metadata: {
      order_id: externalId,
    },
    postbackUrl: postbackUrl || config.nitropay.postbackUrl,
    source_url: `${config.publicBaseUrl}/pagamento`,
    source_label: 'Valore Oferta',
  };

  const json = await request('', { method: 'POST', body: payload });
  const data = json?.data || json;

  const pixCode = data?.pix_code || '';
  let qrBase64 = data?.pix_qr_code || '';
  if (!qrBase64 && pixCode) {
    qrBase64 = qrimg.toBase64(pixCode);
  }

  return {
    transactionId: data?.id || null,
    externalId: data?.external_ref || externalId,
    amount: data?.amount ?? amount,
    method: 'pix',
    qrcode: pixCode,
    qrCodeBase64: qrBase64,
    expiresAt: data?.expires_at || null,
    postbackUrl: payload.postbackUrl,
    raw: json,
  };
}

/** Consulta o status de uma transação pelo ID */
async function consultTransaction(id) {
  if (!id) return null;
  const json = await request(`transactions/${id}`, { method: 'GET' });
  const data = json?.data || json;
  if (!data || data.name === 'Nitro Pagamentos HUB API' || !data.id || String(data.id).startsWith('integer')) {
    return null;
  }
  return data;
}

/** Verifica se a cobrança foi paga na Nitro Pagamentos */
async function isChargePaid({ transactionId, externalId }) {
  if (!transactionId) return { paid: false, found: false, tx: null };
  try {
    const tx = await consultTransaction(transactionId);
    if (!tx) return { paid: false, found: false, tx: null };
    const status = String(tx.status || '').toLowerCase();
    const paid = ['pago', 'paid', 'approved', 'confirmado'].includes(status);
    return { paid, found: true, status, tx };
  } catch (e) {
    console.warn(`[nitropay] erro ao consultar ${transactionId}:`, e.message);
    return { paid: false, found: false, error: e.message };
  }
}

module.exports = {
  createPixCharge,
  consultTransaction,
  isChargePaid,
  NitropayError,
};
