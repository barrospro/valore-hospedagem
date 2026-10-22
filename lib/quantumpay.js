'use strict';
/**
 * Integração com a API Quantum Pay (PIX IN e Webhooks)
 * Documentação: https://docs.quantumpay.com.br/
 */
const crypto = require('crypto');
const config = require('./config');
const qrimg = require('./qrimg');

class QuantumPayError extends Error {
  constructor(message, { code = 'QUANTUMPAY_ERROR', status = 502, details = null } = {}) {
    super(message);
    this.name = 'QuantumPayError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

let cachedToken = null;
let tokenExpiresAt = 0;

/** Obtém ou renova o Bearer Token de acesso à API da Quantum Pay */
async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  const { apiKey, apiSecret, apiBase } = config.quantumpay;
  if (!apiKey || !apiSecret) {
    throw new QuantumPayError('Credenciais da Quantum Pay (API Key ou Secret) não configuradas', {
      code: 'MISSING_CREDENTIALS',
      status: 500,
    });
  }

  const base = (apiBase || 'https://api.quantumpay.com.br').replace(/\/+$/, '');
  const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);

  let res;
  try {
    res = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new QuantumPayError(`Falha de rede ao autenticar na Quantum Pay: ${e.message}`, {
      code: 'AUTH_NETWORK_ERROR',
      status: 502,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok || !json?.token) {
    const msg = json?.message || `Erro HTTP ${res.status} ao autenticar na Quantum Pay`;
    throw new QuantumPayError(msg, {
      code: `AUTH_HTTP_${res.status}`,
      status: res.status >= 400 && res.status < 500 ? res.status : 502,
      details: json,
    });
  }

  cachedToken = json.token;
  // Expira em 30 min (1800s); renovamos aos 25 min para segurança
  const ttlMs = (Number(json.expiresIn) || 1800) * 1000;
  tokenExpiresAt = now + Math.max(ttlMs - 300000, 60000);

  return cachedToken;
}

/** Cria uma cobrança PIX via QR Code na Quantum Pay */
async function createPixCharge({
  amount,
  externalId,
  description = 'Tarifa Cadastral Valore',
  payer = {},
  postbackUrl = null,
} = {}) {
  const token = await getAuthToken();
  const base = (config.quantumpay?.apiBase || 'https://api.quantumpay.com.br').replace(/\/+$/, '');

  const amountInCents = Math.round(Number(amount || 0) * 100);
  if (amountInCents <= 0) {
    throw new QuantumPayError('Valor da cobrança inválido', { code: 'INVALID_AMOUNT', status: 400 });
  }

  // Sanitização e formatação dos dados do cliente
  const docDigits = String(payer.document || payer.cpf || '').replace(/\D/g, '');
  const cleanName = String(payer.name || 'Cliente').trim();
  const rawEmail = String(payer.email || '').trim();
  const cleanEmail = rawEmail && rawEmail.includes('@') ? rawEmail : `cliente_${docDigits || Date.now()}@valore.com.br`;
  const rawPhone = String(payer.phone || '').replace(/\D/g, '');
  const cleanPhone = rawPhone.length >= 10 ? rawPhone : '11999999999';

  const webhookUrl = postbackUrl || config.quantumpay?.postbackUrl || `${config.publicBaseUrl}/api/webhooks/quantumpay`;

  const payload = {
    amountInCents,
    description: (description || 'Pagamento via PIX').slice(0, 140),
    postbackUrl: webhookUrl,
    customer: {
      name: cleanName,
      email: cleanEmail,
      document: docDigits || '06692386942',
      documentType: 'cpf',
      phone: cleanPhone,
    },
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);

  let res;
  try {
    res = await fetch(`${base}/api/v1/pix/in/qrcode`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new QuantumPayError(`Falha de rede ao criar PIX na Quantum Pay: ${e.message}`, {
      code: 'NETWORK_ERROR',
      status: 502,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok || !json?.success) {
    const msg = json?.message || `Erro HTTP ${res.status} ao gerar PIX na Quantum Pay`;
    throw new QuantumPayError(msg, {
      code: `PIX_HTTP_${res.status}`,
      status: res.status >= 400 && res.status < 500 ? res.status : 502,
      details: json,
    });
  }

  const data = json.data || {};
  const pixData = data.pix || {};
  const pixCode = pixData.emv || '';

  let qrBase64 = pixData.qrCode || '';
  if (qrBase64 && !qrBase64.startsWith('data:image')) {
    qrBase64 = `data:image/png;base64,${qrBase64}`;
  }
  if (!qrBase64 && pixCode) {
    qrBase64 = qrimg.toBase64(pixCode);
  }

  return {
    transactionId: data.id,
    externalId,
    amount: Number(amount),
    method: 'pix',
    qrcode: pixCode,
    qrCodeBase64: qrBase64,
    expiresAt: null,
    postbackUrl: webhookUrl,
    description: payload.description,
    raw: json,
  };
}

/** Consulta os detalhes e status de uma transação na Quantum Pay */
async function consultTransaction(id) {
  if (!id) return null;
  const token = await getAuthToken();
  const base = (config.quantumpay?.apiBase || 'https://api.quantumpay.com.br').replace(/\/+$/, '');

  try {
    const res = await fetch(`${base}/api/v1/transactions/${id}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data || json;
  } catch (e) {
    console.warn(`[quantumpay] Erro ao consultar transação ${id}:`, e.message);
    return null;
  }
}

/** Verifica se a cobrança foi paga na Quantum Pay */
async function isChargePaid({ transactionId, externalId }) {
  if (!transactionId) return { paid: false, found: false, tx: null };
  try {
    const tx = await consultTransaction(transactionId);
    if (!tx) return { paid: false, found: false, tx: null };
    const status = String(tx.status || '').toLowerCase();
    const paid = ['paid', 'pago', 'completed', 'approved'].includes(status);
    return { paid, found: true, status, tx };
  } catch (e) {
    console.warn(`[quantumpay] Erro ao verificar pagamento ${transactionId}:`, e.message);
    return { paid: false, found: false, error: e.message };
  }
}

/** Valida a assinatura de um webhook da Quantum Pay */
function verifyWebhook(payload, signature) {
  const secret = config.quantumpay?.apiSecret;
  if (!secret || !signature) return true; // Se não houver segredo, aceita
  try {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const hash = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    const expected = `sha256=${hash}`;
    return signature === expected || signature === hash;
  } catch {
    return false;
  }
}

module.exports = {
  createPixCharge,
  consultTransaction,
  isChargePaid,
  verifyWebhook,
  getAuthToken,
  QuantumPayError,
};
