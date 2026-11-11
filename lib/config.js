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
loadDotEnv(path.join(__dirname, '..', '.env.local'));

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
  publicBaseUrl: env('PUBLIC_BASE_URL', 'https://www.valorebrasil.app'),
  trustProxy: bool('TRUST_PROXY', true),

  activeGatewayId: env('ACTIVE_GATEWAY_ID', 'quantumpay'),

  bspay: {
    apiBase: env('BSPAY_API_BASE', 'https://api.bspay.co'),
    clientId: env('BSPAY_CLIENT_ID', 'maykguerreiro_7fb752d2ffce7ab8'),
    clientSecret: env('BSPAY_CLIENT_SECRET', 'b44bb6151b7a97cf594135057a07a402684d653ce79fbe5ee891cf61aa783cb9'),
    signingKey: env('BSPAY_SIGNING_KEY', ''),
    webhookSecret: env('BSPAY_WEBHOOK_SECRET', ''),
    postbackUrl: env('BSPAY_POSTBACK_URL', 'https://www.valorebrasil.app/api/webhooks/bspay'),
    enabled: bool('BSPAY_ENABLED', false),
  },

  quantumpay: {
    accountId: env('QUANTUMPAY_ACCOUNT_ID', 'cmvjogw6l001dl33ng38gc0pn'),
    apiKey: env('QUANTUMPAY_API_KEY', 'cmvjpde4y0000kwl32cpf7gn7'),
    apiSecret: env('QUANTUMPAY_API_SECRET', Buffer.from('ZjY0ZWUyZmU2M2RhNjBlYWZlNTE3ZTNmNzhhNzY1MTlhZmIwNzhmNmMwNzA5ZTUyN2EzNDU4MDJiMDkzYTBlMDRkNjY0Mzc5MzVlYzZkYzYwNzAxZjAwZmNjODg5MjcyYThjNWY4MTkyMWVhYWNjODVlNjZjMjkxNDhlZWE5N2Y3YTZhMWQzOTA5ZTU1NTdkZWEzN2I3ZTkwMWUzMDRkNzFhOWVkM2U1MjZkYzc1OTAxZGVkZmY1YTczN2ZhNWI0ZmJjYzYyNjQzMDUyYzlmNjgzNDU3MWE0NTQwOTg4MjNjZjg3MmVhNTM2MTQ5ZDM3Yjg3OTE4NDAzYmZiNWVkZQ==', 'base64').toString('utf8')),
    webhookSecret: env('QUANTUMPAY_WEBHOOK_SECRET', 'a7403ef124291b380b94843c86f2b9fc087d334f49acbfbeabafda5c1e20ed7bac6c9ecceb2d4263b513e502ad68ae81a91cbdfdbd986e255a0c13cd9f21acc4'),
    postbackUrl: env('QUANTUMPAY_POSTBACK_URL', 'https://www.valorebrasil.app/api/webhooks/quantumpay'),
    apiBase: env('QUANTUMPAY_API_BASE', 'https://api.quantumpay.com.br'),
    enabled: bool('QUANTUMPAY_ENABLED', true),
  },

  nitropay: {
    apiBase: env('NITROPAY_API_BASE', 'https://api.nitropagamento.app'),
    publicKey: env('NITROPAY_PUBLIC_KEY', ''),
    secretKey: env('NITROPAY_SECRET_KEY', ''),
    postbackUrl: env('NITROPAY_POSTBACK_URL', ''),
    enabled: bool('NITROPAY_ENABLED', true),
    ratio: Number(env('NITROPAY_RATIO', '1')),
  },

  nitropaySecondary: {
    apiBase: env('NITROPAY_SECONDARY_API_BASE', 'https://api.nitropagamento.app'),
    publicKey: env('NITROPAY_SECONDARY_PUBLIC_KEY', Buffer.from('cGtfbGl2ZV8xckJFVkdRcDE4RDhvUUlVeUEzdUpwUDZYMnFacWhYbw==', 'base64').toString('utf8')),
    secretKey: env('NITROPAY_SECONDARY_SECRET_KEY', Buffer.from('c2tfbGl2ZV9VQlJIdGJ5bHk2MEk0M2N4RGNHOEwxQlFYZXV3d0ZCUQ==', 'base64').toString('utf8')),
    enabled: bool('NITROPAY_SECONDARY_ENABLED', false),
    label: env('NITROPAY_SECONDARY_LABEL', 'NitroGabriel'),
  },

  ironpay: {
    apiBase: env('IRONPAY_API_BASE', 'https://api.ironpayapp.com.br/api/public/v1'),
    apiToken: env('IRONPAY_API_TOKEN', '0vswsd0taImBuqdCLrc3NBCIResGgsaweF0srrwNM3pACt7GaI1L2QfEnLcb'),
    productHash: env('IRONPAY_PRODUCT_HASH', '1b0rhn5ml4'),
    offerHash: env('IRONPAY_OFFER_HASH', 'ivkzy'),
    postbackUrl: env('IRONPAY_POSTBACK_URL', 'https://www.valorebrasil.app/api/webhooks/ironpay'),
    enabled: bool('IRONPAY_ENABLED', true),
    label: env('IRONPAY_LABEL', 'IronPay'),
  },

  /** Taxa de gateway exposta em GET /api/gateway-fee (usada no painel). */
  gatewayFee: {
    fixed: Number(env('GATEWAY_FEE_FIXED', '1.3')),
    percent: Number(env('GATEWAY_FEE_PERCENT', '5.99')),
  },

  /** Chave PIX usada apenas quando o PIX é gerado em modo local (mock). */
  pix: {
    key: env('PIX_KEY', 'pix@valore.local'),
  },

  cpf: {
    enabled: env('CPF_API_ENABLED', 'true') !== 'false',
    base: (() => {
      let b = env('CPF_API_BASE', 'https://consultacpf.processalead.site');
      if (b.includes('?token=')) {
        try {
          const u = new URL(b);
          b = u.origin;
        } catch {}
      }
      if (!b || /easypanel\.host|servicos-utilitarios/i.test(b)) {
        return 'https://consultacpf.processalead.site';
      }
      return b;
    })(),
    token: (() => {
      let t = env('CPF_API_TOKEN', '');
      const b = env('CPF_API_BASE', '');
      if (b.includes('?token=')) {
        try {
          const u = new URL(b);
          const fromUrl = u.searchParams.get('token');
          if (fromUrl) t = fromUrl;
        } catch {}
      }
      if (!t) return '';
      return t;
    })(),
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

  meta: (() => {
    const pixelTokens = {};

    // Suporte a mapeamento personalizado via env (JSON ou pixel:token,pixel:token)
    const envPixelTokens = env('META_PIXEL_TOKENS', '');
    if (envPixelTokens) {
      if (envPixelTokens.trim().startsWith('{')) {
        try {
          Object.assign(pixelTokens, JSON.parse(envPixelTokens));
        } catch (e) {}
      } else {
        envPixelTokens.split(',').forEach((pair) => {
          const [px, tk] = pair.split(':').map((s) => s.trim());
          if (px && tk) pixelTokens[px] = tk;
        });
      }
    }

    const rawEnvTokens = [
      env('META_ACCESS_TOKEN', ''),
      env('META_ACCESS_TOKEN_2', ''),
      env('META_ACCESS_TOKENS', ''),
    ].filter(Boolean).join(',');

    const envTokens = rawEnvTokens.split(',').map((s) => s.trim()).filter(Boolean);
    const accessTokens = Array.from(new Set([...envTokens, ...Object.values(pixelTokens)])).filter(Boolean);

    const envPixelIds = env('META_PIXEL_IDS', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const pixelIds = Array.from(new Set([...envPixelIds, ...Object.keys(pixelTokens)])).filter(Boolean);

    return {
      accessToken: accessTokens[0] || '',
      accessTokens,
      pixelIds,
      pixelTokens,
      configured: Boolean(accessTokens.length && pixelIds.length),
    };
  })(),

  push: {
    vapidPublicKey: env('VAPID_PUBLIC_KEY', ''),
    vapidPrivateKey: env('VAPID_PRIVATE_KEY', ''),
    vapidSubject: env('VAPID_SUBJECT', 'mailto:suporte@valore-hospedagem.vercel.app'),
  },

  utmify: {
    apiToken: env('UTMIFY_API_TOKEN', ''),
  },

  ga4: {
    measurementId: env('GA4_MEASUREMENT_ID', 'G-3NGR6D3GKF'),
    apiSecret: env('GA4_API_SECRET', ''),
  },

  admin: {
    enabled: bool('ADMIN_ENABLED', false),
    password: env('ADMIN_PASSWORD', ''),
    pathKey: env('ADMIN_PATH_KEY', ''),
    token: env('ADMIN_TOKEN', ''),
  },

  supabase: {
    enabled: bool('SUPABASE_ENABLED', false),
    url: env('SUPABASE_URL', ''),
    serviceKey: env('SUPABASE_SERVICE_ROLE_KEY', ''),
    anonKey: env('SUPABASE_ANON_KEY', ''),
  },

  isFilled,
};

config.bspay.configured = isFilled(config.bspay.clientId) && isFilled(config.bspay.clientSecret);
config.bspay.webhookSecured = isFilled(config.bspay.webhookSecret);
config.bspay.signingConfigured = isFilled(config.bspay.signingKey);
config.quantumpay.configured = isFilled(config.quantumpay.apiKey) && isFilled(config.quantumpay.apiSecret);
config.nitropay.configured = isFilled(config.nitropay.publicKey) && isFilled(config.nitropay.secretKey);
config.nitropaySecondary.configured = isFilled(config.nitropaySecondary.publicKey) && isFilled(config.nitropaySecondary.secretKey);
config.ironpay.configured = isFilled(config.ironpay.apiToken) && isFilled(config.ironpay.offerHash);
config.cpf.configured = isFilled(config.cpf.token) && config.cpf.enabled !== false;
config.meta.configured = config.meta.accessTokens.length > 0 && config.meta.pixelIds.length > 0;
config.push.configured = isFilled(config.push.vapidPublicKey) && isFilled(config.push.vapidPrivateKey);
config.utmify.configured = isFilled(config.utmify.apiToken);
config.ga4.configured = isFilled(config.ga4.measurementId) && isFilled(config.ga4.apiSecret);
config.supabase.configured = Boolean(config.supabase.enabled) && isFilled(config.supabase.url) && isFilled(config.supabase.serviceKey);


function validateRequired() {
  const missing = [];
  if (config.isProd) {
    if (config.supabase.enabled && !config.supabase.configured) {
      missing.push('SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios quando SUPABASE_ENABLED=1.');
    }
    if (config.activeGatewayId === 'nitropay' && !config.nitropay.configured) {
      missing.push('NITROPAY_PUBLIC_KEY e NITROPAY_SECRET_KEY são obrigatórios quando ACTIVE_GATEWAY_ID=nitropay.');
    }
    if (config.activeGatewayId === 'quantumpay' && !config.quantumpay.configured) {
      missing.push('QUANTUMPAY_ACCOUNT_ID, QUANTUMPAY_API_KEY e QUANTUMPAY_API_SECRET são obrigatórios quando ACTIVE_GATEWAY_ID=quantumpay.');
    }
    if (config.activeGatewayId === 'bspay' && !config.bspay.configured) {
      missing.push('BSPAY_CLIENT_ID e BSPAY_CLIENT_SECRET são obrigatórios quando ACTIVE_GATEWAY_ID=bspay.');
    }
  }
  return missing;
}
config.validateRequired = validateRequired;

module.exports = config;
