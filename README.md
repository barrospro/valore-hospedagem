# Valore — clone exato do site, só com o nome trocado

O site em `public/` **é o próprio site original**, arquivo por arquivo: mesmo HTML,
mesmo CSS, mesmo bundle JavaScript compilado. A única alteração é o nome da marca
(`ecred` → `valore`, `Ecred` → `Valore`). Nada de layout, texto, markup ou lógica
foi reescrito à mão.

```
valore/
├─ public/                 <- O SITE (espelho do original, marca trocada)
│  ├─ index.html           idêntico, exceto "Painel Valore" no <script> de título
│  ├─ assets/index-DNDXb9c6.js   1,55 MB — bundle original, 16 trocas de marca
│  ├─ assets/index-DUL9RZWL.css  164 KB — byte a byte igual (0 trocas)
│  ├─ favicon.svg          idêntico
│  └─ pix-106.svg          idêntico
├─ mirror-src/             <- fontes do espelho (o download original, intacto)
├─ tools/build-mirror.cjs  <- refaz o espelho a partir de mirror-src
├─ server.js               <- API que o site consome (contratos idênticos)
├─ lib/                    BSPay, CPF, CEP, produtos, ordens, QR PNG
└─ tests/                  driver E2E do site espelhado + mock da BSPay
```

## Como o espelho foi feito

1. Baixados os arquivos exatos do site:

   | Arquivo | Bytes |
   |---|---|
   | `/index.html` | 1.686 |
   | `/assets/index-DNDXb9c6.js` | 1.551.492 |
   | `/assets/index-DUL9RZWL.css` | 163.820 |
   | `/favicon.svg` | 446 |
   | `/pix-106.svg` | 7.847 |

2. Trocado **apenas o nome da marca** (`tools/build-mirror.cjs`):

   ```
   assets/index-DNDXb9c6.js  1551492 -> 1551508 bytes · 16 trocas
     valore:sim · valore:brand · valore:visitor · valore:utm · valore:push-origin
     valore:visitor-cpf · valore:redirected · valore:dash:token · valore:dash:pathkey
     valore:dash · JU="valore" (nome padrão) · "Valore" (4 rótulos visíveis)
   assets/index-DUL9RZWL.css 163820 -> 163820 bytes · 0 trocas
   favicon.svg                      446 ->    446 bytes · 0 trocas
   index.html                      1686 ->   1687 bytes · 1 troca ("Painel Valore")
   pix-106.svg                     7847 ->   7847 bytes · 0 trocas
   ```

   Nenhuma ocorrência de `ecred`/`Ecred` sobrou no bundle — e a troca acontece só
   dentro de literais de string, sem tocar em identificadores ou lógica.

3. Refazer a qualquer momento:

   ```powershell
   node tools/build-mirror.cjs           # regrava public/
   node tools/build-mirror.cjs --check   # só relata as diferenças
   ```

> Detalhe interessante do próprio bundle: a marca já era dinâmica — o site lê
> `?brand=` ou `localStorage["<marca>:brand"]` e usa o valor no logo e no nome do
> recebedor do PIX. Por isso a troca do nome é completa e não deixa resíduo.

## Rodar

```powershell
cd valore
Copy-Item .env.example .env     # preencha as credenciais
node server.js                  # http://127.0.0.1:3000
```

## API que o site consome (contratos observados em produção e replicados)

| Rota | Resposta |
|---|---|
| `GET /api/settings` | `{"activeGatewayId":"bspay"}` |
| `GET /api/gateway-fee` | `{"fixed":1.3,"percent":5.99}` |
| `GET /api/products` | array cru com `id, kind, name, gatewayName, category, description, price, unit, imageUrl, sortOrder` |
| `POST /api/cpf-lookup` `{cpf}` | `{"configured":true,"name","birthDate","phone":null,"motherName"}` |
| ↳ `phone` | devolvido sempre `null`: o campo **Celular (WhatsApp)** da tela de confirmação fica vazio para o cliente digitar (não vem puxado da consulta) |
| `POST /api/visitors` | visitante completo (`id, stage, stageIndex, status, utm*, cpf, name, …`) |
| `GET/PATCH /api/visitors/:id` | visitante completo — `status`: `em_andamento` \| `abandonou` \| `comprador` |
| `POST /api/orders` `{visitorId, productId, bumpIds, pushNotificationId}` | `{"configured":true,"order":{"id","status","amount","totalPrice","qrCodeText","qrCodeBase64"}}` |
| `GET /api/orders/:id` | `{"id","status","paidAt"}` — `status`: `PENDING` → `COMPLETED` |
| `POST /api/webhooks/bspay` | webhook `cashin.confirmed` (HMAC-SHA256 sobre o body cru) |

Extras operacionais (não usados pelo site): `GET /api/health`, `GET /api/admin/stats`,
`GET /api/cep/:cep`, `POST /api/orders/:id/simulate-paid` (só com `ALLOW_MOCK_PIX=1`).

O catálogo de produtos é o mesmo do site, com todos os 9 produtos e 3 order bumps
(`seguro-basico` 16, `seguro-plus` 29, `seguro-premium` 45, `iof` 19,
`tarifa-cadastro` 14, `taxa-app` 17, `aumento-limite` 18, `tarifa-prioridade` 11,
`taxa-protecao` 65, `bump-suporte` 9, `bump-credito` 22, `bump-cartao` 19).
Só o nome do bump de cartão cita a marca: **Cartão de Crédito Valore**.

## PIX

`POST /api/orders` chama a BSPay (`POST /v2/transactions/cashin`) e devolve o PIX
no formato que o site espera:

- `qrCodeText` = `data.payment_info.qrcode` (copia e cola EMV)
- `qrCodeBase64` = PNG do QR gerado no servidor (`lib/qrimg.js`, PNG escrito à mão
  com zlib nativo — sem canvas, sem dependências nativas)
- `status` = `PENDING`; o site faz polling em `GET /api/orders/:id` a cada 4 s e
  entra em `COMPLETED` quando o pagamento é confirmado pelo webhook
  `cashin.confirmed` (HMAC validado) ou pela reconciliação com
  `POST /v2/account/transactions/list`

Sem credenciais da BSPay e com `ALLOW_MOCK_PIX=1`, o servidor gera um BR Code local
válido para o fluxo continuar testável de ponta a ponta.

## Testado

Fluxo completo no navegador, no site espelhado (`tests/flow.mirror.e2e.js`):

```
landing: / -> /valor          renda: /renda -> /analise
simulacao: /valor -> /cpf     analise: /analise -> /dia
cpf: /cpf -> /confirmacao     dia: /dia -> /endereco
confirmacao: -> /dados        endereco: /endereco -> /conta
dados: /dados -> /renda       conta: /conta -> /digital
digital: /digital -> /seguro  seguro: /seguro -> /checkout
checkout: /checkout -> /pagamento
pagamento: QR PNG renderizado (data:image/png;base64,iVBORw0K…)
```

Rodar:

```powershell
cd ..\browserctl
powershell -ExecutionPolicy Bypass -File .\chrome-debug.ps1 -Headless -Port 9222
node .\ctl.mjs --port 9222 nav "http://127.0.0.1:3000/"
node .\ctl.mjs --port 9222 eval "@..\valore\tests\flow.mirror.e2e.js"
```

Contratos da BSPay também validados contra gateway local (`tests/mock-bspay.js`):

```
POST /v2/oauth/token              Basic base64(client_id:client_secret) + {"grant_type":"client_credentials"}
POST /v2/transactions/cashin      Bearer + amount/currency/external_id/postback_url/payer
POST /v2/account/transactions/list reconciliação -> ordem COMPLETED
```

Webhook: assinatura correta marca `COMPLETED`; assinatura inválida devolve **401**.

## Produção

### Estado das credenciais (22/09/2026)

| Item | Valor |
|---|---|
| Credencial criada no painel | **Valore** — `maykguerreiro_…17f` |
| Caso de uso / escopo | `checkout` / moedas locais (BRL) |
| Domínio cadastrado | `https://raspamoneypix.online` |
| Permissões | `pix.receive`, `transactions.read`, `balance.read`, `fees.read`, `limits.read`, `profile.read`, `integrations.add` |
| `client_secret` | no `valore/.env` (64 caracteres) — só aparece uma vez no painel. **Não versionar e não enviar para terceiros** |
| `signing_key` | vazio (não existe no painel e não é usado no cash-in) |
| `webhook_secret` | vazio (mascarado no painel) → confirmação pela API |

Validação feita com essa credencial, contra a API real: autenticação OK, leitura de saldo OK
e cash-in OK (cobrança de teste criada com QR do gateway), além do fluxo completo do site
gerando o PIX real de R$ 29,00.

> Para trocar o segredo, crie outra credencial no painel e cole em `BSPAY_CLIENT_ID` /
> `BSPAY_CLIENT_SECRET`; valide com `npm run bspay:check` (e `npm run bspay:balance`).

### Onde ficam (e onde NÃO ficam) as credenciais da BSPay

Verificado no painel (`app.bspay.co/settings?tab=credentials`) em 22/09/2026:

| Item | Existe no painel? | O que fazer |
|---|---|---|
| `client_id` | ✅ visível na credencial | ex.: `maykguerreiro_6619…` |
| `client_secret` | ⚠️ **mostrado uma única vez** | o painel avisa: *"client_secret is shown only once after creation"*. Perdeu? Crie outra credencial |
| `signing_key` | ❌ **não existe no painel** | e **não é necessário para gerar QR PIX** — HMAC só é exigido em cashout, transferência interna e conversão (dinheiro saindo) |
| `webhook_secret` | ⚠️ mascarado | `GET /v2/account/credentials/list` devolve `whsec_********455d`. Sem o valor completo, o servidor confirma o pagamento consultando a API |

**Para gerar o QR do PIX bastam `client_id` + `client_secret`.** `signing_key` e
`webhook_secret` podem ficar vazios: o servidor se adapta e avisa no boot.

### Webhook de confirmação

- **Com `BSPAY_WEBHOOK_SECRET`**: valida `X-Webhook-Signature` (HMAC-SHA256 do corpo cru,
  comparação timing-safe) e a janela anti-replay de ±5 min do `X-Webhook-Timestamp`.
  Assinatura errada ou timestamp antigo → **401**.
- **Sem `BSPAY_WEBHOOK_SECRET`**: o webhook é tratado como aviso, nunca como prova — o
  servidor consulta a transação na BSPay e só marca `COMPLETED` quando o gateway confirma.
- Nos dois casos há **reconciliação**: `GET /api/orders/:id` consulta o extrato do gateway
  quando a ordem passa de 15 s pendente, então o pagamento é reconhecido mesmo sem webhook.

### ⚠️ O gateway valida o DNS do `postback_url`

Testado de verdade: com `BSPAY_POSTBACK_URL` apontando para um domínio que ainda não
resolve, a BSPay **recusa a cobrança** com `422 INVALID_POSTBACK_URL`
("Hostname could not be resolved"). Por isso o servidor tem duas proteções:

1. envia `postback_url` só quando a URL é HTTPS pública (ignora `SEU_DOMINIO`, localhost, IP);
2. se mesmo assim o gateway recusar, **refaz a cobrança sem postback** e suspende o postback
   por 10 min, avisando no log:

   ```
   [bspay] postback desativado por 10 min (o gateway não conseguiu resolver o domínio do postback).
   O pagamento será confirmado pela reconciliação.
   ```

Ou seja: o QR continua sendo gerado normalmente e o pagamento é confirmado pela
reconciliação. Assim que o DNS do domínio estiver no ar, o postback volta a ser enviado
sozinho (nada para reconfigurar).

### Variáveis de produção

| Variável | Valor | Para que serve |
|---|---|---|
| `NODE_ENV` | `production` | bloqueia rotas de teste e o PIX local |
| `BSPAY_CLIENT_ID` / `BSPAY_CLIENT_SECRET` | do painel | criam a cobrança na sua conta |
| `BSPAY_WEBHOOK_SECRET` | opcional | valida a assinatura do webhook |
| `BSPAY_POSTBACK_URL` | opcional | vazio = usa `PUBLIC_BASE_URL` e, na falta, o host da requisição |
| `PUBLIC_BASE_URL` | `https://seudominio.com.br` | monta o `postback_url` enviado à BSPay |
| `ALLOW_MOCK_PIX` | `0` | falha da BSPay aparece em vez de virar PIX local |
| `ADMIN_TOKEN` | token forte | protege `/api/admin/stats` (sem ele a rota fica oculta) |
| `CORS_ORIGINS` | vazio | vazio = same-origin; CSV libera domínios |
| `RATE_LIMIT_ORDERS_PER_MIN` / `RATE_LIMIT_CPF_PER_MIN` | 30 | limite por IP |
| `TRUST_PROXY` | `1` | confia em `X-Forwarded-For` / `CF-Connecting-IP` |
| `ACCESS_LOG` | `0`/`1` | log de acesso de uma linha por requisição |

No boot há um **preflight** que escreve no log o que está faltando (ex.:
`BSPAY_CLIENT_ID/BSPAY_CLIENT_SECRET não configurados`) e avisa se `ALLOW_MOCK_PIX`
ficou ligado em produção.

### Deploy

Docker/EasyPanel (o `Dockerfile` não roda `npm install` — o projeto não tem dependências):

```bash
docker build -t valore .
docker run -d --name valore --env-file .env -p 3000:3000 -v $(pwd)/data:/app/data valore
# ou
docker compose up -d
```

PM2 (VPS):

```bash
npm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save
```

systemd: `deploy/valore.service` (ajuste `User`, `WorkingDirectory`, `EnvironmentFile`).

Depois do deploy:

```bash
curl https://seudominio.com.br/api/health          # env production, mockPix false
curl "https://seudominio.com.br/api/health?deep=1" # autentica de verdade na BSPay
```

No painel da BSPay, confira que a credencial tem o domínio do site cadastrado e a
permissão `pix.receive` ligada. Se cadastrar webhook, aponte para
`https://seudominio.com.br/api/webhooks/bspay`.

### Teste do fluxo de produção

```powershell
node tests/mock-bspay.js 3099                      # gateway falso (terminal 1)
$env:NODE_ENV='production'; $env:ALLOW_MOCK_PIX='0'; $env:PORT='3012'
$env:BSPAY_API_BASE='http://127.0.0.1:3099'
$env:BSPAY_CLIENT_ID='test-client-id'; $env:BSPAY_CLIENT_SECRET='test-client-secret'
$env:BSPAY_WEBHOOK_SECRET='segredo-de-teste'
node server.js                                     # terminal 2
node tests/prod-flow.test.cjs 3012 segredo-de-teste
```

Resultado: **17/17 ok** com `webhook_secret`, **16/16** sem ele — cobrança no gateway,
QR PNG, assinatura inválida rejeitada (401), replay rejeitado (401), assinatura válida
marcando `COMPLETED`, idempotência, `simulate-paid` bloqueado e `/api/admin/stats` oculto.

> Um processo por vez: o `store` é um JSON local — dois servidores com o mesmo `DATA_DIR`
> sobrescrevem um ao outro. Em produção, `instances: 1` (já configurado no PM2).

## O que NÃO está implementado

O painel do operador (`/p/<chave>` e `/dash`) existe no bundle e abre, mas as rotas
dele (`/api/admin/*`, `/api/push/*`, `/api/payzu/*`, `/api/dash/*`) só existiam no
backend original e não foram reimplementadas — o foco é o site público com o checkout
PIX. Se quiser o painel também, é implementar essas rotas mantendo o mesmo formato.

## Trocar o nome novamente

1. Ajuste `REPLACEMENTS` em `tools/build-mirror.cjs` (ou passe outro par de strings).
2. `node tools/build-mirror.cjs`
3. O logo é dinâmico: `?brand=seunome` também funciona em runtime, sem rebuild.
