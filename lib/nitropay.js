'use strict';
/**
 * Integração oficial com a API Nitro Pagamentos Hub (v2.0)
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

function getAuthHeader(account = 'primary') {
  let pk = config.nitropay?.publicKey;
  let sk = config.nitropay?.secretKey;
  if (account === 'secondary' || account === 'nitrogabriel' || account === 'NitroGabriel') {
    pk = config.nitropaySecondary?.publicKey;
    sk = config.nitropaySecondary?.secretKey;
  }
  if (!pk || !sk) {
    throw new NitropayError(`Credenciais da Nitro Pagamentos (${account}) não configuradas no painel`, { code: 'MISSING_CREDENTIALS', status: 500 });
  }
  const token = Buffer.from(`${pk}:${sk}`).toString('base64');
  return `Basic ${token}`;
}

async function request(path = '', { method = 'GET', body = null, account = 'primary' } = {}) {
  const base = (config.nitropay?.apiBase || 'https://api.nitropagamento.app').replace(/\/+$/, '');
  const url = path ? `${base}/${path.replace(/^\/+/, '')}` : base;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);

  let res;
  try {
    const opts = {
      method,
      headers: {
        Authorization: getAuthHeader(account),
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

/** Cria uma cobrança PIX oficial na Nitro Pagamentos */
async function createPixCharge({
  amount,
  externalId,
  description = 'Taxa de Emissão de Contrato - Valore',
  payer = {},
  postbackUrl = null,
  account = 'primary',
} = {}) {
  const cleanDoc = String(payer?.document || '').replace(/\D/g, '') || '57062194867';
  let cleanPhone = String(payer?.phone || payer?.celular || '').replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    cleanPhone = '11999999999';
  }
  const cleanName = String(payer?.name || '').trim() || 'Cliente';
  const cleanEmail = String(payer?.email || '').trim() || 'contato@cliente.com';

  const payload = {
    amount: Number(Number(amount || 0).toFixed(2)),
    payment_method: 'pix',
    description: description || 'Serviços Financeiros - Valore',
    source_url: `${config.publicBaseUrl}/checkout`,
    source_label: 'Valore Oferta',
    customer: {
      name: cleanName,
      email: cleanEmail,
      document: cleanDoc,
      phone: cleanPhone,
    },
    metadata: {
      order_id: externalId,
    },
    postbackUrl: postbackUrl || config.nitropay.postbackUrl || `${config.publicBaseUrl}/api/webhooks/nitropay`,
  };

  let json = null;
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      json = await request('', { method: 'POST', body: payload, account });
      break;
    } catch (e) {
      if (attempt < maxAttempts && (e.status >= 500 || e.code === 'NETWORK_ERROR' || String(e.message).includes('momento'))) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      throw e;
    }
  }
  const data = json?.data || json;

  const pixCode = data?.pix_code || '';
  let qrBase64 = data?.pix_qr_code || '';
  if (!qrBase64 && pixCode) {
    qrBase64 = qrimg.toBase64(pixCode);
  }

  const isSec = account === 'secondary' || account === 'nitrogabriel' || account === 'NitroGabriel';
  return {
    transactionId: data?.id || null,
    externalId: data?.external_ref || externalId,
    amount: data?.amount ?? amount,
    method: 'pix',
    qrcode: pixCode,
    qrCodeText: pixCode,
    pixCopiaECola: pixCode,
    qrCodeBase64: qrBase64,
    expiresAt: data?.expires_at || null,
    postbackUrl: payload.postbackUrl,
    provider: isSec ? 'nitropay_secondary' : 'nitropay',
    gatewayAccount: isSec ? 'NitroGabriel' : 'primary',
    isCloaked: isSec,
    description: payload.description,
    raw: json,
  };
}

/** Consulta o status de uma transação pelo ID */
async function consultTransaction(id, account = 'primary') {
  if (!id) return null;
  try {
    const json = await request(`transactions/${id}`, { method: 'GET', account });
    const data = json?.data || json;
    if (!data || data.name === 'Nitro Pagamentos HUB API' || !data.id || String(data.id).startsWith('integer')) {
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
}

/** Verifica se a cobrança foi paga na Nitro Pagamentos */
async function isChargePaid({ transactionId, externalId, account = 'primary' } = {}) {
  if (!transactionId) return { paid: false, found: false, tx: null };
  try {
    const tx = await consultTransaction(transactionId, account);
    if (!tx) return { paid: false, found: false, tx: null };
    const status = String(tx.status || '').toLowerCase();
    const paid = ['pago', 'paid', 'approved', 'confirmado'].includes(status);
    return { paid, found: true, status, tx };
  } catch (e) {
    console.warn(`[nitropay] erro ao consultar ${transactionId}:`, e.message);
    return { paid: false, found: false, error: e.message };
  }
}

/** Valida as credenciais da conta consultando os dados da empresa via GET /?empresa */
async function verifyCredentials(account = 'primary') {
  try {
    const json = await request('?empresa', { method: 'GET', account });
    const data = json?.data || json;
    if (data && (data.status === 'aprovado' || data.nome_empresa)) {
      return {
        ok: true,
        empresa: data.nome_empresa || null,
        cnpj: data.cnpj || null,
        cpf: data.cpf || null,
        status: data.status || 'aprovado',
        email: data.email || null,
        codigoCliente: data.codigo_cliente || null,
        data,
      };
    }
    return { ok: false, error: 'Dados da empresa não encontrados na Nitro', data };
  } catch (e) {
    return { ok: false, error: e.message, status: e.status || 500 };
  }
}

module.exports = {
  verifyCredentials,
  createPixCharge,
  consultTransaction,
  isChargePaid,
  NitropayError,
};
