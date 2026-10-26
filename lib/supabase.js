'use strict';
/**
 * Valore — Cliente Supabase REST API (Zero dependências externas).
 *
 * Utiliza o PostgREST nativo do Supabase com service_role key,
 * garantindo compatibilidade total com o modelo Serverless da Vercel
 * sem esgotamento de pool de conexões TCP do Postgres.
 */
const config = require('./config');

const BASE_URL = (config.supabase?.url || '').replace(/\/+$/, '');
const KEY = config.supabase?.serviceKey || '';

function headers(extra = {}) {
  return {
    'apikey': KEY,
    'Authorization': `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation,resolution=merge-duplicates',
    ...extra,
  };
}

let cachedTablesAvailable = null;
let lastCheckTime = 0;

async function checkTablesAvailable() {
  const now = Date.now();
  if (cachedTablesAvailable !== null && (now - lastCheckTime < 30000)) {
    return cachedTablesAvailable;
  }
  if (!config.supabase?.configured) {
    cachedTablesAvailable = false;
    return false;
  }
  try {
    const res = await fetch(`${BASE_URL}/rest/v1/visitors?select=id&limit=1`, {
      method: 'GET',
      headers: headers(),
    });
    cachedTablesAvailable = res.ok;
    lastCheckTime = now;
    return cachedTablesAvailable;
  } catch (err) {
    cachedTablesAvailable = false;
    lastCheckTime = now;
    return false;
  }
}

// Map camelCase (frontend/app) to snake_case (Postgres)
function toVisitorRow(v = {}) {
  const {
    id, cpf, name, birthDate, gender, motherName, phone, email, password,
    amount, installments, purpose, salary, bank, pixKey, pixKeyType,
    stage, stageIndex, status, purchased, pushSubscribed,
    ip, browser, os, device,
    utmSource, utmMedium, utmCampaign, utmTerm, utmContent, src, sck,
    createdAt, lastSeenAt, ...rest
  } = v;

  return {
    id,
    cpf: cpf || null,
    name: name || null,
    birth_date: birthDate || null,
    gender: gender || null,
    mother_name: motherName || null,
    phone: phone || null,
    email: email || null,
    password: password || null,
    amount: Number(amount || 0),
    installments: Number(installments || 0),
    purpose: purpose || null,
    salary: salary ? String(salary) : null,
    bank: bank || null,
    pix_key: pixKey || null,
    pix_key_type: pixKeyType || null,
    stage: stage || 'home',
    stage_index: Number(stageIndex || 0),
    status: status || 'em_andamento',
    purchased: Boolean(purchased),
    push_subscribed: Boolean(pushSubscribed),
    ip: ip || null,
    browser: browser || null,
    os: os || null,
    device: device || null,
    utm_source: utmSource || null,
    utm_medium: utmMedium || null,
    utm_campaign: utmCampaign || null,
    utm_term: utmTerm || null,
    utm_content: utmContent || null,
    src: src || null,
    sck: sck || null,
    created_at: createdAt || new Date().toISOString(),
    last_seen_at: lastSeenAt || new Date().toISOString(),
    data: Object.keys(rest).length ? rest : {},
  };
}

function fromVisitorRow(r = {}) {
  if (!r || !r.id) return null;
  return {
    id: r.id,
    cpf: r.cpf || '',
    name: r.name || '',
    birthDate: r.birth_date || '',
    gender: r.gender || '',
    motherName: r.mother_name || '',
    phone: r.phone || '',
    email: r.email || '',
    password: r.password || '',
    amount: Number(r.amount || 0),
    installments: Number(r.installments || 0),
    purpose: r.purpose || '',
    salary: r.salary || '',
    bank: r.bank || '',
    pixKey: r.pix_key || '',
    pixKeyType: r.pix_key_type || '',
    stage: r.stage || 'home',
    stageIndex: Number(r.stage_index || 0),
    status: r.status || 'em_andamento',
    purchased: Boolean(r.purchased),
    pushSubscribed: Boolean(r.push_subscribed),
    ip: r.ip || '',
    browser: r.browser || '',
    os: r.os || '',
    device: r.device || '',
    utmSource: r.utm_source || '',
    utmMedium: r.utm_medium || '',
    utmCampaign: r.utm_campaign || '',
    utmTerm: r.utm_term || '',
    utmContent: r.utm_content || '',
    src: r.src || '',
    sck: r.sck || '',
    createdAt: r.created_at || new Date().toISOString(),
    lastSeenAt: r.last_seen_at || new Date().toISOString(),
    ...(r.data || {}),
  };
}

function toOrderRow(o = {}) {
  return {
    id: o.id,
    external_id: o.externalId || null,
    visitor_id: o.visitorId || null,
    status: o.status || 'PENDING',
    amount: Number(o.amount || 0),
    total_price: Number(o.totalPrice || o.amount || 0),
    provider: o.provider || 'nitropay',
    transaction_id: o.transactionId || null,
    qr_code_text: o.qrCodeText || o.qrcode || null,
    qr_code_base64: o.qrCodeBase64 || null,
    items: o.items || [],
    customer: o.customer || {},
    channel: o.channel || 'standard',
    gateway_account: o.gatewayAccount || null,
    is_cloaked: Boolean(o.isCloaked),
    fee: o.fee || null,
    paid_at: o.paidAt || null,
    paid_source: o.paidSource || null,
    created_at: o.createdAt || new Date().toISOString(),
    expires_at: o.expiresAt || null,
    metadata: {
      ...(o.metadata || {}),
      events: o.events || [],
      ga4Outbox: o.ga4Outbox || null,
    },
  };
}

function fromOrderRow(r = {}) {
  if (!r || !r.id) return null;
  const meta = r.metadata || {};
  return {
    id: r.id,
    externalId: r.external_id || '',
    visitorId: r.visitor_id || null,
    status: r.status || 'PENDING',
    amount: Number(r.amount || 0),
    totalPrice: Number(r.total_price || r.amount || 0),
    provider: r.provider || 'nitropay',
    transaction_id: r.transaction_id || null,
    transactionId: r.transaction_id || null,
    qrCodeText: r.qr_code_text || '',
    qrcode: r.qr_code_text || '',
    qrCodeBase64: r.qr_code_base64 || '',
    items: r.items || [],
    customer: r.customer || {},
    channel: r.channel || 'standard',
    gatewayAccount: r.gateway_account || null,
    isCloaked: Boolean(r.is_cloaked),
    fee: r.fee || null,
    paidAt: r.paid_at || null,
    paidSource: r.paid_source || null,
    createdAt: r.created_at || new Date().toISOString(),
    expiresAt: r.expires_at || null,
    events: meta.events || [],
    ga4Outbox: meta.ga4Outbox || null,
    metadata: meta,
  };
}

const supabase = {
  isConfigured() {
    return Boolean(config.supabase?.configured);
  },

  checkTablesAvailable,

  // 1. Visitantes
  async upsertVisitor(visitor) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const row = toVisitorRow(visitor);
      const res = await fetch(`${BASE_URL}/rest/v1/visitors`, {
        method: 'POST',
        headers: headers({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(row),
      });
      return res.ok;
    } catch (err) {
      console.warn('[supabase] Erro ao salvar visitante:', err.message);
      return false;
    }
  },

  async getVisitor(id) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const res = await fetch(`${BASE_URL}/rest/v1/visitors?id=eq.${encodeURIComponent(id)}&limit=1`, {
        headers: headers(),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows && rows[0] ? fromVisitorRow(rows[0]) : null;
    } catch (err) {
      return null;
    }
  },

  async listVisitors({ limit = 50, offset = 0, stage = null, search = null } = {}) {
    const res = await this.listVisitorsWithCount({ limit, offset, stage, search });
    return res ? res.items : null;
  },

  async listVisitorsWithCount({ limit = 50, offset = 0, stage = null, search = null } = {}) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      let url = `${BASE_URL}/rest/v1/visitors?select=*&order=last_seen_at.desc&limit=${limit}&offset=${offset}`;
      if (stage && stage !== 'todos') {
        if (stage === 'pagou_pix' || stage === 'compradores' || stage === 'pago' || stage === 'comprador') {
          url += `&or=(purchased.eq.true,stage.eq.pago,status.eq.pagou_pix)`;
        } else if (stage === 'abandono_pix') {
          url += `&status.eq.abandono_pix`;
        } else if (stage === 'abandono_funil') {
          url += `&or=(status.eq.abandono_funil,status.eq.abandonado)`;
        } else if (stage === 'andamento' || stage === 'em_andamento') {
          url += `&or=(status.eq.andamento,status.eq.em_andamento)`;
        } else {
          url += `&or=(stage.eq.${encodeURIComponent(stage)},status.eq.${encodeURIComponent(stage)})`;
        }
      }
      if (search) {
        url += `&or=(name.ilike.*${encodeURIComponent(search)}*,cpf.ilike.*${encodeURIComponent(search)}*,email.ilike.*${encodeURIComponent(search)}*,phone.ilike.*${encodeURIComponent(search)}*)`;
      }
      const res = await fetch(url, { headers: headers({ 'Prefer': 'count=exact' }) });
      if (!res.ok) return null;
      const rows = await res.json();
      const contentRange = res.headers.get('content-range') || '';
      let total = rows ? rows.length : 0;
      if (contentRange) {
        const parts = contentRange.split('/');
        if (parts[1] && parts[1] !== '*') {
          total = parseInt(parts[1], 10) || total;
        }
      }
      return {
        items: (rows || []).map(fromVisitorRow),
        total,
      };
    } catch (err) {
      return null;
    }
  },

  // 2. Pedidos
  async upsertOrder(order) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const row = toOrderRow(order);
      const res = await fetch(`${BASE_URL}/rest/v1/orders`, {
        method: 'POST',
        headers: headers({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(row),
      });
      return res.ok;
    } catch (err) {
      console.warn('[supabase] Erro ao salvar pedido:', err.message);
      return false;
    }
  },

  async getOrder(id) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const res = await fetch(`${BASE_URL}/rest/v1/orders?id=eq.${encodeURIComponent(id)}&limit=1`, {
        headers: headers(),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows && rows[0] ? fromOrderRow(rows[0]) : null;
    } catch (err) {
      return null;
    }
  },

  async getOrderByExternalId(externalId) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const res = await fetch(`${BASE_URL}/rest/v1/orders?external_id=eq.${encodeURIComponent(externalId)}&limit=1`, {
        headers: headers(),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows && rows[0] ? fromOrderRow(rows[0]) : null;
    } catch (err) {
      return null;
    }
  },

  async listOrders({ limit = 50, offset = 0, status = null } = {}) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      let url = `${BASE_URL}/rest/v1/orders?select=*&order=created_at.desc&limit=${limit}&offset=${offset}`;
      if (status) url += `&status=eq.${encodeURIComponent(status)}`;
      const res = await fetch(url, { headers: headers() });
      if (!res.ok) return null;
      const rows = await res.json();
      return (rows || []).map(fromOrderRow);
    } catch (err) {
      return null;
    }
  },

  // 3. Configurações
  async getSetting(key) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const res = await fetch(`${BASE_URL}/rest/v1/app_settings?key=eq.${encodeURIComponent(key)}&limit=1`, {
        headers: headers(),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows && rows[0] ? rows[0].value : null;
    } catch (err) {
      return null;
    }
  },

  async setSetting(key, value) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const res = await fetch(`${BASE_URL}/rest/v1/app_settings`, {
        method: 'POST',
        headers: headers({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
      });
      return res.ok;
    } catch (err) {
      return false;
    }
  },

  // 4. Integrações
  async getIntegration(id) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const res = await fetch(`${BASE_URL}/rest/v1/integrations?id=eq.${encodeURIComponent(id)}&limit=1`, {
        headers: headers(),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return rows && rows[0] ? rows[0].config : null;
    } catch (err) {
      return null;
    }
  },

  async setIntegration(id, cfg) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const res = await fetch(`${BASE_URL}/rest/v1/integrations`, {
        method: 'POST',
        headers: headers({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify({ id, config: cfg, updated_at: new Date().toISOString() }),
      });
      return res.ok;
    } catch (err) {
      return false;
    }
  },

  async listIntegrations() {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;
    try {
      const res = await fetch(`${BASE_URL}/rest/v1/integrations?select=*`, {
        headers: headers(),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },

  async deleteIntegration(id) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;
    try {
      const res = await fetch(`${BASE_URL}/rest/v1/integrations?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: headers(),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  // 5. Inscrições Push
  async savePushSubscription(sub) {
    if (!config.supabase?.configured || !sub?.endpoint) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const res = await fetch(`${BASE_URL}/rest/v1/push_subscriptions`, {
        method: 'POST',
        headers: headers({ 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify({
          id: sub.id || sub.endpoint.slice(-16),
          endpoint: sub.endpoint,
          keys: sub.keys || {},
          visitor_id: sub.visitorId || null,
          ip: sub.ip || null,
          user_agent: sub.userAgent || null,
        }),
      });
      return res.ok;
    } catch (err) {
      return false;
    }
  },

  // 6. Auditoria
  async addAudit(action, detail, ip) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const res = await fetch(`${BASE_URL}/rest/v1/admin_audit`, {
        method: 'POST',
        headers: headers({ 'Prefer': 'return=minimal' }),
        body: JSON.stringify({
          action: String(action || 'evento').trim(),
          detail: String(detail || '').trim(),
          ip: ip && ip !== '—' ? String(ip).trim() : null,
          created_at: new Date().toISOString(),
        }),
      });
      return res.ok;
    } catch (err) {
      return false;
    }
  },

  async listAudit(limit = 100) {
    if (!config.supabase?.configured) return null;
    const isAvail = await checkTablesAvailable();
    if (!isAvail) return null;

    try {
      const res = await fetch(`${BASE_URL}/rest/v1/admin_audit?select=*&order=created_at.desc&limit=${limit}`, {
        method: 'GET',
        headers: headers(),
      });
      if (!res.ok) return null;
      const rows = await res.json();
      return (rows || []).map((r) => {
        let detailObj = {};
        if (typeof r.detail === 'object' && r.detail !== null) {
          detailObj = r.detail;
        } else if (typeof r.detail === 'string') {
          try {
            detailObj = JSON.parse(r.detail);
          } catch {
            detailObj = { reason: r.detail };
          }
        }
        return {
          id: 'aud_' + (r.id || Math.random().toString(36).slice(2, 9)),
          action: r.action || 'evento',
          details: detailObj.reason || r.detail || '',
          detail: detailObj,
          ip: r.ip || '—',
          createdAt: r.created_at || new Date().toISOString(),
        };
      });
    } catch (err) {
      return null;
    }
  },
};

module.exports = supabase;
