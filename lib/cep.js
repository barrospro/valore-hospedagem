'use strict';
/**
 * Consulta de CEP — APIs gratuitas:
 *   1) ViaCEP            https://viacep.com.br/ws/{cep}/json/          (primária, é a que o site original usa)
 *   2) BrasilAPI         https://brasilapi.com.br/api/cep/v1/{cep}     (fallback em caso de 5xx/timeout)
 * Resultado é cacheado em memória por 24h — CEP não muda.
 */
const config = require('./config');

const cache = new Map(); // cep -> { at, value }
const TTL = 24 * 60 * 60 * 1000;

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

async function getJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function viaCep(cep) {
  const j = await getJson(`${config.cep.viacep.replace(/\/+$/, '')}/${cep}/json/`);
  if (j.erro) return null;
  return {
    cep,
    logradouro: j.logradouro || '',
    complemento: j.complemento || '',
    bairro: j.bairro || '',
    cidade: j.localidade || '',
    uf: (j.uf || '').toUpperCase(),
    ibge: j.ibge || '',
    fonte: 'viacep',
  };
}

async function brasilApi(cep) {
  const j = await getJson(`${config.cep.brasilapi.replace(/\/+$/, '')}/${cep}`);
  return {
    cep,
    logradouro: j.street || '',
    complemento: '',
    bairro: j.neighborhood || '',
    cidade: j.city || '',
    uf: (j.state || '').toUpperCase(),
    ibge: j.city_ibge || j.ibge || '',
    fonte: 'brasilapi',
  };
}

async function lookup(cepRaw) {
  const cep = onlyDigits(cepRaw);
  if (cep.length !== 8) {
    const e = new Error('CEP deve ter 8 dígitos');
    e.code = 'INVALID_CEP';
    e.status = 422;
    throw e;
  }

  const hit = cache.get(cep);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const errors = [];
  for (const fn of [viaCep, brasilApi]) {
    try {
      const value = await fn(cep);
      if (value && (value.logradouro || value.cidade)) {
        cache.set(cep, { at: Date.now(), value });
        return value;
      }
      if (value === null) break; // ViaCEP disse explicitamente "não existe"
    } catch (e) {
      errors.push(`${fn.name}: ${e.message}`);
    }
  }

  const e = new Error(
    errors.length ? `Não foi possível consultar o CEP (${errors.join('; ')})` : 'CEP não encontrado',
  );
  e.code = errors.length ? 'CEP_API_ERROR' : 'CEP_NOT_FOUND';
  e.status = errors.length ? 502 : 404;
  throw e;
}

module.exports = { lookup };
