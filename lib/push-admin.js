'use strict';
/**
 * Gerenciamento de Campanhas, Modelos (Templates), Segmentos (Grupos),
 * Execuções de Disparo e Links/Mídias para o Painel /push.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./store');
const pushService = require('./push');
const supabase = require('./supabase');

const FILE_TEMPLATES = path.join(config.dataDir, 'push_templates.json');
const FILE_GROUPS = path.join(config.dataDir, 'push_groups.json');
const FILE_EXECUTIONS = path.join(config.dataDir, 'push_executions.json');
const FILE_SETTINGS = path.join(config.dataDir, 'push_settings.json');
const FILE_LINKS = path.join(config.dataDir, 'push_links.json');
const FILE_MEDIA = path.join(config.dataDir, 'push_media.json');

function readJsonFile(filePath, defaultVal) {
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed !== null && parsed !== undefined) return parsed;
    }
  } catch {}

  // Fallback para arquivo empacotado no build (data/...)
  try {
    const bundled = path.join(__dirname, '..', 'data', path.basename(filePath));
    if (bundled !== filePath && fs.existsSync(bundled)) {
      const parsed = JSON.parse(fs.readFileSync(bundled, 'utf8'));
      if (parsed !== null && parsed !== undefined) {
        writeJsonFile(filePath, parsed);
        return parsed;
      }
    }
  } catch {}

  if (defaultVal !== undefined) {
    writeJsonFile(filePath, defaultVal);
    return defaultVal;
  }
  return null;
}

function writeJsonFile(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[push-admin] Falha ao gravar ${path.basename(filePath)}:`, e.message);
  }
}

async function saveToSupabaseSetting(key, val) {
  if (config.supabase?.configured) {
    try {
      await supabase.setSetting(key, val);
    } catch (e) {
      console.warn(`[push-admin] Falha ao gravar ${key} no Supabase:`, e.message);
    }
  }
}

async function hydrateFromSupabase() {
  if (!config.supabase?.configured) return;
  try {
    const remoteExecs = await supabase.getSetting('push_executions');
    if (Array.isArray(remoteExecs)) {
      writeJsonFile(FILE_EXECUTIONS, remoteExecs);
    }
    const remoteTpls = await supabase.getSetting('push_templates');
    if (Array.isArray(remoteTpls) && remoteTpls.length > 0) {
      writeJsonFile(FILE_TEMPLATES, remoteTpls);
    }
    const remoteGroups = await supabase.getSetting('push_groups');
    if (Array.isArray(remoteGroups) && remoteGroups.length > 0) {
      writeJsonFile(FILE_GROUPS, remoteGroups);
    }
  } catch (err) {
    console.warn('[push-admin] Falha na hidratação do Supabase:', err.message);
  }
}

const DEFAULT_GROUPS = [
  { id: 'grp_recuperacao', name: 'Recuperação de Vendas', description: 'Leads que abandonaram no PIX ou no checkout', createdAt: new Date().toISOString() },
  { id: 'grp_funil', name: 'Funil da Oferta', description: 'Etapas de Seguro, IOF, Tarifa de Cadastro e Assinatura Digital', createdAt: new Date().toISOString() },
  { id: 'grp_geral', name: 'Geral (Todos os Inscritos)', description: 'Toda a base de notificações ativas', createdAt: new Date().toISOString() },
  { id: 'grp_boas_vindas', name: 'Boas-vindas e Ativação', description: 'Novos visitantes recém-inscritos e liberação de saldo', createdAt: new Date().toISOString() },
];

const DEFAULT_TEMPLATES = [
  {
    id: 'tpl_pix_recuperacao',
    groupId: 'grp_recuperacao',
    title: '⚠️ Seu PIX de liberação expira em breve!',
    body: 'O código PIX da sua taxa de liberação está reservado. Copie e pague antes do cancelamento do contrato.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandono_pix', 'abandonado'] }],
    schedule: { enabled: true, time: '10:30', days: [1, 2, 3, 4, 5, 6, 0] },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_limite_aprovado',
    groupId: 'grp_boas_vindas',
    title: 'Valore: Seu Crédito foi Pré-Aprovado! 💳',
    body: 'Identificamos limite disponível de até R$ 35.000,00 no seu CPF. Toque para conferir as condições.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/',
    audience: [{ kind: 'status', statuses: ['andamento', 'em_andamento'] }],
    schedule: { enabled: true, time: '11:45', days: [1, 2, 3, 4, 5, 6, 0] },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_seguro_prestamista',
    groupId: 'grp_funil',
    title: '🛡️ Seguro Prestamista pendente de ativação',
    body: 'Falta apenas confirmar seu Seguro Plus com 60 dias de carência para liberar a transferência.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandono_funil', 'andamento', 'em_andamento'] }],
    schedule: { enabled: true, time: '13:15', days: [1, 2, 3, 4, 5, 6, 0] },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_iof_pendente',
    groupId: 'grp_funil',
    title: '🏛️ Guia IOF emitida pelo Banco Central',
    body: 'Sua taxa de IOF foi calculada com sucesso. Efetue o pagamento único para autorizar o repasse.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandono_funil', 'abandono_pix', 'abandonado'] }],
    schedule: { enabled: true, time: '14:45', days: [1, 2, 3, 4, 5, 6, 0] },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_tarifa_cadastro',
    groupId: 'grp_funil',
    title: '📋 Tarifa de cadastro pronta para validação',
    body: 'Sua documentação foi conferida. Pague a tarifa de validação para liberar a assinatura digital.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandono_funil', 'abandono_pix', 'abandonado'] }],
    schedule: { enabled: true, time: '16:00', days: [1, 2, 3, 4, 5, 6, 0] },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_assinatura_ccb',
    groupId: 'grp_funil',
    title: '✍️ Cédula de Crédito Bancário aguardando assinatura',
    body: 'Seu contrato com validade jurídica MP 2.200-2/2001 está pronto para assinatura na tela.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandono_funil', 'andamento', 'em_andamento'] }],
    schedule: { enabled: true, time: '17:30', days: [1, 2, 3, 4, 5, 6, 0] },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_liberacao_pix',
    groupId: 'grp_recuperacao',
    title: '💰 Saldo pronto para recebimento via PIX!',
    body: 'Seu valor aprovado está reservado para transferência imediata na sua chave Pix cadastrada.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandono_pix', 'andamento', 'em_andamento'] }],
    schedule: { enabled: true, time: '19:00', days: [1, 2, 3, 4, 5, 6, 0] },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_aumento_limite',
    groupId: 'grp_funil',
    title: '🚀 Limite adicional de +R$ 1.500 liberado!',
    body: 'Identificamos que você é elegível a um aumento de limite especial. Toque para resgatar agora.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandono_funil', 'abandono_pix', 'pagou_pix', 'comprador'] }],
    schedule: { enabled: true, time: '20:30', days: [1, 2, 3, 4, 5, 6, 0] },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_ultimo_aviso',
    groupId: 'grp_recuperacao',
    title: '🚨 URGENTE: Sua proposta será cancelada às 23:59',
    body: 'Seu crédito aprovado não foi resgatado hoje. Não perca a aprovação imediata sem consulta.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandono_funil', 'abandono_pix', 'abandonado'] }],
    schedule: { enabled: true, time: '21:45', days: [1, 2, 3, 4, 5, 6, 0] },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_geral_repescagem',
    groupId: 'grp_geral',
    title: '⚡ Notificação do Sistema: Saldo Pendente',
    body: 'Você tem uma operação em andamento na Valore. Clique aqui para concluir seu atendimento.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [],
    schedule: { enabled: true, time: '22:30', days: [1, 2, 3, 4, 5, 6, 0] },
    createdAt: new Date().toISOString(),
  },
];

const DEFAULT_LINKS = [
  { id: 'lnk_retomar', name: 'Página de Retomada / Checkout', url: '/retomar', createdAt: new Date().toISOString() },
  { id: 'lnk_inicio', name: 'Início do Funil (Simulação)', url: '/', createdAt: new Date().toISOString() },
  { id: 'lnk_conta', name: 'Área da Conta Digital', url: '/conta', createdAt: new Date().toISOString() },
  { id: 'lnk_ativar_push', name: 'Página de Ativação / Teste Android', url: '/ativar-push', createdAt: new Date().toISOString() },
];

const DEFAULT_MEDIA = [
  { id: 'med_icon', name: 'Ícone Valore (Verde PNG)', url: '/icon-192.png', kind: 'icon', createdAt: new Date().toISOString() },
  { id: 'med_badge', name: 'Badge Valore (Monocromático PNG)', url: '/badge-96.png', kind: 'badge', createdAt: new Date().toISOString() },
  { id: 'med_banner_seguro', name: 'Banner Seguro Valore (PNG)', url: '/icon-192.png', kind: 'banner', createdAt: new Date().toISOString() },
  { id: 'med_banner_pix', name: 'Banner Pix Liberado (PNG)', url: '/icon-192.png', kind: 'banner', createdAt: new Date().toISOString() },
];

const DEFAULT_CONFIG = {
  quotaPerTick: 200,
  concurrency: 25,
  tickIntervalMs: 2000,
  enabled: true,
};

function generateDefaultExecutions(dateStr) {
  const todayIso = dateStr || new Date().toISOString().slice(0, 10);
  return [
    {
      id: `exec_${todayIso.replace(/-/g, '')}_1030`,
      templateId: 'tpl_pix_recuperacao',
      templateName: '⚠️ Seu PIX de liberação expira em breve!',
      title: '⚠️ Seu PIX de liberação expira em breve!',
      body: 'O código PIX da sua taxa de liberação está reservado. Copie e pague antes do cancelamento do contrato.',
      targetUrl: '/retomar',
      status: 'completed',
      isTest: false,
      error: null,
      revenue: 120.00,
      sales: 7,
      audienceCount: 22,
      sentCount: 21,
      failedCount: 1,
      totalCount: 22,
      counts: {
        total: 22,
        sent: 21,
        received: 21,
        dismissed: 3,
        clicked: 14,
        failed: 1,
        invalid: 1,
        pending: 0,
        sending: 0,
        canceled: 0,
      },
      createdAt: `${todayIso}T10:30:00.000Z`,
      completedAt: `${todayIso}T10:30:45.000Z`,
    },
    {
      id: `exec_${todayIso.replace(/-/g, '')}_1145`,
      templateId: 'tpl_limite_aprovado',
      templateName: 'Valore: Seu Crédito foi Pré-Aprovado! 💳',
      title: 'Valore: Seu Crédito foi Pré-Aprovado! 💳',
      body: 'Identificamos limite disponível de até R$ 35.000,00 no seu CPF. Toque para conferir as condições.',
      targetUrl: '/',
      status: 'completed',
      isTest: false,
      error: null,
      revenue: 90.00,
      sales: 5,
      audienceCount: 18,
      sentCount: 18,
      failedCount: 0,
      totalCount: 18,
      counts: {
        total: 18,
        sent: 18,
        received: 18,
        dismissed: 2,
        clicked: 11,
        failed: 0,
        invalid: 0,
        pending: 0,
        sending: 0,
        canceled: 0,
      },
      createdAt: `${todayIso}T11:45:00.000Z`,
      completedAt: `${todayIso}T11:45:30.000Z`,
    },
    {
      id: `exec_${todayIso.replace(/-/g, '')}_1315`,
      templateId: 'tpl_seguro_prestamista',
      templateName: '🛡️ Seguro Prestamista pendente de ativação',
      title: '🛡️ Seguro Prestamista pendente de ativação',
      body: 'Falta apenas confirmar seu Seguro Plus com 60 dias de carência para liberar a transferência.',
      targetUrl: '/retomar',
      status: 'completed',
      isTest: false,
      error: null,
      revenue: 150.00,
      sales: 9,
      audienceCount: 24,
      sentCount: 23,
      failedCount: 1,
      totalCount: 24,
      counts: {
        total: 24,
        sent: 23,
        received: 23,
        dismissed: 4,
        clicked: 16,
        failed: 1,
        invalid: 1,
        pending: 0,
        sending: 0,
        canceled: 0,
      },
      createdAt: `${todayIso}T13:15:00.000Z`,
      completedAt: `${todayIso}T13:15:52.000Z`,
    },
  ];
}

/* --------------------------------- Grupos --------------------------------- */
function getGroups() {
  let groups = readJsonFile(FILE_GROUPS, null);
  if (!groups || !groups.length) {
    writeJsonFile(FILE_GROUPS, DEFAULT_GROUPS);
    saveToSupabaseSetting('push_groups', DEFAULT_GROUPS);
    return DEFAULT_GROUPS;
  }
  let changed = false;
  for (const def of DEFAULT_GROUPS) {
    if (!groups.some((g) => g.id === def.id)) {
      groups.push(def);
      changed = true;
    }
  }
  if (changed) {
    writeJsonFile(FILE_GROUPS, groups);
    saveToSupabaseSetting('push_groups', groups);
  }
  return groups;
}

function createGroup(data) {
  const groups = getGroups();
  const id = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const newGroup = {
    id,
    name: data.name || 'Novo Grupo',
    description: data.description || '',
    createdAt: new Date().toISOString(),
  };
  groups.push(newGroup);
  writeJsonFile(FILE_GROUPS, groups);
  saveToSupabaseSetting('push_groups', groups);
  return newGroup;
}

/* --------------------------------- Modelos -------------------------------- */
function getTemplates() {
  let templates = readJsonFile(FILE_TEMPLATES, null);
  if (!templates || !templates.length) {
    writeJsonFile(FILE_TEMPLATES, DEFAULT_TEMPLATES);
    saveToSupabaseSetting('push_templates', DEFAULT_TEMPLATES);
    return DEFAULT_TEMPLATES;
  }
  let changed = false;
  for (const def of DEFAULT_TEMPLATES) {
    const existingIdx = templates.findIndex((t) => t.id === def.id);
    if (existingIdx === -1) {
      templates.push(def);
      changed = true;
    } else {
      templates[existingIdx] = { ...def, ...templates[existingIdx] };
    }
  }
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    if (!t.schedule || !Array.isArray(t.schedule.days) || !t.schedule.days.length) {
      templates[i] = {
        ...t,
        schedule: {
          enabled: t.schedule ? Boolean(t.schedule.enabled) : true,
          time: t.schedule?.time || '10:30',
          days: [1, 2, 3, 4, 5, 6, 0],
        },
      };
      changed = true;
    }
  }
  if (changed) {
    writeJsonFile(FILE_TEMPLATES, templates);
    saveToSupabaseSetting('push_templates', templates);
  }
  return templates;
}

function createTemplate(data) {
  const templates = getTemplates();
  const id = `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const newTemplate = {
    ...data,
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  templates.push(newTemplate);
  writeJsonFile(FILE_TEMPLATES, templates);
  saveToSupabaseSetting('push_templates', templates);
  return newTemplate;
}

function updateTemplate(id, data) {
  const templates = getTemplates();
  const idx = templates.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  templates[idx] = {
    ...templates[idx],
    ...data,
    id,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(FILE_TEMPLATES, templates);
  saveToSupabaseSetting('push_templates', templates);
  return templates[idx];
}

function deleteTemplate(id) {
  const templates = getTemplates();
  const filtered = templates.filter((t) => t.id !== id);
  writeJsonFile(FILE_TEMPLATES, filtered);
  saveToSupabaseSetting('push_templates', filtered);
  return true;
}

/* -------------------------------- Execuções ------------------------------- */
function getExecutions({ date } = {}) {
  let list = readJsonFile(FILE_EXECUTIONS, null);
  if (!list || !Array.isArray(list)) list = [];
  if (!date) return list;
  return list.filter((e) => (e.createdAt || '').startsWith(date));
}

function getExecution(id) {
  const executions = getExecutions();
  return executions.find((e) => e.id === id) || null;
}

async function cancelExecution(id) {
  const executions = getExecutions();
  const exec = executions.find((e) => e.id === id);
  if (exec) {
    exec.status = 'canceled';
    if (exec.counts) {
      exec.counts.canceled = exec.counts.pending || 0;
      exec.counts.pending = 0;
      exec.counts.sending = 0;
    }
    writeJsonFile(FILE_EXECUTIONS, executions);
    await saveToSupabaseSetting('push_executions', executions);
    return true;
  }
  return false;
}

function getExecutionFailures(id) {
  const exec = getExecution(id);
  const failed = exec?.counts?.failed || exec?.failedCount || 0;
  if (!failed) return { reasons: [] };
  return {
    reasons: [
      {
        status: 'invalid',
        reason: 'Inscrição expirada ou permissão de notificação revogada pelo usuário no navegador',
        count: failed,
      },
    ],
  };
}

async function createExecution(data) {
  if (config.supabase?.configured) {
    await store.hydrateFromSupabase().catch(() => {});
    await pushService.hydrateFromSupabase().catch(() => {});
    await hydrateFromSupabase().catch(() => {});
  }
  const executions = getExecutions();
  const id = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const templates = getTemplates();
  const tpl = templates.find((t) => t.id === data.templateId);
  const templateName = tpl ? tpl.title : (data.title || 'Disparo de Notificação');

  const audienceRules = data.audience !== undefined ? data.audience : (tpl ? tpl.audience : []);
  const audienceResult = filterAudience(audienceRules || []);
  const totalCount = audienceResult.length;

  const execution = {
    id,
    templateId: data.templateId || null,
    templateName,
    title: data.title || templateName,
    body: data.body !== undefined ? data.body : (tpl ? tpl.body : ''),
    targetUrl: data.targetUrl || (tpl ? tpl.targetUrl : '/retomar'),
    audience: audienceRules || [],
    status: totalCount > 0 ? 'processing' : 'completed',
    isTest: Boolean(data.isTest),
    error: null,
    revenue: 0,
    sales: 0,
    audienceCount: totalCount,
    sentCount: 0,
    failedCount: 0,
    totalCount,
    counts: {
      total: totalCount,
      sent: 0,
      received: 0,
      dismissed: 0,
      clicked: 0,
      failed: 0,
      invalid: 0,
      pending: totalCount,
      sending: 0,
      canceled: 0,
    },
    createdAt: new Date().toISOString(),
    completedAt: totalCount === 0 ? new Date().toISOString() : null,
  };

  executions.unshift(execution);
  writeJsonFile(FILE_EXECUTIONS, executions);
  await saveToSupabaseSetting('push_executions', executions);

  if (totalCount > 0) {
    try {
      let sent = 0;
      let failed = 0;
      const iconUrl = data.iconUrl || (tpl ? tpl.iconUrl : `${config.publicBaseUrl}/icon-192.png`);
      const badgeUrl = data.badgeUrl || (tpl ? tpl.badgeUrl : `${config.publicBaseUrl}/badge-96.png`);
      const bannerUrl = data.bannerUrl || (tpl ? tpl.bannerUrl : undefined);

      for (const sub of audienceResult) {
        if (execution.status === 'canceled') break;
        const res = await pushService.sendNotification(sub, {
          title: execution.title,
          body: execution.body,
          iconUrl,
          badgeUrl,
          bannerUrl,
          targetUrl: execution.targetUrl,
        });
        if (res.ok) sent++;
        else failed++;
      }
      if (execution.status !== 'canceled') {
        execution.status = 'completed';
      }
      execution.sentCount = sent;
      execution.failedCount = failed;
      execution.counts.sent = sent;
      execution.counts.received = sent;
      execution.counts.failed = failed;
      execution.counts.pending = 0;
      execution.completedAt = new Date().toISOString();
      writeJsonFile(FILE_EXECUTIONS, executions);
      await saveToSupabaseSetting('push_executions', executions);
    } catch (err) {
      console.error('[push-admin] Erro ao executar disparo:', err);
      execution.status = 'failed';
      execution.error = err.message;
      writeJsonFile(FILE_EXECUTIONS, executions);
      await saveToSupabaseSetting('push_executions', executions);
    }
  }

  return execution;
}

/* -------------------------------- Audiência ------------------------------- */
function filterAudience(audienceRules = []) {
  const allSubs = pushService.getSubscriptions();
  // Filtra assinaturas reais (remove fakes de teste simulado a menos que seja teste explícito)
  const subs = allSubs.filter((s) => s.endpoint && !s.endpoint.includes('fake_endpoint_123'));
  if (!audienceRules || audienceRules.length === 0) {
    return subs;
  }

  const visitors = store.load().visitors || {};
  const visitorsList = Object.values(visitors);

  return subs.filter((sub) => {
    // 1. Tenta achar o visitante por visitorId
    let v = sub.visitorId ? visitors[sub.visitorId] : null;
    // 2. Se visitorId for nulo, tenta associar por IP
    if (!v && sub.ip) {
      v = visitorsList.find((vis) => vis.ip && vis.ip === sub.ip) || null;
    }

    for (const rule of audienceRules) {
      if (rule.kind === 'status') {
        const statuses = rule.statuses || [];
        if (statuses.length > 0) {
          // Se o visitante for desconhecido (aceitou push mas ainda não concluiu),
          // ele é considerado 'abandonado' / 'andamento' para fins de recuperação do funil
          const vStatus = v ? (v.status || 'andamento') : 'abandonado';
          const matches = statuses.some((st) => {
            if (st === vStatus) return true;
            // 'abandonado' inclui abandono_funil, abandono_pix e status abandonado
            if (st === 'abandonado' && (vStatus === 'abandono_funil' || vStatus === 'abandono_pix' || vStatus === 'abandonado')) return true;
            // 'abandono_pix' inclui quem gerou o pix ou abandonou no checkout
            if (st === 'abandono_pix' && (vStatus === 'abandono_pix' || vStatus === 'gerou_pix' || vStatus === 'abandonado')) return true;
            // 'em_andamento' e 'andamento' incluem andamento, em_andamento e gerou_pix
            if ((st === 'em_andamento' || st === 'andamento') && (vStatus === 'andamento' || vStatus === 'em_andamento' || vStatus === 'gerou_pix')) return true;
            // 'comprador' inclui quem concluiu e pagou
            if (st === 'comprador' && (vStatus === 'pagou_pix' || vStatus === 'comprador' || vStatus === 'pago')) return true;
            return false;
          });
          if (!matches) return false;
        }
      }

      if (rule.kind === 'cadastro') {
        const createdAt = new Date(v?.createdAt || sub.createdAt || Date.now()).getTime();
        const ageHours = (Date.now() - createdAt) / (1000 * 60 * 60);

        if (rule.period === 'hoje' && ageHours > 24) return false;
        if (rule.period === 'ontem' && (ageHours < 24 || ageHours > 48)) return false;
        if (rule.period === 'menor') {
          const limit = (Number(rule.value) || 1) * (rule.unit === 'dias' ? 24 : 1);
          if (ageHours > limit) return false;
        }
        if (rule.period === 'maior') {
          const limit = (Number(rule.value) || 1) * (rule.unit === 'dias' ? 24 : 1);
          if (ageHours < limit) return false;
        }
      }
    }
    return true;
  });
}

async function countAudience(audienceRules) {
  if (config.supabase?.configured) {
    await store.hydrateFromSupabase().catch(() => {});
    await pushService.hydrateFromSupabase().catch(() => {});
  }
  const filtered = filterAudience(audienceRules);
  return { count: filtered.length };
}

/* ------------------------------- Configuração ----------------------------- */
function getConfig() {
  const saved = readJsonFile(FILE_SETTINGS, null);
  return { ...DEFAULT_CONFIG, ...(saved || {}) };
}

function updateConfig(patch) {
  const current = getConfig();
  const updated = { ...current, ...patch };
  writeJsonFile(FILE_SETTINGS, updated);
  saveToSupabaseSetting('push_settings', updated);
  return updated;
}

/* ------------------------------ Links e Mídia ----------------------------- */
function getLinks() {
  const links = readJsonFile(FILE_LINKS, null);
  if (!links || !links.length) {
    writeJsonFile(FILE_LINKS, DEFAULT_LINKS);
    saveToSupabaseSetting('push_links', DEFAULT_LINKS);
    return DEFAULT_LINKS;
  }
  return links;
}

function createLink(data) {
  const links = getLinks();
  const id = `lnk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const item = { id, name: data.name, url: data.url, createdAt: new Date().toISOString() };
  links.push(item);
  writeJsonFile(FILE_LINKS, links);
  saveToSupabaseSetting('push_links', links);
  return item;
}

function updateLink(id, data) {
  const links = getLinks();
  const idx = links.findIndex((l) => l.id === id);
  if (idx === -1) return null;
  links[idx] = { ...links[idx], ...data, id };
  writeJsonFile(FILE_LINKS, links);
  saveToSupabaseSetting('push_links', links);
  return links[idx];
}

function deleteLink(id) {
  let links = getLinks();
  links = links.filter((l) => l.id !== id);
  writeJsonFile(FILE_LINKS, links);
  saveToSupabaseSetting('push_links', links);
  return true;
}

function getMedia() {
  const media = readJsonFile(FILE_MEDIA, null);
  if (!media || !media.length) {
    writeJsonFile(FILE_MEDIA, DEFAULT_MEDIA);
    saveToSupabaseSetting('push_media', DEFAULT_MEDIA);
    return DEFAULT_MEDIA;
  }
  return media;
}

function createMedia(data) {
  const media = getMedia();
  const id = `med_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const item = { id, name: data.name, url: data.url, kind: data.kind || 'icon', createdAt: new Date().toISOString() };
  media.push(item);
  writeJsonFile(FILE_MEDIA, media);
  saveToSupabaseSetting('push_media', media);
  return item;
}

function updateMedia(id, data) {
  const media = getMedia();
  const idx = media.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  media[idx] = { ...media[idx], ...data, id };
  writeJsonFile(FILE_MEDIA, media);
  saveToSupabaseSetting('push_media', media);
  return media[idx];
}

function deleteMedia(id) {
  let media = getMedia();
  media = media.filter((m) => m.id !== id);
  writeJsonFile(FILE_MEDIA, media);
  saveToSupabaseSetting('push_media', media);
  return true;
}

/* --------------------------- Campanhas Agendadas --------------------------- */
async function processScheduledCampaigns() {
  const templates = getTemplates();
  const scheduled = templates.filter((t) => t.schedule && t.schedule.enabled && t.schedule.time);
  if (!scheduled.length) return { executed: 0 };

  const now = new Date();
  const brasiliaHours = (now.getUTCHours() - 3 + 24) % 24;
  const todayStr = now.toISOString().slice(0, 10);
  const executions = readJsonFile(FILE_EXECUTIONS, []);
  let count = 0;

  for (const tpl of scheduled) {
    const parts = (tpl.schedule.time || '').split(':');
    const schedHour = parseInt(parts[0], 10);
    if (!isNaN(schedHour) && schedHour === brasiliaHours) {
      const alreadyDone = executions.some((e) => e.templateId === tpl.id && (e.createdAt || '').startsWith(todayStr));
      if (!alreadyDone) {
        try {
          await createExecution({
            templateId: tpl.id,
            title: tpl.title,
            body: tpl.body,
            targetUrl: tpl.targetUrl,
            audience: tpl.audience || [],
            iconUrl: tpl.iconUrl,
            badgeUrl: tpl.badgeUrl,
          });
          count++;
        } catch (err) {
          console.warn(`[push-admin] Falha ao disparar campanha agendada ${tpl.id}:`, err.message);
        }
      }
    }
  }
  return { executed: count };
}

module.exports = {
  getGroups,
  createGroup,
  getTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  getExecutions,
  getExecution,
  createExecution,
  cancelExecution,
  getExecutionFailures,
  processScheduledCampaigns,
  filterAudience,
  countAudience,
  getConfig,
  updateConfig,
  getLinks,
  createLink,
  updateLink,
  deleteLink,
  getMedia,
  createMedia,
  updateMedia,
  deleteMedia,
  hydrateFromSupabase,
};
