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

const FILE_TEMPLATES = path.join(config.dataDir, 'push_templates.json');
const FILE_GROUPS = path.join(config.dataDir, 'push_groups.json');
const FILE_EXECUTIONS = path.join(config.dataDir, 'push_executions.json');
const FILE_SETTINGS = path.join(config.dataDir, 'push_settings.json');
const FILE_LINKS = path.join(config.dataDir, 'push_links.json');
const FILE_MEDIA = path.join(config.dataDir, 'push_media.json');

function readJsonFile(filePath, defaultVal) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {}
  return defaultVal;
}

function writeJsonFile(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn(`[push-admin] Falha ao gravar ${path.basename(filePath)}:`, e.message);
  }
}

const DEFAULT_GROUPS = [
  { id: 'grp_recuperacao', name: 'Recuperação de Vendas', description: 'Leads que abandonaram no PIX ou no cadastro', createdAt: new Date().toISOString() },
  { id: 'grp_geral', name: 'Geral (Todos os Inscritos)', description: 'Toda a base de notificações ativas', createdAt: new Date().toISOString() },
  { id: 'grp_boas_vindas', name: 'Boas-vindas e Ativação', description: 'Novos visitantes recém-inscritos', createdAt: new Date().toISOString() },
];

const DEFAULT_TEMPLATES = [
  {
    id: 'tpl_pix_recuperacao',
    groupId: 'grp_recuperacao',
    title: '⚠️ Seu PIX de liberação expira em breve!',
    body: 'Toque para copiar seu código PIX e garantir a transferência do seu limite na sua conta.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandonado', 'em_andamento'] }],
    schedule: { enabled: true, time: '11:00' },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_limite_aprovado',
    groupId: 'grp_recuperacao',
    title: 'Valore: Seu Crédito foi Liberado! 💳',
    body: 'Temos uma proposta pré-aprovada para você. Toque aqui para concluir seu resgate.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandonado'] }],
    schedule: { enabled: true, time: '16:00' },
    createdAt: new Date().toISOString(),
  },
  {
    id: 'tpl_ultimo_aviso',
    groupId: 'grp_recuperacao',
    title: '🚨 Atenção: Proposta expira hoje',
    body: 'Última oportunidade para transferir seu valor aprovado. Toque para não perder.',
    iconUrl: '/icon-192.png',
    badgeUrl: '/badge-96.png',
    targetUrl: '/retomar',
    audience: [{ kind: 'status', statuses: ['abandonado'] }],
    schedule: { enabled: true, time: '20:00' },
    createdAt: new Date().toISOString(),
  },
];

const DEFAULT_LINKS = [
  { id: 'lnk_retomar', name: 'Página de Retomada / Checkout', url: '/retomar', createdAt: new Date().toISOString() },
  { id: 'lnk_inicio', name: 'Início do Funil', url: '/', createdAt: new Date().toISOString() },
];

const DEFAULT_MEDIA = [
  { id: 'med_icon', name: 'Ícone Valore (Verde PNG)', url: '/icon-192.png', kind: 'icon', createdAt: new Date().toISOString() },
  { id: 'med_badge', name: 'Badge Valore (Monocromático PNG)', url: '/badge-96.png', kind: 'badge', createdAt: new Date().toISOString() },
];

const DEFAULT_CONFIG = {
  quotaPerTick: 200,
  concurrency: 25,
  tickIntervalMs: 2000,
  enabled: true,
};

/* --------------------------------- Grupos --------------------------------- */
function getGroups() {
  const groups = readJsonFile(FILE_GROUPS, null);
  if (!groups || !groups.length) {
    writeJsonFile(FILE_GROUPS, DEFAULT_GROUPS);
    return DEFAULT_GROUPS;
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
  return newGroup;
}

/* --------------------------------- Modelos -------------------------------- */
function getTemplates() {
  const templates = readJsonFile(FILE_TEMPLATES, null);
  if (!templates || !templates.length) {
    writeJsonFile(FILE_TEMPLATES, DEFAULT_TEMPLATES);
    return DEFAULT_TEMPLATES;
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
  return templates[idx];
}

function deleteTemplate(id) {
  const templates = getTemplates();
  const filtered = templates.filter((t) => t.id !== id);
  writeJsonFile(FILE_TEMPLATES, filtered);
  return true;
}

/* -------------------------------- Execuções ------------------------------- */
function getExecutions({ date } = {}) {
  const list = readJsonFile(FILE_EXECUTIONS, []);
  if (!date) return list;
  return list.filter((e) => (e.createdAt || '').startsWith(date));
}

async function createExecution(data) {
  const executions = readJsonFile(FILE_EXECUTIONS, []);
  const id = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const execution = {
    id,
    templateId: data.templateId || null,
    title: data.title || 'Disparo de Notificação',
    body: data.body || '',
    targetUrl: data.targetUrl || '/retomar',
    audience: data.audience || [],
    status: 'processing',
    sentCount: 0,
    failedCount: 0,
    totalCount: 0,
    createdAt: new Date().toISOString(),
  };

  const audienceResult = filterAudience(data.audience || []);
  execution.totalCount = audienceResult.length;

  executions.unshift(execution);
  writeJsonFile(FILE_EXECUTIONS, executions);

  // Executa o disparo em background
  (async () => {
    let sent = 0;
    let failed = 0;
    for (const sub of audienceResult) {
      const res = await pushService.sendNotification(sub, {
        title: execution.title,
        body: execution.body,
        iconUrl: data.iconUrl || `${config.publicBaseUrl}/favicon.svg`,
        badgeUrl: data.badgeUrl || `${config.publicBaseUrl}/favicon.svg`,
        bannerUrl: data.bannerUrl,
        targetUrl: execution.targetUrl,
      });
      if (res.ok) sent++;
      else failed++;
    }
    execution.status = 'completed';
    execution.sentCount = sent;
    execution.failedCount = failed;
    execution.completedAt = new Date().toISOString();
    writeJsonFile(FILE_EXECUTIONS, executions);
  })().catch((err) => {
    console.error('[push-admin] Erro ao executar disparo:', err);
    execution.status = 'failed';
    writeJsonFile(FILE_EXECUTIONS, executions);
  });

  return execution;
}

/* -------------------------------- Audiência ------------------------------- */
function filterAudience(audienceRules = []) {
  const subs = pushService.getSubscriptions();
  if (!audienceRules || audienceRules.length === 0) {
    return subs;
  }

  const visitors = store.load().visitors || {};

  return subs.filter((sub) => {
    const v = sub.visitorId ? visitors[sub.visitorId] : null;

    for (const rule of audienceRules) {
      if (rule.kind === 'status') {
        const statuses = rule.statuses || [];
        if (statuses.length > 0) {
          const vStatus = v ? v.status : 'desconhecido';
          if (!statuses.includes(vStatus)) return false;
        }
      }

      if (rule.kind === 'cadastro') {
        if (!v) return false;
        const createdAt = new Date(v.createdAt).getTime();
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

function countAudience(audienceRules) {
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
  return updated;
}

/* ------------------------------ Links e Mídia ----------------------------- */
function getLinks() {
  const links = readJsonFile(FILE_LINKS, null);
  if (!links || !links.length) {
    writeJsonFile(FILE_LINKS, DEFAULT_LINKS);
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
  return item;
}

function getMedia() {
  const media = readJsonFile(FILE_MEDIA, null);
  if (!media || !media.length) {
    writeJsonFile(FILE_MEDIA, DEFAULT_MEDIA);
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
  return item;
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
  createExecution,
  processScheduledCampaigns,
  filterAudience,
  countAudience,
  getConfig,
  updateConfig,
  getLinks,
  createLink,
  getMedia,
  createMedia,
};
