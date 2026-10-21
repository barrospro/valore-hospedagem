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

const CLOAKED_PRODUCTS = [
  'Curso Online de Gestão e Planejamento Financeiro',
  'Ebook Prático de Finanças Pessoais e Orçamento',
  'Consultoria Estratégica em Planejamento Financeiro',
  'Acesso Plataforma de Educação e Produtividade',
  'Assessoria e Consultoria Digital Financeira',
  'Treinamento Completo Gestão Orçamentária',
  'Pacote de Planilhas e Ferramentas Financeiras',
  'Guia Digital de Gestão Financeira Familiar',
];

function getRandomCloakedDescription() {
  return CLOAKED_PRODUCTS[Math.floor(Math.random() * CLOAKED_PRODUCTS.length)];
}

function getAuthHeader(account = 'primary') {
  const creds = account === 'secondary' ? config.nitropaySecondary : config.nitropay;
  const pk = creds?.publicKey;
  const sk = creds?.secretKey;
  if (!pk || !sk) {
    throw new NitropayError(`Credenciais da Nitro Pagamentos (${account}) não configuradas`, { code: 'MISSING_CREDENTIALS', status: 500 });
  }
  const token = Buffer.from(`${pk}:${sk}`).toString('base64');
  return `Basic ${token}`;
}

async function request(path = '', { method = 'GET', body = null, account = 'primary' } = {}) {
  const creds = account === 'secondary' ? config.nitropaySecondary : config.nitropay;
  const base = (creds?.apiBase || config.nitropay?.apiBase || 'https://api.nitropagamento.app').replace(/\/+$/, '');
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
    throw new NitropayError(`Falha de rede com Nitro Pagamentos (${account}): ${e.message}`, { code: 'NETWORK_ERROR', status: 502 });
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
    const msg = json?.message || json?.error || `Erro HTTP ${res.status} da Nitro Pagamentos (${account})`;
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
  account = 'primary',
} = {}) {
  const isCloaked = account === 'secondary';
  const cleanDoc = String(payer?.document || '').replace(/\D/g, '') || '57062194867';
  let cleanPhone = String(payer?.phone || payer?.celular || '').replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    cleanPhone = '11999999999';
  }
  const cleanName = String(payer?.name || '').trim() || 'Cliente';
  const cleanEmail = String(payer?.email || '').trim() || 'contato@cliente.com';

  const chosenDescription = isCloaked ? getRandomCloakedDescription() : (description || 'Serviços Financeiros');

  const payload = {
    amount: Number(Number(amount || 0).toFixed(2)),
    payment_method: 'pix',
    description: chosenDescription,
    customer: {
      name: cleanName,
      email: cleanEmail,
      document: cleanDoc,
      phone: cleanPhone,
    },
    metadata: {
      order_id: externalId,
      account,
    },
    postbackUrl: postbackUrl || config.nitropay.postbackUrl,
  };

  // Na conta indetectável, não envia identificação de empréstimo ou rota de pagamento de crédito
  if (!isCloaked) {
    payload.source_url = `${config.publicBaseUrl}/pagamento`;
    payload.source_label = 'Valore Oferta';
  } else {
    payload.source_label = 'Treinamentos Digitais';
  }

  const json = await request('', { method: 'POST', body: payload, account });
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
    account,
    description: chosenDescription,
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
    // Se falhar e a conta primária foi tentada, tenta a secundária como fallback
    if (account === 'primary' && config.nitropaySecondary?.enabled) {
      try {
        const json2 = await request(`transactions/${id}`, { method: 'GET', account: 'secondary' });
        const data2 = json2?.data || json2;
        if (data2 && data2.id && !String(data2.id).startsWith('integer')) {
          return data2;
        }
      } catch {}
    }
    return null;
  }
}

/** Verifica se a cobrança foi paga na Nitro Pagamentos */
async function isChargePaid({ transactionId, externalId, account = 'primary' }) {
  if (!transactionId) return { paid: false, found: false, tx: null };
  try {
    const tx = await consultTransaction(transactionId, account);
    if (!tx) return { paid: false, found: false, tx: null };
    const status = String(tx.status || '').toLowerCase();
    const paid = ['pago', 'paid', 'approved', 'confirmado'].includes(status);
    return { paid, found: true, status, tx };
  } catch (e) {
    console.warn(`[nitropay] erro ao consultar ${transactionId} (${account}):`, e.message);
    return { paid: false, found: false, error: e.message };
  }
}

module.exports = {
  createPixCharge,
  consultTransaction,
  isChargePaid,
  getRandomCloakedDescription,
  NitropayError,
};
