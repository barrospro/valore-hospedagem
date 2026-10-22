'use strict';
/**
 * Consulta de CPF — proxy server-side para sua API de dados.
 *   GET {CPF_API_BASE}/api/pessoas/cpf/{cpf}
 *   Authorization: Bearer {CPF_API_TOKEN}
 *
 * O normalizador aceita os dois formatos comuns:
 *   { success, data: [ { nome, dtNascimento, nomeMae, ... } ], count }
 *   { nome, dataNascimento, nomeMae, ... }
 */
const config = require('./config');

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

/** Validação local (dígitos verificadores) — bloqueia consulta inútil e protege a API. */
function isValidCpf(cpf) {
  const c = onlyDigits(cpf);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(c[i]) * (len + 1 - i);
    const d = (sum * 10) % 11;
    return d === 10 ? 0 : d;
  };
  return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}

const maskCpf = (cpf) => onlyDigits(cpf).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');

function normalizeSexo(v) {
  const s = String(v || '').trim().toUpperCase();
  if (['M', 'MASCULINO', 'MALE', '1'].includes(s)) return 'M';
  if (['F', 'FEMININO', 'FEMALE', '2'].includes(s)) return 'F';
  return ''; // 'I' ou vazio -> usuário escolhe na tela
}

function firstOf(v) {
  if (Array.isArray(v)) return v.find((x) => String(x || '').trim()) || '';
  return v == null ? '' : String(v);
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    const val = firstOf(v);
    if (val) return String(val).trim();
  }
  return '';
}

function formatDateBr(d) {
  if (!d) return '';
  const s = String(d).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 8) {
    if (/^(19|20)\d{2}/.test(digits)) {
      return `${digits.slice(6, 8)}/${digits.slice(4, 6)}/${digits.slice(0, 4)}`;
    }
    return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4, 8)}`;
  }
  return s;
}

function normalize(raw) {
  const root = raw?.data ?? raw?.result ?? raw?.response ?? raw;
  const p = Array.isArray(root) ? root[0] : (Array.isArray(root?.data) ? root.data[0] : root);
  if (!p || typeof p !== 'object') return null;

  const nome = pick(p, ['nome', 'name', 'nomeCompleto', 'razaoSocial']);
  const nasc = pick(p, ['dtNascimento', 'dataNascimento', 'data_nascimento', 'nascimento', 'birthDate', 'dt_nascimento']);
  const mae = pick(p, ['nomeMae', 'nome_mae', 'mae', 'motherName']);
  const sexo = pick(p, ['sexo', 'genero', 'gender']);

  const cel = pick(p, ['celular1', 'celular', 'telefone1', 'phone', 'telefone', 'telefones']);
  const celular = cel ? onlyDigits(cel) : '';

  return {
    cpf: onlyDigits(pick(p, ['cpf', 'documento', 'document', 'cpfCnpj'])),
    cpfMasked: maskCpf(pick(p, ['cpf', 'documento', 'document']) || ''),
    nome: nome ? nome.replace(/\s+/g, ' ').trim() : '',
    nascimento: formatDateBr(nasc),
    nomeMae: mae ? mae.replace(/\s+/g, ' ').trim() : '',
    genero: normalizeSexo(sexo),
    email: pick(p, ['email', 'emails']),
    celular,
    rendaPresumida: Number(onlyDigits(pick(p, ['rendaPresumida', 'renda', 'faixaRenda'])) || 0) || null,
    statusReceita: pick(p, ['statusReceitaFederal', 'statusReceita', 'situacao']),
    obito: onlyDigits(pick(p, ['flagObito'])) === '1',
    endereco: {
      cep: onlyDigits(pick(p, ['cep'])),
      logradouro: pick(p, ['logradouro', 'rua', 'endereco']),
      numero: pick(p, ['numero']),
      complemento: pick(p, ['complemento']),
      bairro: pick(p, ['bairro']),
      cidade: pick(p, ['cidade', 'municipio']),
      uf: pick(p, ['uf', 'estado_uf']).slice(0, 2).toUpperCase(),
    },
    _raw: p,
  };
}

async function lookup(cpf) {
  const clean = onlyDigits(cpf);
  if (!isValidCpf(clean)) {
    const e = new Error('CPF inválido');
    e.code = 'INVALID_CPF';
    e.status = 422;
    throw e;
  }

  if (!config.cpf.token) {
    const e = new Error('API de CPF não configurada');
    e.code = 'CPF_NOT_CONFIGURED';
    e.status = 503;
    throw e;
  }

  const isProcessaLead = /processalead\.site/i.test(config.cpf.base) || /processalead/i.test(config.cpf.token);
  const isCpfCnpjApi = /cpfcnpj\.com\.br/i.test(config.cpf.base);

  let url;
  if (isProcessaLead) {
    const rawBase = config.cpf.base.replace(/\/+$/, '');
    const origin = rawBase.includes('/api/consultar') ? rawBase : `${rawBase}/api/consultar`;
    url = `${origin}/${clean}?token=${encodeURIComponent(config.cpf.token)}`;
  } else if (isCpfCnpjApi) {
    url = `${config.cpf.base.replace(/\/+$/, '')}/${encodeURIComponent(config.cpf.token)}/2/${clean}`;
  } else {
    url = `${config.cpf.base.replace(/\/+$/, '')}/api/pessoas/cpf/${clean}`;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), config.cpf.timeoutMs);
  let res;
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (!isProcessaLead && !isCpfCnpjApi) {
      headers.Authorization = `Bearer ${config.cpf.token}`;
    }
    res = await fetch(url, {
      method: 'GET',
      headers,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (!res.ok) {
    const e = new Error(body?.error || body?.message || body?.erro || `Falha na consulta de CPF (HTTP ${res.status})`);
    e.code = res.status === 404 ? 'CPF_NOT_FOUND' : 'CPF_API_ERROR';
    e.status = res.status === 404 ? 404 : 502;
    e.upstream = res.status;
    throw e;
  }

  if (isProcessaLead && body?.success === false) {
    const msg = body.error || body.message || 'Falha na consulta do CPF';
    const isNotFound = /falharam|não encontrado|nao encontrado/i.test(msg);
    const e = new Error(msg);
    e.code = isNotFound ? 'CPF_NOT_FOUND' : 'CPF_API_ERROR';
    e.status = isNotFound ? 404 : 502;
    throw e;
  }

  if (isCpfCnpjApi && body?.status === 0) {
    const errCode = Number(body.erroCodigo);
    const msg = body.erro || 'Falha na consulta do CPF';
    const isNotFound = errCode === 102;
    const isInvalid = [100, 101].includes(errCode);
    const e = new Error(msg);
    e.code = isNotFound ? 'CPF_NOT_FOUND' : (isInvalid ? 'INVALID_CPF' : 'CPF_API_ERROR');
    e.status = isNotFound ? 404 : (isInvalid ? 422 : 502);
    e.upstreamCode = errCode;
    throw e;
  }

  const person = normalize(body);
  if (!person || !person.nome) {
    const e = new Error('CPF não encontrado na base de dados');
    e.code = 'CPF_NOT_FOUND';
    e.status = 404;
    throw e;
  }
  return person;
}

module.exports = { lookup, isValidCpf, normalize, maskCpf, onlyDigits };
