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

  // REGRA ESTRITA: Apenas transações originadas pelo gateway principal QuantumPay / BSPay (e nunca Nitro Oculta)
  const isAllowedGateway = order.provider === 'quantumpay' || order.provider === 'bspay' || (order.provider === 'pending' && !order.gatewayAccount);
  if (!isAllowedGateway || order.isCloaked || order.channel === 'cloaked' || order.gatewayAccount === 'secondary') {
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
  const platform = order.provider === 'bspay' ? 'BSPAY' : 'QuantumPay';

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

module.exports = {
  sendOrder,
  notifyPixGenerated: (order, visitor) => sendOrder(order, { status: 'waiting_payment', visitor }),
  notifyPixPaid: (order, visitor) => sendOrder(order, { status: 'paid', visitor }),
};
