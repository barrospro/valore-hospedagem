'use strict';
/**
 * Script de Sincronização Retroativa Completa: Quantum Pay -> UTMify
 * Varre todo o histórico da Quantum Pay com paginação por offset e envia
 * todas as vendas com status 'paid' diretamente para a UTMify.
 */
const qp = require('../lib/quantumpay');
const config = require('../lib/config');

const UTMIFY_API_URL = 'https://api.utmify.com.br/api-credentials/orders';

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

async function syncAllPastSales() {
  console.log('=== Buscando TODAS as vendas aprovadas na Quantum Pay ===');
  const token = await qp.getAuthToken();
  const base = config.quantumpay.apiBase;

  const paidMap = new Map();

  for (let offset = 0; offset <= 300; offset += 20) {
    const res = await fetch(`${base}/api/v1/transactions?offset=${offset}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const json = await res.json();
    const list = json.data || [];
    if (!list.length) break;

    for (const t of list) {
      if (['paid', 'pago', 'approved', 'completed'].includes(String(t.status).toLowerCase())) {
        if (!paidMap.has(t.id)) {
          paidMap.set(t.id, t);
        }
      }
    }

    if (list.length < 20) break;
  }

  const allPaid = Array.from(paidMap.values());
  console.log(`\nTotal de vendas aprovadas identificadas na Quantum Pay: ${allPaid.length}`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < allPaid.length; i++) {
    const t = allPaid[i];
    const details = await qp.consultTransaction(t.id).catch(() => null);
    const tx = details || t;

    const amountInCents = tx.amountInCents || (tx.amount > 100 ? tx.amount : Math.round(tx.amount * 100));
    const feesInCents = tx.fees || 0;
    const netInCents = tx.netAmount || Math.max(0, amountInCents - feesInCents);

    const email = tx.customer?.emails?.[0]?.email || tx.customer?.email || 'cliente@valore.com.br';
    const cleanPhone = String(tx.customer?.phone || '').replace(/\D/g, '');
    const cleanDoc = String(tx.customer?.document || '').replace(/\D/g, '');

    const payload = {
      orderId: String(tx.externalId || tx.id),
      platform: 'QuantumPay',
      paymentMethod: 'pix',
      status: 'paid',
      createdAt: formatUtmifyDate(tx.createdAt),
      approvedDate: formatUtmifyDate(tx.aprovedAt || tx.updatedAt || tx.createdAt),
      refundedAt: null,
      customer: {
        name: String(tx.customer?.name || 'Cliente').trim(),
        email: String(email).trim(),
        phone: cleanPhone || null,
        document: cleanDoc || null,
        country: 'BR',
        ip: '127.0.0.1',
      },
      products: [
        {
          id: String(tx.id),
          name: String(tx.description || 'Seguro Prestamista'),
          planId: null,
          planName: null,
          quantity: 1,
          priceInCents: amountInCents,
        },
      ],
      trackingParameters: {
        src: null,
        sck: null,
        utm_source: 'quantumpay_retroativo',
        utm_campaign: null,
        utm_medium: null,
        utm_content: null,
        utm_term: null,
      },
      commission: {
        totalPriceInCents: amountInCents,
        gatewayFeeInCents: feesInCents,
        userCommissionInCents: netInCents,
        currency: 'BRL',
      },
      isTest: false,
    };

    try {
      const uRes = await fetch(UTMIFY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-token': config.utmify.apiToken,
        },
        body: JSON.stringify(payload),
      });

      const uJson = await uRes.json().catch(() => ({}));
      if (uRes.ok && (uJson.OK || uJson.result === 'SUCCESS')) {
        console.log(`[${i + 1}/${allPaid.length}] ✅ Venda ${payload.orderId} (${payload.customer.name} - R$ ${(amountInCents / 100).toFixed(2)}) enviada com sucesso!`);
        success++;
      } else {
        console.warn(`[${i + 1}/${allPaid.length}] ⚠️ Venda ${payload.orderId} - Resposta UTMify:`, uJson);
        failed++;
      }
    } catch (e) {
      console.error(`[${i + 1}/${allPaid.length}] ❌ Falha na venda ${payload.orderId}:`, e.message);
      failed++;
    }

    // Pequena pausa de 120ms para respeitar limites de taxa da API da UTMify
    await new Promise((r) => setTimeout(r, 120));
  }

  console.log(`\n======================================================`);
  console.log(`Sincronização Finalizada!`);
  console.log(`Vendas enviadas com sucesso para a UTMify: ${success}`);
  if (failed > 0) console.log(`Falhas: ${failed}`);
  console.log(`======================================================\n`);
}

syncAllPastSales().catch((e) => console.error(e));
