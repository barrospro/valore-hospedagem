'use strict';
/**
 * Integração oficial com a API IronPay (v1)
 * Documentação: https://docs.ironpayapp.com.br/
 */
const config = require('./config');
const qrimg = require('./qrimg');

class IronpayError extends Error {
  constructor(message, { code = 'IRONPAY_ERROR', status = 502, details = null } = {}) {
    super(message);
    this.name = 'IronpayError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function getApiToken() {
  const token = config.ironpay?.apiToken;
  if (!token) {
    throw new IronpayError('Token da API IronPay não configurado', {
      code: 'MISSING_API_TOKEN',
      status: 500,
    });
  }
  return token;
}

function getBaseUrl() {
  return (config.ironpay?.apiBase || 'https://api.ironpayapp.com.br/api/public/v1').replace(/\/+$/, '');
}

/**
 * Cria uma cobrança PIX oficial na IronPay
 */
async function createPixCharge({
  amount,
  externalId,
  description = 'Tarifa Cadastral Valore',
  payer = {},
  postbackUrl = null,
} = {}) {
  const token = getApiToken();
  const base = getBaseUrl();

  const amountInCents = Math.round(Number(amount || 0) * 100);
  if (amountInCents <= 0) {
    throw new IronpayError('Valor da cobrança inválido', { code: 'INVALID_AMOUNT', status: 400 });
  }

  // Sanitização e formatação dos dados do cliente
  const docDigits = String(payer.document || payer.cpf || '').replace(/\D/g, '') || '51095324861';
  let cleanName = String(payer.name || 'Cliente').trim();
  if (cleanName.length < 3) cleanName = 'Cliente Valore';
  const rawEmail = String(payer.email || payer.eMail || '').trim();
  const cleanEmail = rawEmail && rawEmail.includes('@') ? rawEmail : `cliente_${docDigits || Date.now()}@valorebrasil.app`;
  const rawPhone = String(payer.phone || payer.celular || payer.telefone || payer.whatsapp || '').replace(/\D/g, '');
  const cleanPhone = rawPhone.length >= 10 ? rawPhone : '11999999999';

  const webhookUrl = postbackUrl || config.ironpay?.postbackUrl || `${config.publicBaseUrl}/api/webhooks/ironpay`;
  const productHash = config.ironpay?.productHash || '1b0rhn5ml4';
  const offerHash = config.ironpay?.offerHash || 'ivkzy';

  const payload = {
    amount: amountInCents,
    offer_hash: offerHash,
    payment_method: 'pix',
    installments: 1,
    customer: {
      name: cleanName,
      email: cleanEmail,
      phone_number: cleanPhone,
      document: docDigits,
      street_name: payer.street_name || payer.address || 'Rua',
      number: String(payer.number || '100'),
      complement: String(payer.complement || ''),
      neighborhood: payer.neighborhood || payer.bairro || 'Centro',
      city: payer.city || payer.cidade || 'Sao Paulo',
      state: payer.state || payer.uf || 'SP',
      zip_code: String(payer.zip_code || payer.cep || '01001000').replace(/\D/g, '') || '01001000',
    },
    cart: [
      {
        product_hash: productHash,
        title: (description || 'Tarifa Cadastral Valore').slice(0, 100),
        cover: null,
        price: amountInCents,
        quantity: 1,
        operation_type: 1,
        tangible: false,
      },
    ],
    expire_in_days: 1,
    transaction_origin: 'api',
    postback_url: webhookUrl,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);

  let res;
  try {
    res = await fetch(`${base}/transactions?api_token=${token}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new IronpayError(`Falha de rede ao criar PIX na IronPay: ${e.message}`, {
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

  if (!res.ok || (json && json.success === false)) {
    const msg = json?.message || `Erro HTTP ${res.status} ao gerar PIX na IronPay`;
    throw new IronpayError(msg, {
      code: `PIX_HTTP_${res.status}`,
      status: res.status >= 400 && res.status < 500 ? res.status : 502,
      details: json,
    });
  }

  const pixData = json?.pix || {};
  const pixCode = pixData.pix_url || pixData.pix_qr_code || '';

  let qrBase64 = pixData.qr_code_base64 || '';
  if (qrBase64 && !qrBase64.startsWith('data:image')) {
    qrBase64 = `data:image/png;base64,${qrBase64}`;
  }
  if (!qrBase64 && pixCode) {
    qrBase64 = qrimg.toBase64(pixCode);
  }

  return {
    transactionId: json.hash || String(json.id) || json.token,
    externalId: externalId || json.hash,
    hash: json.hash,
    id: json.id,
    amount: Number(amount),
    method: 'pix',
    qrcode: pixCode,
    qrCodeText: pixCode,
    qrCodeBase64: qrBase64,
    expiresAt: json.expires_at || null,
    postbackUrl: webhookUrl,
    provider: 'ironpay',
    gatewayAccount: 'IronPay',
    isCloaked: true,
    description: payload.cart[0].title,
    raw: json,
  };
}

/**
 * Consulta os detalhes e status de uma transação na IronPay pelo hash ou ID
 */
async function consultTransaction(hashOrId) {
  if (!hashOrId) return null;
  const token = getApiToken();
  const base = getBaseUrl();

  try {
    const res = await fetch(`${base}/transactions/${hashOrId}?api_token=${token}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data || json;
  } catch (e) {
    console.warn(`[ironpay] Erro ao consultar transação ${hashOrId}:`, e.message);
    return null;
  }
}

/**
 * Verifica se a cobrança foi paga na IronPay
 */
async function isChargePaid({ transactionId, externalId }) {
  const targetId = transactionId || externalId;
  if (!targetId) return { paid: false, found: false, tx: null };
  try {
    const tx = await consultTransaction(targetId);
    if (!tx) return { paid: false, found: false, tx: null };
    const status = String(tx.payment_status || tx.status || '').toLowerCase();
    const paid = ['paid', 'pago', 'completed', 'approved'].includes(status);
    return { paid, found: true, status, tx };
  } catch (e) {
    console.warn(`[ironpay] Erro ao verificar pagamento ${targetId}:`, e.message);
    return { paid: false, found: false, error: e.message };
  }
}

/**
 * Valida as credenciais e consulta o saldo da conta na IronPay
 */
async function verifyCredentials() {
  const token = getApiToken();
  const base = getBaseUrl();

  try {
    const res = await fetch(`${base}/balance?api_token=${token}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const json = await res.json();
    return {
      ok: true,
      balance: json,
      tokenPrefix: token.slice(0, 10) + '...',
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Retorna o saldo da conta na IronPay
 */
async function balance() {
  const token = getApiToken();
  const base = getBaseUrl();

  const res = await fetch(`${base}/balance?api_token=${token}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new IronpayError(`Erro ao consultar saldo IronPay: HTTP ${res.status}`, { status: res.status });
  }
  return res.json();
}

module.exports = {
  createPixCharge,
  consultTransaction,
  isChargePaid,
  verifyCredentials,
  balance,
  IronpayError,
};
