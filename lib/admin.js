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
  users: [
    {
      id: 'usr_admin_master',
      name: 'Gabriel (Administrador)',
      username: 'admin',
      role: 'admin',
      active: true,
      createdAt: '2026-10-25T00:00:00.000Z',
      lastLoginAt: null,
    },
  ],
};

let state = null;
const sessions = new Map();

function load() {
  if (state) return state;
  try {
    if (fs.existsSync(FILE)) {
      const raw = fs.readFileSync(FILE, 'utf8');
      state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
      state.users = state.users && state.users.length ? state.users : [...DEFAULT_STATE.users];
      return state;
    }
  } catch (e) {
    console.warn('[admin] Falha ao carregar admin.json:', e.message);
  }
  state = { ...DEFAULT_STATE, users: [...DEFAULT_STATE.users] };
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

function createSession(req, ip, user = null) {
  const userAgent = req?.headers?.['user-agent'] || '';
  const now = new Date().toISOString();
  const id = 'sess_' + crypto.randomBytes(8).toString('hex');
  const d = load();
  const defaultAdmin = (d.users || []).find(u => u.role === 'admin') || {
    id: 'usr_admin_master',
    name: 'Gabriel (Administrador)',
    username: 'admin',
    role: 'admin',
  };
  const activeUser = user || {
    id: defaultAdmin.id,
    name: defaultAdmin.name,
    username: defaultAdmin.username,
    role: defaultAdmin.role || 'admin',
  };

  const payload = {
    id,
    ip: ip || '127.0.0.1',
    ua: userAgent.slice(0, 150),
    user: activeUser,
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
    user: activeUser,
    createdAt: now,
    lastSeenAt: now,
  };

  sessions.set(token, session);

  d.sessions = d.sessions || [];
  d.sessions.unshift({
    id,
    ip: payload.ip,
    label: session.label,
    user: activeUser,
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
            user: payload.user || { id: 'usr_admin_master', name: 'Gabriel (Administrador)', username: 'admin', role: 'admin' },
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
  const detailObj = typeof details === 'object' && details !== null ? details : { reason: String(details || '') };
  const entry = {
    id: 'aud_' + crypto.randomBytes(8).toString('hex'),
    action,
    details: detailObj.reason || String(details || ''),
    detail: detailObj,
    ip: ip || '—',
    createdAt: new Date().toISOString(),
  };
  d.audit = d.audit || [];
  d.audit.unshift(entry);
  if (d.audit.length > 200) d.audit = d.audit.slice(0, 200);
  save();
  supabase.addAudit(action, typeof details === 'object' ? JSON.stringify(details) : details, ip);
  return entry;
}

function getAudit(limit = 100) {
  const d = load();
  return (d.audit || []).slice(0, limit);
}

async function syncIpBlocksToSupabase() {
  if (config.supabase?.configured) {
    const d = load();
    try {
      return await supabase.setSetting('admin_ip_blocks', d.ipBlocks || []);
    } catch {}
  }
}

async function loadIpBlocksFromSupabase() {
  if (config.supabase?.configured) {
    try {
      const supaBlocks = await supabase.getSetting('admin_ip_blocks');
      if (Array.isArray(supaBlocks)) {
        const d = load();
        d.ipBlocks = supaBlocks;
        save();
      }
    } catch {}
  }
}

let lastIpBlocksLoad = 0;
const IP_BLOCKS_TTL = 30000;

async function ensureIpBlocksLoaded() {
  if (Date.now() - lastIpBlocksLoad > IP_BLOCKS_TTL) {
    lastIpBlocksLoad = Date.now();
    await loadIpBlocksFromSupabase();
  }
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
  syncIpBlocksToSupabase();
  return true;
}

function unblockIp(ip) {
  const d = load();
  const cleanIp = String(ip).trim();
  d.ipBlocks = (d.ipBlocks || []).filter((b) => b.ip !== cleanIp);
  save();
  syncIpBlocksToSupabase();
  return true;
}

function isIpBlocked(ip) {
  if (!ip) return false;
  const cleanIp = String(ip).trim();
  const d = load();
  return (d.ipBlocks || []).some((b) => b.active && b.ip === cleanIp);
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

function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let cleaned = String(str || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = '';
  for (let i = 0; i < cleaned.length; i++) {
    const val = alphabet.indexOf(cleaned[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateBase32Secret(length = 16) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = crypto.randomBytes(length);
  let secret = '';
  for (let i = 0; i < length; i++) {
    secret += alphabet[bytes[i] % alphabet.length];
  }
  return secret;
}

function verifyTotp(secret, code, timeStep = 30) {
  if (!code || typeof code !== 'string') return false;
  const cleanCode = code.replace(/\D/g, '').trim();
  if (cleanCode.length !== 6) return false;
  if (!secret) return false;

  const key = /^[A-Z2-7\s]+$/i.test(secret) ? base32Decode(secret) : Buffer.from(secret, 'hex');
  const currentCounter = Math.floor(Date.now() / 1000 / timeStep);

  for (let diff = -1; diff <= 1; diff++) {
    const counter = currentCounter + diff;
    const buf = Buffer.alloc(8);
    buf.writeBigInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0xf;
    const gen = ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] & 0xff) << 16 | (hmac[offset + 2] & 0xff) << 8 | (hmac[offset + 3] & 0xff)) % 1000000;
    if (String(gen).padStart(6, '0') === cleanCode) {
      return true;
    }
  }
  return false;
}

function verifyUserTotp(user, code) {
  if (!user || !user.totpEnabled) return true;
  if (!user.totpSecret) return false;
  return verifyTotp(user.totpSecret, code);
}

function setupTotp(currentPassword) {
  if (!verifyPassword(currentPassword)) {
    throw new Error('Senha atual incorreta');
  }
  const secret = generateBase32Secret(16);
  const pretty = secret.match(/.{1,4}/g).join(' ');
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

function syncUsersToSupabase(users) {
  if (config.supabase?.configured) {
    supabase.setSetting('admin_users', users).catch(() => {});
  }
}

async function loadUsersFromSupabase() {
  if (config.supabase?.configured) {
    try {
      const supaUsers = await supabase.getSetting('admin_users');
      if (Array.isArray(supaUsers) && supaUsers.length) {
        const d = load();
        const map = new Map();
        for (const u of d.users || []) map.set(u.id || u.username, u);
        for (const u of supaUsers) {
          const key = u.id || u.username;
          map.set(key, { ...(map.get(key) || {}), ...u });
        }
        d.users = Array.from(map.values());
        save();
      }
    } catch {}
  }
}

function listUsers() {
  const d = load();
  return (d.users || []).map((u) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role || 'admin',
    active: u.active !== false,
    totpEnabled: Boolean(u.totpEnabled),
    totpSecret: u.totpSecret || null,
    totpEnabledAt: u.totpEnabledAt || null,
    createdAt: u.createdAt || new Date().toISOString(),
    lastLoginAt: u.lastLoginAt || null,
  }));
}

function createUser({ name, username, password, role = 'operador', totpEnabled = false }) {
  const d = load();
  d.users = d.users || [];
  const cleanUsername = String(username || '').trim().toLowerCase();
  if (!cleanUsername) throw new Error('Usuário é obrigatório');
  if (d.users.some((u) => u.username && u.username.toLowerCase() === cleanUsername)) {
    throw new Error('Este nome de usuário já está em uso');
  }
  if (!password || String(password).trim().length < 4) {
    throw new Error('A senha deve ter pelo menos 4 caracteres');
  }

  const id = 'usr_' + crypto.randomBytes(6).toString('hex');
  const shouldTotp = Boolean(totpEnabled);
  const user = {
    id,
    name: String(name || cleanUsername).trim(),
    username: cleanUsername,
    password: String(password).trim(),
    role: ['admin', 'operador', 'visualizador'].includes(role) ? role : 'operador',
    active: true,
    totpEnabled: shouldTotp,
    totpSecret: shouldTotp ? generateBase32Secret(16) : null,
    totpEnabledAt: shouldTotp ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };

  d.users.push(user);
  save();
  syncUsersToSupabase(d.users);

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    active: user.active,
    totpEnabled: user.totpEnabled,
    totpSecret: user.totpSecret,
    totpEnabledAt: user.totpEnabledAt,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function updateUser(id, patch = {}) {
  const d = load();
  d.users = d.users || [];
  const user = d.users.find((u) => u.id === id);
  if (!user) throw new Error('Usuário não encontrado');

  if (patch.name !== undefined) {
    const cleanN = String(patch.name).trim();
    if (!cleanN) throw new Error('Nome não pode ser vazio');
    user.name = cleanN;
  }
  if (patch.username !== undefined) {
    const cleanU = String(patch.username).trim().toLowerCase();
    if (!cleanU) throw new Error('Usuário não pode ser vazio');
    if (cleanU !== user.username) {
      if (d.users.some((u) => u.id !== id && u.username && u.username.toLowerCase() === cleanU)) {
        throw new Error('Este nome de usuário já está em uso');
      }
      user.username = cleanU;
    }
  }
  if (patch.role !== undefined && ['admin', 'operador', 'visualizador'].includes(patch.role)) {
    user.role = patch.role;
  }
  if (patch.active !== undefined) {
    user.active = Boolean(patch.active);
  }
  if (patch.totpEnabled !== undefined) {
    const shouldEnable = Boolean(patch.totpEnabled);
    user.totpEnabled = shouldEnable;
    if (shouldEnable) {
      if (!user.totpSecret) user.totpSecret = generateBase32Secret(16);
      user.totpEnabledAt = user.totpEnabledAt || new Date().toISOString();
    } else {
      user.totpSecret = null;
      user.totpEnabledAt = null;
    }
  }
  if (patch.totpSecret && user.totpEnabled) {
    user.totpSecret = String(patch.totpSecret).toUpperCase().replace(/[\s-]/g, '');
  }
  if (patch.password) {
    const pass = String(patch.password).trim();
    if (pass.length < 4) throw new Error('Senha muito curta (mínimo 4 caracteres)');
    user.password = pass;
    if (user.username === 'admin' || user.id === 'usr_admin_master') {
      d.customPassword = pass;
    }
  }

  save();
  syncUsersToSupabase(d.users);

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    active: user.active,
    totpEnabled: Boolean(user.totpEnabled),
    totpSecret: user.totpSecret || null,
    totpEnabledAt: user.totpEnabledAt || null,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function deleteUser(id) {
  const d = load();
  d.users = d.users || [];
  if (d.users.length <= 1) {
    throw new Error('Não é possível excluir o único usuário com acesso ao painel');
  }
  const idx = d.users.findIndex((u) => u.id === id);
  if (idx === -1) throw new Error('Usuário não encontrado');
  d.users.splice(idx, 1);
  save();
  syncUsersToSupabase(d.users);
  return true;
}

function verifyCredentials(password, username = '') {
  const d = load();
  const cleanPass = String(password || '');
  const cleanUser = String(username || '').trim().toLowerCase();

  // 1. Se informou usuário específico
  if (cleanUser) {
    const found = (d.users || []).find((u) => u.username && u.username.toLowerCase() === cleanUser && u.active !== false);
    if (found) {
      if (found.password && found.password === cleanPass) {
        found.lastLoginAt = new Date().toISOString();
        save();
        return {
          valid: true,
          user: {
            id: found.id,
            name: found.name,
            username: found.username,
            role: found.role,
            totpEnabled: Boolean(found.totpEnabled),
            totpSecret: found.totpSecret || null,
          },
        };
      }
      if (!found.password && verifyPassword(cleanPass)) {
        found.lastLoginAt = new Date().toISOString();
        save();
        return {
          valid: true,
          user: {
            id: found.id,
            name: found.name,
            username: found.username,
            role: found.role,
            totpEnabled: Boolean(found.totpEnabled),
            totpSecret: found.totpSecret || null,
          },
        };
      }
      return { valid: false };
    }
  }

  // 2. Senha mestre direta
  if (verifyPassword(cleanPass)) {
    const adminUser = (d.users || []).find((u) => u.role === 'admin' && u.active !== false) || {
      id: 'usr_admin_master',
      name: 'Gabriel (Administrador)',
      username: 'admin',
      role: 'admin',
      totpEnabled: false,
      totpSecret: null,
    };
    return {
      valid: true,
      user: {
        id: adminUser.id,
        name: adminUser.name,
        username: adminUser.username,
        role: adminUser.role,
        totpEnabled: Boolean(adminUser.totpEnabled),
        totpSecret: adminUser.totpSecret || null,
      },
    };
  }

  // 3. Testa se a senha bate com algum usuário ativo configurado
  const match = (d.users || []).find((u) => u.active !== false && u.password && u.password === cleanPass);
  if (match) {
    match.lastLoginAt = new Date().toISOString();
    save();
    return {
      valid: true,
      user: {
        id: match.id,
        name: match.name,
        username: match.username,
        role: match.role,
        totpEnabled: Boolean(match.totpEnabled),
        totpSecret: match.totpSecret || null,
      },
    };
  }

  return { valid: false };
}

module.exports = {
  load,
  getPassword,
  getPathKey,
  verifyPassword,
  verifyCredentials,
  verifyPathKey,
  verifyTotp,
  verifyUserTotp,
  generateBase32Secret,
  createSession,
  extractToken,
  getSessionByToken,
  revokeSession,
  revokeAllSessionsExcept,
  listSessions,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  loadUsersFromSupabase,
  syncUsersToSupabase,
  addAudit,
  getAudit,
  listIpBlocks,
  blockIp,
  unblockIp,
  isIpBlocked,
  loadIpBlocksFromSupabase,
  syncIpBlocksToSupabase,
  ensureIpBlocksLoaded,
  getSecurityStatus,
  changePassword,
  changePathKey,
  setupTotp,
  confirmTotp,
  disableTotp,
};
