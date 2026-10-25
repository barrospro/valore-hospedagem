'use strict';
/**
 * Integração server-side com o Google Analytics 4 (Measurement Protocol).
 * Envia eventos de conversão (purchase, begin_checkout) diretamente do backend
 * para o GA4 via API oficial HTTP, completando a tarefa do Measurement Protocol.
 */
const crypto = require('crypto');
const config = require('./config');

const GA4_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
const GA4_DEBUG_ENDPOINT = 'https://www.google-analytics.com/debug/mp/collect';

/** Gera client_id determinístico no formato esperado pelo GA4 (ex: 1234567890.1234567890) */
function getClientId(visitor = {}, order = {}) {
  const raw = visitor.id || visitor.cpf || order.visitorId || order.id || String(Date.now());
  const hash = crypto.createHash('md5').update(String(raw)).digest('hex');
  const part1 = parseInt(hash.slice(0, 8), 16);
  const part2 = parseInt(hash.slice(8, 16), 16);
  return `${part1}.${part2}`;
}

/** Obtém user_id correspondente ao do frontend */
function getUserId(visitor = {}, order = {}) {
  const doc = (visitor.cpf || (visitor.visitor && visitor.visitor.cpf) || (order.customer && order.customer.cpf) || '').replace(/\D/g, '');
  if (doc.length === 11) return `usr_${doc}`;
  if (visitor.id) return String(visitor.id);
  return undefined;
}

/**
 * Envia evento para o Google Analytics 4 via Measurement Protocol
 */
async function sendEvent(eventName, params = {}, { visitor = {}, order = {}, debug = false } = {}) {
  const measurementId = config.ga4?.measurementId || process.env.GA4_MEASUREMENT_ID || 'G-3NGR6D3GKF';
  const apiSecret = config.ga4?.apiSecret || process.env.GA4_API_SECRET || '';

  if (!apiSecret) {
    return { skipped: true, reason: 'missing_api_secret', measurementId };
  }

  const clientId = getClientId(visitor, order);
  const userId = getUserId(visitor, order);

  const payload = {
    client_id: clientId,
    user_id: userId,
    events: [
      {
        name: eventName,
        params: {
          ...params,
          engagement_time_msec: 100,
        },
      },
    ],
  };

  const endpoint = debug ? GA4_DEBUG_ENDPOINT : GA4_ENDPOINT;
  const url = `${endpoint}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (debug) {
      const json = await res.json().catch(() => ({}));
      console.log('[ga4-mp] debug validation response:', json);
      return { success: res.ok, status: res.status, validation: json };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[ga4-mp] resposta inesperada do GA4 (${res.status}):`, text);
      return { success: false, status: res.status, error: text };
    }

    console.log(`[ga4-mp] evento '${eventName}' enviado com sucesso ao GA4 (${measurementId})`);
    return { success: true, status: res.status };
  } catch (err) {
    console.warn(`[ga4-mp] falha de conexão com o GA4:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Envia evento Purchase oficial do GA4
 */
async function sendPurchase(order, visitor = {}, custom = {}) {
  const amount = Number(order.amount || order.totalPrice || 27.97);
  const orderId = order.id || order.externalId;

  const items = Array.isArray(order.items) && order.items.length ? order.items.map(it => ({
    item_id: it.id || 'seguro-basico',
    item_name: it.name || 'Seguro Prestamista',
    price: Number(it.price || amount),
    quantity: 1,
  })) : [
    {
      item_id: order.productId || 'seguro-basico',
      item_name: order.productName || 'Seguro Prestamista Valore',
      price: amount,
      quantity: 1,
    },
  ];

  const params = {
    transaction_id: orderId,
    value: amount,
    currency: 'BRL',
    items,
    payment_type: 'PIX',
    affiliation: 'Valore',
  };

  return sendEvent('purchase', params, { visitor, order, debug: !!custom.debug });
}

module.exports = {
  sendEvent,
  sendPurchase,
  getClientId,
  getUserId,
};
