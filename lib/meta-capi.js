'use strict';
/**
 * Integração server-side com a Meta Conversions API (CAPI).
 * Envia eventos de conversão (Purchase, Lead, InitiateCheckout) diretamente
 * do backend para a Meta (Graph API v20.0), garantindo entrega 100% à prova de
 * adblockers, abas fechadas e restrições de cookies/iOS.
 */
const crypto = require('crypto');
const config = require('./config');

const sha256 = (val) => {
  if (!val) return undefined;
  const s = String(val).trim().toLowerCase();
  if (!s) return undefined;
  return crypto.createHash('sha256').update(s).digest('hex');
};

const cleanDigits = (val) => String(val || '').replace(/\D/g, '');

function formatUserData(user = {}) {
  const data = {
    country: [sha256('br')],
  };

  if (user.ip) data.client_ip_address = user.ip;
  if (user.userAgent) data.client_user_agent = user.userAgent;

  if (user.email) {
    const em = sha256(user.email);
    if (em) data.em = [em];
  }

  if (user.phone || user.celular) {
    let p = cleanDigits(user.phone || user.celular);
    if (p.length === 10 || p.length === 11) p = '55' + p;
    if (p.length >= 12) {
      const ph = sha256(p);
      if (ph) data.ph = [ph];
    }
  }

  if (user.name || user.nome) {
    const parts = String(user.name || user.nome).trim().split(/\s+/);
    if (parts.length > 0) {
      const fn = sha256(parts[0]);
      if (fn) data.fn = [fn];
      if (parts.length > 1) {
        const ln = sha256(parts.slice(1).join(' '));
        if (ln) data.ln = [ln];
      }
    }
  }

  const city = user.city || user.cidade || (user.endereco && user.endereco.cidade);
  if (city) {
    const ct = sha256(city);
    if (ct) data.ct = [ct];
  }

  const state = user.state || user.uf || (user.endereco && user.endereco.uf);
  if (state) {
    const st = sha256(state);
    if (st) data.st = [st];
  }

  const zip = user.zip || user.cep || (user.endereco && user.endereco.cep);
  if (zip) {
    const zp = sha256(cleanDigits(zip));
    if (zp) data.zp = [zp];
  }

  return data;
}

/**
 * Envia um ou mais eventos para todos os pixels configurados.
 */
async function sendEvents(events) {
  if (!config.meta.configured || !events || !events.length) return null;

  const pixelIds = config.meta.pixelIds;
  const pixelTokens = config.meta.pixelTokens || {};
  const pool = (config.meta.accessTokens && config.meta.accessTokens.length)
    ? config.meta.accessTokens
    : [config.meta.accessToken].filter(Boolean);
  const results = [];

  for (const pixelId of pixelIds) {
    const preferredToken = pixelTokens[pixelId];
    const candidateTokens = [preferredToken, ...pool.filter((t) => t !== preferredToken)].filter(Boolean);

    let sent = false;
    let lastJson = null;
    let lastError = null;

    for (const token of candidateTokens) {
      try {
        const url = `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${token}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: events }),
        });
        const json = await res.json();
        lastJson = json;

        if (res.ok) {
          pixelTokens[pixelId] = token;
          results.push({ pixelId, success: true, data: json });
          sent = true;
          break;
        } else {
          const code = json?.error?.code;
          if (candidateTokens.length > 1 && (code === 100 || code === 190 || code === 200 || res.status === 400 || res.status === 401 || res.status === 403)) {
            continue;
          } else {
            break;
          }
        }
      } catch (e) {
        lastError = e.message;
      }
    }

    if (!sent) {
      console.warn(`[meta-capi] erro ao enviar para o pixel ${pixelId}:`, lastJson ? JSON.stringify(lastJson) : lastError);
      results.push({ pixelId, success: false, data: lastJson, error: lastError });
    }
  }

  return results;
}

/**
 * Envia evento Purchase server-side.
 */
async function sendPurchase(order, visitor = {}, custom = {}) {
  const amount = Number(order.amount || order.totalPrice || 0);
  const orderId = order.id || order.externalId;
  const eventTime = custom.eventTime || Math.floor(Date.now() / 1000);

  const payload = {
    event_name: 'Purchase',
    event_time: eventTime,
    action_source: 'website',
    event_id: orderId, // mesmo ID usado no browser para deduplicação automática
    event_source_url: config.publicBaseUrl || undefined,
    user_data: formatUserData({ ...visitor, ...custom.userData }),
    custom_data: {
      currency: 'BRL',
      value: amount,
      order_id: orderId,
      content_name: order.productName || order.description || 'Simulação Empréstimo',
      content_ids: [orderId],
      content_type: 'product',
    },
  };

  return sendEvents([payload]);
}

module.exports = {
  sendEvents,
  sendPurchase,
  formatUserData,
  sha256,
};
