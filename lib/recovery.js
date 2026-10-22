'use strict';
/**
 * Módulo de Automação de Notificações de Recuperação de Vendas e Conversão de Funil.
 *
 * Realiza varreduras inteligentes na base de visitantes e ordens pendentes:
 * 1. Recuperação de PIX gerado pendente (10-15 min após emissão sem pagamento).
 * 2. Recuperação de abandono de etapas do funil (30-60 min após inatividade).
 * 3. Última chamada / urgência (24h após abandono).
 *
 * Proteções:
 * - Cancela e nunca envia se o cliente já realizou a compra (purchased: true ou ordem COMPLETED).
 * - Deduplicação rigorosa (anti-spam) por visitante e por regra.
 * - Suporta link de retomada mágica (/recuperar/:id) com dados pré-preenchidos.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const pushService = require('./push');
const pushAdmin = require('./push-admin');

const LOG_FILE = path.join(config.dataDir, 'push_recovery_log.json');

let logCache = null;

function loadRecoveryLog() {
  if (logCache) return logCache;
  try {
    if (fs.existsSync(LOG_FILE)) {
      logCache = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    } else {
      logCache = {};
    }
  } catch {
    logCache = {};
  }
  return logCache;
}

function saveRecoveryLog() {
  if (!logCache) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.writeFileSync(LOG_FILE, JSON.stringify(logCache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[recovery] Falha ao persistir log de recuperação:', e.message);
  }
}

/**
 * Localiza dados do visitante para preenchimento automático na rota /recuperar/:id.
 */
function findVisitorForRecovery(id) {
  if (!id) return { found: false };
  const d = store.load();

  // 1. Busca direta por visitorId
  let v = d.visitors ? d.visitors[id] : null;

  // 2. Busca por orderId caso id seja uma ordem
  if (!v && d.orders && d.orders[id]) {
    const o = d.orders[id];
    if (o.visitorId && d.visitors[o.visitorId]) {
      v = d.visitors[o.visitorId];
    } else if (o.customer) {
      // Reconstrói visitante a partir dos dados do customer da ordem
      v = {
        id: o.visitorId || id,
        name: o.customer.name || '',
        cpf: o.customer.document || '',
        phone: o.customer.phone || '',
        email: o.customer.email || '',
        amount: o.amount || 10000,
        stage: 'pagamento',
      };
    }
  }

  // 3. Busca por externalId da ordem
  if (!v && d.orders) {
    const o = Object.values(d.orders).find((item) => item.externalId === id);
    if (o && o.visitorId && d.visitors[o.visitorId]) {
      v = d.visitors[o.visitorId];
    }
  }

  if (!v) {
    return { found: false };
  }

  const stage = (v.stage || 'valor').trim();
  return {
    found: true,
    visitor: {
      id: v.id,
      cpf: v.cpf || '',
      name: v.name || '',
      birthDate: v.birthDate || '',
      gender: v.gender || '',
      motherName: v.motherName || '',
      phone: v.phone || '',
      email: v.email || '',
      amount: v.amount || 10000,
      installments: v.installments || 12,
      purpose: v.purpose || '',
      salary: v.salary || '',
      bank: v.bank || '',
      pixKey: v.pixKey || '',
      pixKeyType: v.pixKeyType || '',
      stage,
    },
    notificationId: id,
    stage,
  };
}

/**
 * Executa o fluxo automatizado de recuperação.
 * Analisa a base e dispara as mensagens necessárias para recuperar a venda.
 */
async function processAutomatedRecovery() {
  if (!config.push.configured) {
    return { ok: false, error: 'Push não configurado' };
  }

  const subscriptions = pushService.getSubscriptions();
  if (!subscriptions || subscriptions.length === 0) {
    return { ok: true, processed: 0, sent: 0, reason: 'Sem assinaturas ativas' };
  }

  const d = store.load();
  const visitors = d.visitors || {};
  const orders = Object.values(d.orders || {});
  const recoveryLog = loadRecoveryLog();

  const now = Date.now();
  let totalSent = 0;
  const stats = { pixPending: 0, funnelAbandoned: 0, lastChance: 0 };

  for (const sub of subscriptions) {
    let visitorId = sub.visitorId;
    let v = null;

    if (visitorId) {
      v = visitors[visitorId];
      if (!v && visitorId.startsWith('cpf_')) {
        const cleanCpf = visitorId.replace(/\D/g, '');
        v = Object.values(visitors).find((item) => (item.cpf || '').replace(/\D/g, '') === cleanCpf);
      }
    }

    // Se for assinante de teste ou sem visitante vinculado, envia aviso de ativação/recuperação
    if (!v) {
      const fallbackKey = sub.endpoint.slice(-20);
      if (!recoveryLog[fallbackKey]) recoveryLog[fallbackKey] = {};
      const fLog = recoveryLog[fallbackKey];

      if (!fLog.pix_recovery_sent) {
        const payload = {
          title: 'Valore: Seu Crédito foi Liberado! 💳',
          body: 'Seu limite aprovado está disponível para transferência. Toque para resgatar seu saldo via PIX.',
          iconUrl: `${config.publicBaseUrl}/icon-192.png`,
          badgeUrl: `${config.publicBaseUrl}/badge-96.png`,
          targetUrl: '/retomar',
          data: { type: 'recovery_general' },
          tag: `valore-rec-${fallbackKey}`,
        };
        const res = await pushService.sendNotification(sub, payload);
        if (res.ok) {
          fLog.pix_recovery_sent = new Date().toISOString();
          stats.funnelAbandoned++;
          totalSent++;
        }
      }
      continue;
    }

    // Se o cliente já comprou, NUNCA enviar recuperação
    if (v.purchased) continue;

    // Verifica se possui alguma ordem concluída
    const hasPaidOrder = orders.some((o) => (o.visitorId === v.id || o.visitorId === visitorId) && o.status === 'COMPLETED');
    if (hasPaidOrder) {
      store.markPurchased(v.id);
      continue;
    }

    if (!recoveryLog[v.id]) {
      recoveryLog[v.id] = {};
    }
    const visitorLog = recoveryLog[v.id];

    // Nome para personalização amigável
    const firstName = v.name ? v.name.trim().split(' ')[0] : '';
    const formattedAmount = (v.amount || 10000).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

    // -------------------------------------------------------------
    // REGRA 1: PIX Gerado e Pendente (Entre 1 minuto e 24 horas)
    // -------------------------------------------------------------
    const pendingOrder = orders
      .filter((o) => (o.visitorId === v.id || o.visitorId === visitorId) && o.status === 'PENDING')
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    if (pendingOrder) {
      const orderAgeMs = now - new Date(pendingOrder.createdAt).getTime();
      const minAgeMs = 1 * 60 * 1000; // 1 minuto
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;

      if (orderAgeMs >= minAgeMs && orderAgeMs <= twentyFourHoursMs && !visitorLog.pix_pending) {
        const payload = {
          title: '⚠️ Seu PIX de liberação expira em breve!',
          body: firstName
            ? `${firstName}, seu limite aprovado aguarda o pagamento do PIX. Toque para copiar a chave e liberar agora.`
            : 'Seu limite aprovado aguarda o pagamento do PIX. Toque para copiar a chave e liberar seu crédito agora.',
          iconUrl: `${config.publicBaseUrl}/icon-192.png`,
          badgeUrl: `${config.publicBaseUrl}/badge-96.png`,
          targetUrl: `/recuperar/${v.id}?to=/retomar`,
          data: {
            type: 'pix_recovery',
            visitorId: v.id,
            orderId: pendingOrder.id,
          },
          tag: `pix-recovery-${pendingOrder.id}`,
        };

        const res = await pushService.sendNotification(sub, payload);
        if (res.ok) {
          visitorLog.pix_pending = new Date().toISOString();
          stats.pixPending++;
          totalSent++;
          continue; // Já enviou mensagem para este visitante nesta rodada
        }
      }
    }

    // -------------------------------------------------------------
    // REGRA 2: Abandono de Etapas no Funil (Entre 3 min e 20 horas)
    // -------------------------------------------------------------
    const lastActivityTime = new Date(v.lastSeenAt || v.createdAt || now).getTime();
    const idleMs = now - lastActivityTime;
    const minIdleMs = 3 * 60 * 1000; // 3 minutos
    const twentyHoursMs = 20 * 60 * 60 * 1000;

    if (idleMs >= minIdleMs && idleMs <= twentyHoursMs && !visitorLog.funnel_abandoned) {
      const payload = {
        title: 'Valore: Proposta de Crédito Aprovada! 💳',
        body: firstName
          ? `${firstName}, seu limite de R$ ${formattedAmount} está reservado. Toque aqui para liberar em menos de 2 minutos.`
          : `Seu limite de R$ ${formattedAmount} está reservado. Toque aqui para concluir seu cadastro e liberar o valor.`,
        iconUrl: `${config.publicBaseUrl}/icon-192.png`,
        badgeUrl: `${config.publicBaseUrl}/badge-96.png`,
        targetUrl: `/recuperar/${v.id}`,
        data: {
          type: 'funnel_recovery',
          visitorId: v.id,
        },
        tag: `funnel-recovery-${v.id}`,
      };

      const res = await pushService.sendNotification(sub, payload);
      if (res.ok) {
        visitorLog.funnel_abandoned = new Date().toISOString();
        stats.funnelAbandoned++;
        totalSent++;
        continue;
      }
    }

    // -------------------------------------------------------------
    // REGRA 3: Última Chamada / Urgência (Entre 12 horas e 48 horas)
    // -------------------------------------------------------------
    const minUrgencyMs = 12 * 60 * 60 * 1000; // 12 horas
    const fortyEightHoursMs = 48 * 60 * 60 * 1000;

    if (idleMs >= minUrgencyMs && idleMs <= fortyEightHoursMs && !visitorLog.last_chance) {
      const payload = {
        title: '🚨 Último Aviso: Proposta de Crédito',
        body: firstName
          ? `${firstName}, sua reserva de crédito será cancelada hoje. Toque para resgatar sua liberação antes que expire.`
          : 'Sua reserva de crédito será cancelada hoje. Toque para resgatar sua liberação antes que expire.',
        iconUrl: `${config.publicBaseUrl}/icon-192.png`,
        badgeUrl: `${config.publicBaseUrl}/badge-96.png`,
        targetUrl: `/recuperar/${v.id}`,
        data: {
          type: 'last_chance_recovery',
          visitorId: v.id,
        },
        tag: `last-chance-${v.id}`,
      };

      const res = await pushService.sendNotification(sub, payload);
      if (res.ok) {
        visitorLog.last_chance = new Date().toISOString();
        stats.lastChance++;
        totalSent++;
      }
    }
  }

  saveRecoveryLog();

  // Executa campanhas agendadas do painel push se houver alguma no horário
  let scheduledStats = null;
  try {
    scheduledStats = await pushAdmin.processScheduledCampaigns();
  } catch (err) {
    console.warn('[recovery] Falha ao processar campanhas agendadas:', err.message);
  }

  return {
    ok: true,
    processed: subscriptions.length,
    sent: totalSent,
    stats,
    scheduled: scheduledStats,
    executedAt: new Date().toISOString(),
  };
}

module.exports = {
  findVisitorForRecovery,
  processAutomatedRecovery,
};
