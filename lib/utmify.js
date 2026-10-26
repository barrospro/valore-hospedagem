'use strict';
/**
 * Integração Oficial com a API de Vendas da UTMify
 * Documentação: https://docs.utmify.com.br/
 * Endpoint: POST https://api.utmify.com.br/api-credentials/orders
 *
 * REQUISITO: Recebe e envia informações APENAS do gateway Quantum Pay.
 */
const config = require('./config');
const store = require('./store');

const UTMIFY_API_URL = 'https://api.utmify.com.br/api-credentials/orders';

/** Formata data para o padrão exigido pela UTMify: YYYY-MM-DD HH:MM:SS (UTC 0) */
function formatUtmifyDate(d) {
  if (!d) return null;
  const date = typeof d === 'string' || typeof d === 'number' ? new Date(d) : d;
  if (isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  const YYYY = date.getUTCFullYear();
  const MM = pad(date.getUTCMonth() + 1);
  const DD = pad(date.getUTCDate());
  const HH = pad(date.getUTCHours());
  const mm = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  return `${YYYY}-${MM}-${DD} ${HH}:${mm}:${ss}`;
}

/**
 * Envia pedido para a UTMify
 * @param {Object} order - Objeto do pedido da store
 * @param {Object} options - { status: 'waiting_payment' | 'paid', visitor, isTest }
 */
async function sendOrder(order, { status = 'waiting_payment', visitor = null, isTest = false } = {}) {
  if (!config.utmify?.configured) {
    return { skipped: true, reason: 'utmify_not_configured' };
  }

  if (!order) {
    return { skipped: true, reason: 'missing_order' };
  }

  // Permite transações da NitroPay, QuantumPay e BSPay
  const isAllowedGateway = order.provider === 'nitropay' || order.provider === 'quantumpay' || order.provider === 'bspay' || (order.provider === 'pending' && !order.gatewayAccount);
  if (!isAllowedGateway || order.isCloaked || order.channel === 'cloaked') {
    return { skipped: true, reason: 'not_allowed_gateway_or_cloaked' };
  }

  // Previne disparo duplicado de pagamento confirmado
  if (status === 'paid') {
    if (order.utmifyPaidNotified) {
      return { skipped: true, reason: 'already_notified_paid' };
    }
    store.updateOrder(order.id, { utmifyPaidNotified: true });
  }

  const items = Array.isArray(order.items) && order.items.length ? order.items : [
    { id: 'seguro-basico', name: 'Seguro Prestamista', price: order.amount || 27.97 },
  ];

  const products = items.map((i) => ({
    id: String(i.id || 'produto'),
    name: String(i.name || 'Produto'),
    planId: null,
    planName: null,
    quantity: 1,
    priceInCents: Math.round(Number(i.price || 0) * 100),
  }));

  const totalPriceInCents = Math.round(Number(order.amount || order.totalPrice || 0) * 100);
  const gatewayFeeInCents = Math.round(Number(order.fee || 0) * 100);
  const userCommissionInCents = Math.max(0, totalPriceInCents - gatewayFeeInCents);

  const customer = order.customer || {};
  const cleanPhone = String(customer.phone || customer.celular || visitor?.phone || '').replace(/\D/g, '');
  const cleanDoc = String(customer.document || customer.cpf || visitor?.cpf || '').replace(/\D/g, '');

  const createdAt = formatUtmifyDate(order.createdAt || Date.now());
  const approvedDate = status === 'paid' ? formatUtmifyDate(order.paidAt || Date.now()) : null;
  const platform = order.provider === 'nitropay' ? 'NitroPay' : (order.provider === 'bspay' ? 'BSPAY' : 'QuantumPay');

  const payload = {
    orderId: String(order.externalId || order.id),
    platform,
    paymentMethod: 'pix',
    status, // 'waiting_payment' ou 'paid'
    createdAt,
    approvedDate,
    refundedAt: null,
    customer: {
      name: String(customer.name || visitor?.name || 'Cliente').trim(),
      email: String(customer.email || visitor?.email || 'cliente@valore.com.br').trim(),
      phone: cleanPhone || null,
      document: cleanDoc || null,
      country: 'BR',
      ip: order.ip || visitor?.ip || '127.0.0.1',
    },
    products,
    trackingParameters: {
      src: visitor?.src || null,
      sck: visitor?.sck || null,
      utm_source: visitor?.utmSource || null,
      utm_campaign: visitor?.utmCampaign || null,
      utm_medium: visitor?.utmMedium || null,
      utm_content: visitor?.utmContent || null,
      utm_term: visitor?.utmTerm || null,
    },
    commission: {
      totalPriceInCents,
      gatewayFeeInCents,
      userCommissionInCents,
      currency: 'BRL',
    },
    isTest: !!isTest,
  };

  try {
    const res = await fetch(UTMIFY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': config.utmify.apiToken,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && (data.OK || data.result === 'SUCCESS')) {
      console.log(`[utmify] Pedido ${payload.orderId} (${payload.platform}) enviado com sucesso [status: ${status}]`);
      return { ok: true, data };
    }
    console.warn(`[utmify] Resposta da UTMify (${res.status}):`, data);
    return { ok: false, status: res.status, data };
  } catch (err) {
    console.error(`[utmify] Falha ao enviar pedido ${order.id} para a UTMify:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Valida a conexão com a API da UTMify enviando um payload de teste (isTest: true).
 */
async function testConnection(tokenOverride = null) {
  const rawToken = tokenOverride ?? store.getIntegrations()?.utmify?.token ?? config.utmify?.apiToken;
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token || token.length < 10) {
    return { ok: false, error: 'Token de API da UTMify não preenchido ou inválido. Insira a credencial de API gerada no painel da UTMify.' };
  }

  const payload = {
    orderId: 'valore-test-' + Date.now(),
    platform: 'NitroPay',
    paymentMethod: 'pix',
    status: 'waiting_payment',
    createdAt: formatUtmifyDate(new Date()),
    approvedDate: null,
    refundedAt: null,
    customer: {
      name: 'Validação UTMify',
      email: 'admin@valorebrasil.app',
      phone: '11999999999',
      document: '51095324861',
      country: 'BR',
      ip: '127.0.0.1',
    },
    products: [
      {
        id: 'teste-conexao',
        name: 'Validação de Conexão UTMify',
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: 100,
      },
    ],
    trackingParameters: {
      src: 'admin-test',
      sck: null,
      utm_source: 'admin',
      utm_campaign: null,
      utm_medium: null,
      utm_content: null,
      utm_term: null,
    },
    commission: {
      totalPriceInCents: 100,
      gatewayFeeInCents: 0,
      userCommissionInCents: 100,
      currency: 'BRL',
    },
    isTest: true,
  };

  const t0 = Date.now();
  try {
    const res = await fetch(UTMIFY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': token,
      },
      body: JSON.stringify(payload),
    });

    const elapsedMs = Date.now() - t0;
    const data = await res.json().catch(() => ({}));

    if (res.ok && (data.OK || data.result === 'SUCCESS')) {
      return {
        ok: true,
        elapsedMs,
        status: res.status,
        message: `Token validado com sucesso na UTMify! Conexão operacional (${elapsedMs}ms).`,
      };
    }

    const errMsg = data.message || (res.status === 401 ? 'Token inválido ou não autorizado pela UTMify.' : `Erro da API da UTMify (HTTP ${res.status})`);
    return {
      ok: false,
      elapsedMs,
      status: res.status,
      error: errMsg,
      details: data,
    };
  } catch (err) {
    return {
      ok: false,
      elapsedMs: Date.now() - t0,
      error: err.message || 'Falha de comunicação com a API da UTMify.',
    };
  }
}

module.exports = {
  sendOrder,
  testConnection,
  notifyPixGenerated: (order, visitor) => sendOrder(order, { status: 'waiting_payment', visitor }),
  notifyPixPaid: (order, visitor) => sendOrder(order, { status: 'paid', visitor }),
};
