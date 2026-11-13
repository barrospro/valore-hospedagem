'use strict';
/**
 * Cliente LofyPay — API v1 (https://docs.lofypay.com / https://app.lofypay.com/api/v1)
 *
 *   POST /gateway   -> Cria cobrança PIX (amount, method: 'pix', client: { name, email, document, phone }, external_reference, notification_url)
 *   POST /status    -> Consulta status ({ idtransaction }) -> { status: 'PAID_OUT' | 'WAITING_FOR_APPROVAL' | ... }
 *   GET  /balance   -> Consulta saldo e ambiente ({ success: true, environment: 'live', currency: 'BRL', available, ... })
 */
const crypto = require('crypto');
const config = require('./config');
const qrimg = require('./qrimg');

class LofypayError extends Error {
  constructor(message, { status = 502, code = 'LOFYPAY_ERROR', details = null } = {}) {
    super(message);
    this.name = 'LofypayError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const PAID_STATUSES = ['paid_out', 'paid', 'approved', 'completed', 'confirmed', 'succeeded'];

async function request(pathname, { method = 'POST', body, timeoutMs = 8000 } = {}) {
  const secretKey = config.lofypay?.secretKey;
  if (!secretKey) {
    throw new LofypayError('Secret Key da LofyPay não configurada (.env: LOFYPAY_SECRET_KEY)', {
      code: 'NOT_CONFIGURED',
      status: 500,
    });
  }

  const base = (config.lofypay?.apiBase || 'https://app.lofypay.com/api/v1').replace(/\/+$/, '');
  const url = `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'x-api-key': secretKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      signal: ctrl.signal,
    };
    if (body !== undefined && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      opts.body = JSON.stringify(body);
    }
    res = await fetch(url, opts);
  } catch (e) {
    clearTimeout(timer);
    const isTimeout = e.name === 'AbortError' || String(e.message).includes('aborted');
    throw new LofypayError(
      isTimeout ? `Timeout na LofyPay (${timeoutMs}ms excedidos)` : `Falha de rede com LofyPay: ${e.message}`,
      { code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR', status: 502 }
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!res.ok) {
    const msg = json?.message || json?.error || `LofyPay HTTP ${res.status}`;
    const code = json?.code || `HTTP_${res.status}`;
    throw new LofypayError(msg, {
      status: res.status >= 500 ? 502 : res.status,
      code,
      details: json || text.slice(0, 300),
    });
  }

  return json;
}

async function balance() {
  return request('/balance', { method: 'GET' });
}

async function createPixCharge({ amount, externalId, payer, description, postbackUrl }) {
  const cleanDoc = String(payer?.document || '').replace(/\D/g, '') || '51095324861';
  let cleanPhone = String(payer?.phone || payer?.celular || '').replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 10) cleanPhone = '11999999999';
  const cleanName = String(payer?.name || '').trim() || 'Cliente';
  const cleanEmail = String(payer?.email || '').trim() || 'contato@cliente.com';

  const payload = {
    amount: Number(Number(amount).toFixed(2)),
    method: 'pix',
    description: description || 'Serviços Financeiros - Valore',
    external_reference: externalId,
    notification_url: postbackUrl || config.lofypay?.postbackUrl || `${config.publicBaseUrl}/api/webhooks/lofypay`,
    client: {
      name: cleanName,
      email: cleanEmail,
      document: cleanDoc,
      phone: cleanPhone,
    },
  };

  const json = await request('/gateway', { method: 'POST', body: payload, timeoutMs: 6000 });
  const data = json?.data || json;

  const txId = data.idTransaction || data.id_transaction || data.id || data.transactionId;
  const pixCode = data.pix_code || data.pixCode || data.paymentCode || data.qrcode || data.qr_code || data.emv || '';
  let qrBase64 = data.pix_qr_code || data.qrcode_base64 || '';
  if (!qrBase64 && pixCode) {
    qrBase64 = qrimg.toBase64(pixCode);
  }

  return {
    transactionId: txId,
    externalId: data.external_reference || externalId,
    amount: data.amount ?? payload.amount,
    method: 'pix',
    qrcode: pixCode,
    qrCodeText: pixCode,
    pixCopiaECola: pixCode,
    qrCodeBase64: qrBase64,
    expiresAt: data.expires_at || null,
    provider: 'lofypay',
    raw: json,
  };
}

async function consultTransaction(idTransaction) {
  if (!idTransaction) return null;
  try {
    const json = await request('/status', {
      method: 'POST',
      body: { idtransaction: idTransaction },
    });
    return json;
  } catch (e) {
    return null;
  }
}

async function isChargePaid({ transactionId, externalId }) {
  const id = transactionId || externalId;
  if (!id) return { paid: false, found: false, tx: null };
  const res = await consultTransaction(id);
  if (!res) return { paid: false, found: false, tx: null };
  const status = String(res.status || '').toLowerCase();
  const paid = PAID_STATUSES.includes(status);
  return { paid, found: true, status, tx: res };
}

module.exports = {
  balance,
  createPixCharge,
  consultTransaction,
  isChargePaid,
  PAID_STATUSES,
  LofypayError,
};
