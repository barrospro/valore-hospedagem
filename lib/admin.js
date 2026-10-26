'use strict';
/**
 * Valore — Gerenciador de Acesso Administrativo e Painel (/p/:key).
 *
 * Responsável por:
 *  - Autenticação por senha (ADMIN_PASSWORD no .env ou definida no painel)
 *  - Validação de endereço secreto de URL (ADMIN_PATH_KEY)
 *  - Gerenciamento de sessões ativas (tokens Bearer adm_*)
 *  - Registro de auditoria de ações administrativas
 *  - Bloqueio e desbloqueio de IPs
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const supabase = require('./supabase');

const FILE = path.join(config.dataDir, 'admin.json');

const DEFAULT_STATE = {
  customPassword: null,
  customPathKey: null,
  totpSecret: null,
  totpEnabled: false,
  totpEnabledAt: null,
  ipBlocks: [],
  audit: [],
  revokedSessionIds: [],
  sessions: [],
};

let state = null;
const sessions = new Map();

function load() {
  if (state) return state;
  try {
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, 'utf8');
      state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
      return state;
    }
  } catch (e) {
    console.warn('[admin] Falha ao carregar admin.json:', e.message);
  }
  state = { ...DEFAULT_STATE };
  return state;
}

function save() {
  if (!state) return;
  try {
    if (!fs.existsSync(config.dataDir)) {
      fs.mkdirSync(config.dataDir, { recursive: true });
    }
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[admin] Falha ao salvar admin.json:', e.message);
  }
}

function getPassword() {
  const d = load();
  if (d.customPassword) return d.customPassword;
  return config.admin?.password || process.env.ADMIN_PASSWORD || 'valore2026';
}

function getPathKey() {
  const d = load();
  if (d.customPathKey !== null && d.customPathKey !== undefined && d.customPathKey !== '') {
    return d.customPathKey;
  }
  return config.admin?.pathKey || process.env.ADMIN_PATH_KEY || '';
}

function verifyPassword(password) {
  const current = getPassword();
  if (!password || typeof password !== 'string') return false;
  return password === current;
}

function verifyPathKey(pathKey) {
  const configured = getPathKey();
  if (!configured) return true; // Sem chave restrita no servidor: aceita o pathKey da requisição
  const cleanReq = String(pathKey || '').trim().toLowerCase();
  const cleanConf = configured.trim().toLowerCase();
  return cleanReq === cleanConf;
}

function parseUserAgentLabel(ua = '') {
  const s = String(ua || '');
  let browser = 'Navegador';
  if (/chrome|crios/i.test(s) && !/edg|opr/i.test(s)) browser = 'Google Chrome';
  else if (/edg/i.test(s)) browser = 'Microsoft Edge';
  else if (/safari/i.test(s) && !/chrome/i.test(s)) browser = 'Safari';
  else if (/firefox|fxios/i.test(s)) browser = 'Firefox';
  else if (/opera|opr/i.test(s)) browser = 'Opera';

  let os = 'Dispositivo';
  if (/windows/i.test(s)) os = 'Windows';
  else if (/android/i.test(s)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(s)) os = 'iOS';
  else if (/macintosh|mac os x/i.test(s)) os = 'macOS';
  else if (/linux/i.test(s)) os = 'Linux';

  return `${browser} no ${os}`;
}

function getSecretKey() {
  return process.env.ADMIN_JWT_SECRET || getPassword() || 'valore_admin_jwt_secret_2026';
}

function createSession(req, ip) {
  const userAgent = req?.headers?.['user-agent'] || '';
  const now = new Date().toISOString();
  const id = 'sess_' + crypto.randomBytes(8).toString('hex');
  const payload = {
    id,
    ip: ip || '127.0.0.1',
    ua: userAgent.slice(0, 150),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 dias
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecretKey()).update(payloadB64).digest('base64url');
  const token = `adm.${payloadB64}.${sig}`;

  const session = {
    id,
    token,
    ip: payload.ip,
    userAgent,
    label: parseUserAgentLabel(userAgent),
    createdAt: now,
    lastSeenAt: now,
  };

  sessions.set(token, session);

  const d = load();
  d.sessions = d.sessions || [];
  d.sessions.unshift({
    id,
    ip: payload.ip,
    label: session.label,
    createdAt: now,
    lastSeenAt: now,
  });
  if (d.sessions.length > 50) d.sessions = d.sessions.slice(0, 50);
  save();

  return { token, session };
}

function extractToken(req) {
  const auth = req?.headers?.authorization || '';
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return '';
}

function getSessionByToken(token) {
  if (!token || typeof token !== 'string') return null;

  const staticToken = config.admin?.token || process.env.ADMIN_TOKEN;
  if (staticToken && token === staticToken) {
    return {
      id: 'sess_static_token',
      token: staticToken,
      ip: '127.0.0.1',
      label: 'Token de Servidor (ADMIN_TOKEN)',
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
  }

  // 1. Check in-memory map
  const mem = sessions.get(token);
  if (mem) {
    mem.lastSeenAt = new Date().toISOString();
    return mem;
  }

  // 2. Stateless HMAC verification (resists serverless multi-container routing)
  if (token.startsWith('adm.')) {
    const parts = token.split('.');
    if (parts.length === 3) {
      const [, payloadB64, sig] = parts;
      try {
        const expectedSig = crypto.createHmac('sha256', getSecretKey()).update(payloadB64).digest('base64url');
        if (sig === expectedSig) {
          const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
          const now = Math.floor(Date.now() / 1000);
          if (payload.exp && payload.exp < now) {
            return null; // Expired
          }
          const d = load();
          if ((d.revokedSessionIds || []).includes(payload.id)) {
            return null; // Revoked
          }
          const sess = {
            id: payload.id,
            token,
            ip: payload.ip || '127.0.0.1',
            userAgent: payload.ua || '',
            label: parseUserAgentLabel(payload.ua),
            createdAt: new Date(payload.iat * 1000).toISOString(),
            lastSeenAt: new Date().toISOString(),
          };
          sessions.set(token, sess);
          return sess;
        }
      } catch (e) {
        return null;
      }
    }
  }

  return null;
}

function revokeSession(id) {
  const d = load();
  d.revokedSessionIds = d.revokedSessionIds || [];
  if (!d.revokedSessionIds.includes(id)) {
    d.revokedSessionIds.push(id);
  }
  d.sessions = (d.sessions || []).filter((s) => s.id !== id);
  save();

  for (const [tk, sess] of sessions.entries()) {
    if (sess.id === id) {
      sessions.delete(tk);
      return true;
    }
  }
  return true;
}

function revokeAllSessionsExcept(token) {
  const currentSess = getSessionByToken(token);
  const currentId = currentSess?.id;
  const d = load();
  d.revokedSessionIds = d.revokedSessionIds || [];
  let count = 0;
  for (const s of d.sessions || []) {
    if (s.id !== currentId) {
      if (!d.revokedSessionIds.includes(s.id)) d.revokedSessionIds.push(s.id);
      count++;
    }
  }
  d.sessions = currentSess ? [{
    id: currentSess.id,
    label: currentSess.label,
    ip: currentSess.ip,
    createdAt: currentSess.createdAt,
    lastSeenAt: currentSess.lastSeenAt,
  }] : [];
  save();

  for (const [tk, sess] of Array.from(sessions.entries())) {
    if (sess.id !== currentId) {
      sessions.delete(tk);
    }
  }
  return count;
}

function listSessions(currentToken) {
  const currentSess = getSessionByToken(currentToken);
  const currentId = currentSess?.id;
  const d = load();
  const list = [...(d.sessions || [])];

  if (currentSess && !list.some((s) => s.id === currentSess.id)) {
    list.unshift({
      id: currentSess.id,
      label: currentSess.label,
      ip: currentSess.ip,
      createdAt: currentSess.createdAt,
      lastSeenAt: currentSess.lastSeenAt,
    });
  }

  return list.map((s) => ({
    ...s,
    current: s.id === currentId,
  }));
}

function addAudit(action, details, ip) {
  const d = load();
  const entry = {
    id: 'aud_' + crypto.randomBytes(8).toString('hex'),
    action,
    details: details || '',
    ip: ip || '—',
    createdAt: new Date().toISOString(),
  };
  d.audit = d.audit || [];
  d.audit.unshift(entry);
  if (d.audit.length > 200) d.audit = d.audit.slice(0, 200);
  save();
  supabase.addAudit(action, details, ip);
  return entry;
}

function getAudit(limit = 100) {
  const d = load();
  return (d.audit || []).slice(0, limit);
}

function listIpBlocks() {
  const d = load();
  return { items: d.ipBlocks || [] };
}

function blockIp(ip, reason = 'Bloqueado no painel') {
  if (!ip) return false;
  const d = load();
  const cleanIp = String(ip).trim();
  d.ipBlocks = d.ipBlocks || [];
  const existing = d.ipBlocks.find((b) => b.ip === cleanIp);
  if (existing) {
    existing.active = true;
    existing.reason = reason;
  } else {
    d.ipBlocks.push({
      id: 'blk_' + crypto.randomBytes(6).toString('hex'),
      ip: cleanIp,
      reason,
      active: true,
      createdAt: new Date().toISOString(),
    });
  }
  save();
  return true;
}

function unblockIp(ip) {
  const d = load();
  const cleanIp = String(ip).trim();
  d.ipBlocks = (d.ipBlocks || []).filter((b) => b.ip !== cleanIp);
  save();
  return true;
}

function isIpBlocked(ip) {
  if (!ip) return false;
  const d = load();
  return (d.ipBlocks || []).some((b) => b.active && b.ip === ip);
}

function getSecurityStatus() {
  const d = load();
  const currentPathKey = getPathKey();
  return {
    pathKey: currentPathKey,
    pathKeyConfigured: Boolean(currentPathKey),
    pathKeyFromEnv: Boolean(!d.customPathKey && process.env.ADMIN_PATH_KEY),
    passwordFromEnv: Boolean(!d.customPassword && (process.env.ADMIN_PASSWORD || !d.customPassword)),
    totpEnabled: Boolean(d.totpEnabled),
    totpEnabledAt: d.totpEnabledAt || null,
    activeSessions: sessions.size || 1,
  };
}

function changePassword(currentPassword, newPassword, currentToken) {
  if (!verifyPassword(currentPassword)) {
    throw new Error('Senha atual incorreta');
  }
  if (!newPassword || newPassword.length < 4) {
    throw new Error('A nova senha deve ter pelo menos 4 caracteres');
  }
  const d = load();
  d.customPassword = newPassword;
  save();
  const revoked = revokeAllSessionsExcept(currentToken);
  return { ok: true, revokedSessions: revoked };
}

function changePathKey(currentPassword, newPathKey) {
  if (!verifyPassword(currentPassword)) {
    throw new Error('Senha atual incorreta');
  }
  const d = load();
  d.customPathKey = String(newPathKey || '').trim().replace(/^\/p\//, '');
  save();
  return { ok: true, pathKey: d.customPathKey };
}

function setupTotp(currentPassword) {
  if (!verifyPassword(currentPassword)) {
    throw new Error('Senha atual incorreta');
  }
  const secret = crypto.randomBytes(20).toString('hex');
  const pretty = secret.slice(0, 16).toUpperCase().match(/.{1,4}/g).join(' ');
  return { secret, pretty, qrCode: '' };
}

function confirmTotp(code) {
  const d = load();
  d.totpEnabled = true;
  d.totpEnabledAt = new Date().toISOString();
  save();
  return { ok: true };
}

function disableTotp(currentPassword, code) {
  if (!verifyPassword(currentPassword)) {
    throw new Error('Senha atual incorreta');
  }
  const d = load();
  d.totpEnabled = false;
  d.totpSecret = null;
  d.totpEnabledAt = null;
  save();
  return { ok: true };
}

module.exports = {
  load,
  getPassword,
  getPathKey,
  verifyPassword,
  verifyPathKey,
  createSession,
  extractToken,
  getSessionByToken,
  revokeSession,
  revokeAllSessionsExcept,
  listSessions,
  addAudit,
  getAudit,
  listIpBlocks,
  blockIp,
  unblockIp,
  isIpBlocked,
  getSecurityStatus,
  changePassword,
  changePathKey,
  setupTotp,
  confirmTotp,
  disableTotp,
};
