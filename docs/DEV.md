# Guia de Desenvolvimento — Valore Brasil

Guia rápido de configuração, execução local, fluxo de deploy e procedimentos operacionais.

---

## 1. Como Rodar Localmente

### Pré-requisitos
- Node.js 18+ (recomendado Node 20+)
- npm 9+

### Passos
1. Certifique-se de estar na pasta do projeto:
   ```bash
   cd valore-hospedagem
   ```
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Crie o arquivo `.env.local` baseado no `.env.example`:
   ```bash
   cp .env.example .env.local
   ```
   Preencha as variáveis de ambiente necessárias no `.env.local` (este arquivo é ignorado pelo Git).
4. Inicie o servidor:
   ```bash
   npm start
   ```
   O servidor iniciará por padrão na porta `3000` (ou na porta definida por `PORT`).
5. Acesse no navegador: `http://localhost:3000` (Painel administrativo em `/admin`).

---

## 2. Variáveis de Ambiente Obrigatórias

> **Importante:** Nunca versione valores reais no Git. Use apenas `.env.local` para desenvolvimento e cadastre no painel da Vercel para Produção e Preview.

### Essenciais do Sistema
- `NODE_ENV` (`development` ou `production`)
- `ADMIN_PASSWORD` (senha de acesso ao painel `/admin`)

### Supabase (Banco de Dados e Persistência)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (usada exclusivamente pelo backend Node server-side)
- `SUPABASE_ANON_KEY`

### Gateways de Pagamento (Pix)
Configure conforme os gateways habilitados no painel:
- **NitroPay:** `NITROPAY_PUBLIC_KEY`, `NITROPAY_SECRET_KEY`
- **QuantumPay:** `QUANTUMPAY_APP_KEY`, `QUANTUMPAY_APP_SECRET`, `QUANTUMPAY_WEBHOOK_SECRET`
- **BSPay:** `BSPAY_CLIENT_ID`, `BSPAY_CLIENT_SECRET`

### Rastreamento, Consulta e Notificações
- **Meta Ads / Conversions API (CAPI):** `META_ACCESS_TOKEN`, `META_PIXEL_ID` (ou `META_PIXEL_TOKENS` no caso de múltiplos pixels)
- **Consulta CPF:** `CPF_API_TOKEN`
- **Web Push Notifications:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
- **UTMify (Opcional):** `UTMIFY_API_TOKEN`

---

## 3. Fluxo de Git e Deploy

O repositório oficial é `barrospro/valore-hospedagem`, integrado ao projeto na Vercel:

```
[Desenvolvimento Local] 
         │
         ▼
[git commit / push branch] ──► Deploy Automático de Preview na Vercel
         │
         ▼ (Revisão e Testes no Preview)
[Merge / push na branch main] ──► Deploy Automático em Produção (www.valorebrasil.app)
```

1. Crie uma branch para alterações: `git checkout -b feature/minha-feature`
2. Faça commits atômicos e objetivos (`feat: ...`, `fix: ...`, `chore: ...`).
3. Envie para o GitHub: `git push origin feature/minha-feature`.
4. A Vercel gerará automaticamente uma URL de Preview para validação.
5. Após validar, faça o merge na branch `main`: a Vercel publicará automaticamente em `https://www.valorebrasil.app`.

---

## 4. Comandos de Verificação

### Verificação de Sintaxe Local
Antes de commitar, execute a checagem sintática de todos os arquivos:
```bash
npm run check
```

### Health Check do Servidor
Teste o endpoint de integridade em produção ou local:
```bash
# Produção
curl -s -i https://www.valorebrasil.app/api/health

# Local
curl -s -i http://localhost:3000/api/health
```
Resposta esperada: HTTP 200 com status `ok`.

### Logs e Status na Vercel
```bash
# Ver últimos deploys
vercel ls

# Inspecionar logs da produção em tempo real
vercel logs valore-hospedagem --prod
```

---

## 5. Como Fazer Rollback

Se um deploy em produção apresentar instabilidade ou erros críticos:

### Opção 1: Rollback Instantâneo via Vercel CLI (Recomendado)
Volta imediatamente para o último deploy estável sem precisar de rebuild:
```bash
vercel rollback
```
Selecione o deploy anterior da lista e confirme.

### Opção 2: Rollback via Painel da Vercel
1. Acesse o projeto na Vercel (`valore-hospedagem`).
2. Vá na aba **Deployments**.
3. Localize o deploy anterior que estava funcionando.
4. Clique no menu de três pontos (`...`) e selecione **Instant Rollback**.

### Opção 3: Reversão no Git
Caso queira desfazer a alteração no histórico do código:
```bash
git revert HEAD
git push origin main
```
A Vercel fará o build e deploy automático do commit de reversão.

