'use strict';
/**
 * Carrega variáveis de ambiente de valore/.env (sem dependências externas).
 * Nada de credencial hardcoded: o .env é o único ponto de configuração.
 */
const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq < 1) continue;
      const key = s.slice(0, eq).trim();
      let val = s.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        /* valor sem quotes: comentário iniciado por " #" é descartado
           (evita que "CHAVE=   # comentário" vire valor de verdade). */
        const hash = val.search(/\s#/);
        if (hash >= 0) val = val.slice(0, hash).trim();
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* .env é opcional: variáveis de ambiente do host valem */ }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const env = (k, def = '') => (process.env[k] === undefined || process.env[k] === '' ? def : process.env[k]);
const bool = (k, def = false) => ['1', 'true', 'yes', 'on'].includes(String(env(k, def ? '1' : '')).toLowerCase());

/** Um valor "não preenchido" é aquele vazio ou ainda com o texto de exemplo. */
const PLACEHOLDERS = ['CLIENT_ID', 'CLIENT_SECRET', 'SIGNING_KEY', 'WEBHOOK_SECRET', 'TOKEN', 'SEU_DOMINIO'];
const looksLikePlaceholder = (v) => /^(COLE_|SEU_|SUA_|TROQUE)/i.test(v) || /AQUI$/i.test(v) || /SEU_DOMINIO/i.test(v);
const isFilled = (v) => !!v && !PLACEHOLDERS.includes(v) && !looksLikePlaceholder(v);

const nodeEnv = env('NODE_ENV', 'development');
const isProd = nodeEnv === 'production' || bool('VALORE_PRODUCTION', false);

const config = {
  nodeEnv,
  isProd,

  brand: {
    name: env('BRAND_NAME', 'Valore'),
    legalName: env('BRAND_LEGAL_NAME', 'Valore Correspondente Bancário Ltda'),
    cnpj: env('BRAND_CNPJ', '00.000.000/0001-00'),
    accent: env('BRAND_ACCENT', '#22c55e'),
    whatsapp: env('BRAND_WHATSAPP', '5500000000000'),
  },

  port: Number(env('PORT', '3000')),
  host: env('HOST', '0.0.0.0'),
  publicBaseUrl: env('PUBLIC_BASE_URL', ''),
  trustProxy: bool('TRUST_PROXY', true),

  bspay: {
    apiBase: env('BSPAY_API_BASE', 'https://api.bspay.co'),
    clientId: env('BSPAY_CLIENT_ID', 'CLIENT_ID'),
    clientSecret: env('BSPAY_CLIENT_SECRET', 'CLIENT_SECRET'),
    signingKey: env('BSPAY_SIGNING_KEY', 'SIGNING_KEY'),
    webhookSecret: env('BSPAY_WEBHOOK_SECRET', 'WEBHOOK_SECRET'),
    postbackUrl: env('BSPAY_POSTBACK_URL', ''),
    sandbox: bool('BSPAY_SANDBOX', false),
    activeGatewayId: env('ACTIVE_GATEWAY_ID', 'bspay'),
  },

  /** Taxa de gateway exposta em GET /api/gateway-fee (usada no painel). */
  gatewayFee: {
    fixed: Number(env('GATEWAY_FEE_FIXED', '1.3')),
    percent: Number(env('GATEWAY_FEE_PERCENT', '5.99')),
  },

  /** Chave PIX usada apenas quando o PIX é gerado em modo local (sem BSPay). */
  pix: {
    key: env('PIX_KEY', 'pix@valore.local'),
  },

  cpf: {
    base: env('CPF_API_BASE', 'https://servicos-utilitarios-novaera.ugztmp.easypanel.host'),
    token: env('CPF_API_TOKEN', 'TOKEN'),
    timeoutMs: Number(env('CPF_API_TIMEOUT_MS', '15000')),
  },

  cep: {
    viacep: env('CEP_API_BASE', 'https://viacep.com.br/ws'),
    brasilapi: env('CEP_API_FALLBACK', 'https://brasilapi.com.br/api/cep/v1'),
  },

  /** PIX local é permitido só fora de produção, ou se pedido explicitamente. */
  allowMockPix: isProd ? bool('ALLOW_MOCK_PIX', false) : bool('ALLOW_MOCK_PIX', true),
  orderTtlMinutes: Number(env('ORDER_TTL_MINUTES', '30')),

  /** CORS: vazio = same-origin (recomendado em produção). CSV libera domínios específicos. */
  corsOrigins: env('CORS_ORIGINS', '').split(',').map((s) => s.trim()).filter(Boolean),

  rateLimit: {
    ordersPerMin: Number(env('RATE_LIMIT_ORDERS_PER_MIN', '30')),
    cpfPerMin: Number(env('RATE_LIMIT_CPF_PER_MIN', '30')),
  },

  dataDir: (() => {
    if (process.env.VERCEL) {
      const os = require('os');
      return path.join(os.tmpdir(), 'valore-data');
    }
    const dir = env('DATA_DIR', 'data');
    return path.isAbsolute(dir) ? dir : path.join(__dirname, '..', dir);
  })(),

  isFilled,
};

config.bspay.configured = isFilled(config.bspay.clientId) && isFilled(config.bspay.clientSecret);
config.bspay.webhookSecured = isFilled(config.bspay.webhookSecret);
config.bspay.signingConfigured = isFilled(config.bspay.signingKey);
config.cpf.configured = isFilled(config.cpf.token);

module.exports = config;
