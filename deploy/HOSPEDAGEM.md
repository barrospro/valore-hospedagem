# Valore — como hospedar

Site + API de PIX (site espelhado da marca **Valore**). Sem dependências: **não tem
`npm install`**. Precisa apenas de **Node 18+** (ou Docker).

## 1. Subir o serviço

**Docker (recomendado):**

```bash
cp .env.example .env      # preencha as variáveis (veja o passo 3)
docker compose up -d --build
# site em http://localhost:3000
```

**Node direto:**

```bash
cp .env.example .env
node server.js            # PORT padrão: 3000
```

**PM2 (VPS):** `npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save`
**systemd:** use `deploy/valore.service` (ajuste `User`, `WorkingDirectory`, `EnvironmentFile`).

## 2. Variáveis obrigatórias do .env

| Variável | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_BASE_URL` | `https://raspamoneypix.online` |
| `BSPAY_CLIENT_ID` / `BSPAY_CLIENT_SECRET` | credenciais do painel da BSPay (pedir a quem já tem) |
| `BSPAY_POSTBACK_URL` | `https://raspamoneypix.online/api/webhooks/bspay` |
| `CPF_API_BASE` / `CPF_API_TOKEN` | API de consulta de CPF (pedir o token) |
| `ALLOW_MOCK_PIX` | `0` em produção |
| `ADMIN_TOKEN` | opcional — protege `/api/admin/stats` |

`BSPAY_SIGNING_KEY` e `BSPAY_WEBHOOK_SECRET` **podem ficar vazios**: o primeiro só é usado
em rotas financeiras de saída (cashout/conversão) e, sem o segundo, o pagamento é
confirmado consultando a API da BSPay.

## 3. HTTPS e domínio

Aponte o domínio `raspamoneypix.online` para o servidor e termine o TLS no proxy
(Nginx/Traefik/Cloudflare/EasyPanel). O app escuta HTTP na porta `PORT`.

> A BSPay resolve o DNS do `postback_url` e **recusa a cobrança se o domínio não resolver**.
> O servidor detecta isso e refaz a cobrança sem postback automaticamente — quando o DNS
> estiver no ar, o postback volta sozinho.

## 4. Conferir se subiu

```bash
curl http://localhost:3000/api/health           # {"status":"ok", "env":"production", ...}
curl "http://localhost:3000/api/health?deep=1"  # autentica de verdade na BSPay
```

Esperado no health: `"bspayConfigured":true`, `"mockPix":false`.

## 5. O que NÃO pode ser compartilhado

O arquivo `.env` **não vai junto**: ele contém o `client_secret` da BSPay e o token da API
de CPF. Envie esses valores por um canal seguro (gerenciador de senhas) e a pessoa cola no
`.env` dela. A pasta `data/` guarda dados de clientes e cresce em tempo de execução — não
precisa ir e não deve ser exposta publicamente.

## Estrutura

```
server.js                 servidor HTTP (API + arquivos do site)
package.json              scripts (start, checks)
lib/                      configuração, BSPay, CPF, CEP, produtos, ordens, QR
lib/vendor/               gerador de QR (puro JS, sem dependências)
public/                   o site (HTML, CSS, JS compilado, ícones)
deploy/valore.service     unit do systemd
Dockerfile, docker-compose.yml, ecosystem.config.cjs, .dockerignore, .gitignore
.env.example              modelo das variáveis
README.md                 documentação completa (rotas, API, testes)
```

Rotas principais da API: `/api/products`, `/api/cpf-lookup`, `/api/visitors`,
`/api/orders`, `/api/orders/:id`, `/api/webhooks/bspay`, `/api/health`.
