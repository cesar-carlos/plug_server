# Nginx em Producao

Este guia documenta os ajustes recomendados de Nginx para o `plug_server`.

**Ficheiros prontos a copiar:** [`deploy/nginx/conf.d/`](../deploy/nginx/conf.d/), [`deploy/nginx/snippets/`](../deploy/nginx/snippets/), [`deploy/nginx/sites/plug-server.example.conf`](../deploy/nginx/sites/plug-server.example.conf) (ajustar `server_name`, SSL e caminhos). Indice em [`deploy/nginx/plug_server.conf.example`](../deploy/nginx/plug_server.conf.example).

Cobertura:

- Pagina inicial em `/` (HTML), `favicon.ico`, `site.webmanifest`, estaticos em `/assets/` (icones Swagger, PWA)
- API HTTP em `/api/v1` (inclui `client-auth`, recuperacao de senha, health, metricas duplicadas em `/api/v1/metrics`)
- Socket.IO (`/socket.io`)
- Arquivos publicos em `/uploads` e upload de thumbnail (`POST /api/v1/client-auth/thumbnail`)
- Swagger UI em `/docs/` (com redirect de `/docs` para `/docs/`)
- Metricas em `/metrics` (raiz) e `/api/v1/metrics` (coberto pelo prefixo `/api/v1/`)
- Auth legado em `/auth/`

## 1) Objetivo operacional

Configurar o proxy reverso para:

- encaminhar trafego HTTP/Socket para a app Node
- preservar `X-Forwarded-*` para `trust proxy`
- permitir upload de imagem ate ao limite configurado no backend (ate 10 MiB)
- expor a rota publica de thumbnails sem quebrar cache/proxy
- opcionalmente servir `/uploads` em disco direto pelo Nginx (alias) para menos carga no Node

## 2) Premissas do backend

Verificar no backend:

- `HTTP_TRUST_PROXY=true` em producao (default em `env.ts` quando `NODE_ENV=production`)
- `UPLOADS_DIR` apontando para diretorio persistente no servidor (o `alias` do Nginx deve ser o mesmo path absoluto)
- `UPLOADS_PUBLIC_BASE_URL` com URL publica final (ex.: `https://api.seudominio.com/uploads`)
- `CLIENT_THUMBNAIL_MAX_BYTES` <= `client_max_body_size` no Nginx (o exemplo usa **11m** para cobrir o teto de **10 MiB** em `env.ts` com margem para multipart)
- `SWAGGER_ENABLED=true` em producao se `/docs/` deve estar disponivel
- Apos cada `npm install` ou deploy, sincronizar assets estaticos do Swagger UI para disco legivel pelo Nginx (`www-data`):

```bash
npm run sync:swagger-static
# ou: bash scripts/sync-swagger-ui-static.sh
```

Destino padrao: `/var/lib/plug_server/swagger-ui-dist/` (`swagger-ui.css`, `swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`). O HTML (`/docs/`), `swagger-ui-init.js`, `/docs.json` e `/docs/swagger-onload-fallback.js` continuam no Node upstream.

## 3) Fragmentos para `http { }`

Colocar **uma vez** no contexto `http` (antes dos `server`):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream plug_server_upstream {
    server 127.0.0.1:4000;
    keepalive 64;
}
```

## 4) Redirect HTTP para HTTPS

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name api.seudominio.com;
    return 301 https://$host$request_uri;
}
```

## 5) Exemplo de server block HTTPS

Exemplo base (ajustar dominio, certificados e upstream):

```nginx
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name api.seudominio.com;

    ssl_certificate     /etc/letsencrypt/live/api.seudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.seudominio.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    # >= CLIENT_THUMBNAIL_MAX_BYTES (max 10 MiB) + margem multipart
    client_max_body_size 11m;

    proxy_connect_timeout 15s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;

    location /uploads/ {
        alias /var/lib/plug_server/uploads/;
        access_log off;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
        try_files $uri =404;
    }

    location /socket.io/ {
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_pass http://plug_server_upstream;
    }

    location = /docs {
        return 301 $scheme://$host/docs/;
    }

    # Assets versionados do swagger-ui-dist: servir do disco (apos npm run sync:swagger-static).
    location = /docs/swagger-ui.css {
        alias /var/lib/plug_server/swagger-ui-dist/swagger-ui.css;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
    }

    location = /docs/swagger-ui-bundle.js {
        alias /var/lib/plug_server/swagger-ui-dist/swagger-ui-bundle.js;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
    }

    location = /docs/swagger-ui-standalone-preset.js {
        alias /var/lib/plug_server/swagger-ui-dist/swagger-ui-standalone-preset.js;
        access_log off;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
    }

    location = /docs.json {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_pass http://plug_server_upstream;
    }

    # Swagger UI carrega varios assets em paralelo (JS/CSS/favicon). Nao aplique
    # `limit_req` em /docs/, pois refresh do navegador pode levantar 503 nos assets.
    # `^~` aqui e seguro: locations `=` acima (CSS/bundle/preset) tem precedencia.
    # Evite `^~ /docs/` *sem* esses blocos `=` — um regex generico pode capturar assets.

    location ^~ /docs/ {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_pass http://plug_server_upstream/docs/;
    }

    # Raiz (`GET /` HTML), `favicon.ico`, `manifesto PWA`, icones em `/assets/`
    # (inclui favicon custom do Swagger). O Node devolve 404 para pedidos a
    # `/assets/...` com segmento oculto (ex. `.internal/`). Proxy para o Node;
    # evitar `limit_req` estrito em `/assets/` se notar 503 em refresh com muitos
    # pedidos paralelos.

    location = / {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://plug_server_upstream;
    }

    location = /favicon.ico {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://plug_server_upstream;
    }

    location = /site.webmanifest {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://plug_server_upstream;
    }

    location /assets/ {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://plug_server_upstream;
    }

    location = /metrics {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://plug_server_upstream;
    }

    location /api/v1/ {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_pass http://plug_server_upstream;
    }

    location /auth/ {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_pass http://plug_server_upstream;
    }
}
```

Se preferir que o **Node** sirva `/uploads` (sem `alias`), remova o bloco `location /uploads/` e acrescente antes de `/api/v1/`:

```nginx
location /uploads/ {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://plug_server_upstream;
}
```

## 6) Upload de thumbnail: pontos criticos

- `client_max_body_size` no Nginx deve ser >= `CLIENT_THUMBNAIL_MAX_BYTES`. Se reduzir o exemplo para **5m**, nao aumente o backend acima disso.
- Se o Nginx servir `/uploads` via `alias`, manter permissao de leitura para o utilizador do Nginx.
- Garantir persistencia em disco (volume) para nao perder thumbnails em restart/deploy.
- Definir rotina de backup e limpeza de thumbnails antigas/orfas se o volume nao for descartavel.
- Em ambiente multi-instancia, preferir storage partilhado/objeto remoto; storage local por pod/VM pode quebrar acesso ao ficheiro apos balanceamento ou troca de instancia.

## 7) Header forwarding e seguranca

Recomendado manter:

- `X-Forwarded-For`
- `X-Forwarded-Proto`
- `Host`
- `X-Forwarded-Host` (onde aplicavel)

Tambem e recomendado:

- redirecionar HTTP para HTTPS
- usar HSTS no endpoint publico (ajustar `max-age` e `includeSubDomains` a politica do dominio)
- restringir origem no backend (`CORS_ORIGIN`), sem `*` em producao
- em producao, restringir `/docs` por IP ou firewall se nao quiseres documentacao publica

## 8) Checklist de deploy

1. Aplicar migrations de banco referentes a `thumbnail_url` e `client_password_recovery_tokens`.
2. Atualizar `.env` com `UPLOADS_DIR`, `UPLOADS_PUBLIC_BASE_URL` e `CLIENT_THUMBNAIL_MAX_BYTES`.
3. Criar diretorio persistente de upload e validar permissoes.
4. `npm install` (dispara `postinstall` → `sync:swagger-static` quando `/var/lib/plug_server` existe) ou manualmente `npm run sync:swagger-static` apos cada deploy que altere `swagger-ui-express`.
5. Instalar a configuracao (ex.: copiar de `deploy/nginx/plug_server.conf.example`), validar com `nginx -t` e recarregar (`systemctl reload nginx`).
6. Testar:
   - `POST /api/v1/client-auth/thumbnail`
   - acesso direto a URL publica da thumbnail
   - `POST /api/v1/client-auth/password-recovery/request` e fluxo HTML em `/api/v1/client-auth/password-recovery/review`
   - Socket.IO a conectar normalmente
   - `GET /docs/` (Swagger) se esperado em producao

## 9) Producao: referencia de ficheiros (servidor)

No ambiente de producao atual, a configuracao pode estar dividida assim:

| Ficheiro | Conteudo |
| -------- | -------- |
| `/etc/nginx/conf.d/00-connection-upgrade-map.conf` | `map $http_upgrade $connection_upgrade` |
| `/etc/nginx/conf.d/01-plug-rate-limit.conf` | `limit_req_zone` e `limit_conn_zone` |
| `/etc/nginx/snippets/plug_server_proxy.conf` | Headers e `proxy_pass` para o Node |
| `sites-available/plug-server...` | `server` HTTPS, `location` por rota |

O mapa completo comentado esta em [`deploy/nginx/plug_server.conf.example`](../deploy/nginx/plug_server.conf.example).

### Diagnostico: Swagger em branco ou 503 (ex.: `favicon-16x16.png`, `swagger-ui-*.js`)

1. **Isolar o Node (sem Nginx):** no servidor, `curl -I http://127.0.0.1:<PORT>/docs/swagger-ui-bundle.js` (usar a mesma `PORT` do `.env`). Deve ser **200**. Se for, a app est OK; o problema e **Nginx, balanceador, CDN (Cloudflare) ou WAF** na borda, nao o Express. Em paralelo, `GET /api/v1/health/ready` expoe `checks.swaggerEnabled` (espelha `SWAGGER_ENABLED`): se for `true` mas o dominio publico der 503 em `/docs/*`, confirma que o bloqueio e na borda.
2. **Nginx ativo vs repositorio:** o ficheiro `deploy/nginx/plug_server.conf.example` nao aplica sozinho. Conferir o site real com `sudo nginx -T | grep -nE 'location .*docs|plug_docs|limit_req|proxy_pass'`. Nao use `limit_req` em `location /docs/`. Use `location =` para CSS/bundle/preset **antes** do catch-all `^~ /docs/` (ver `deploy/nginx/sites/plug-server.example.conf`). Confirme que `npm run sync:swagger-static` foi executado apos o ultimo deploy.
3. **Apos corrigir:** `sudo nginx -t && sudo systemctl reload nginx`. Testar com janela anonima (sem cache) e, no browser, aba *Rede* a ver se algum pedido a `/docs/*` devolve **503**.
4. **CDN / Cloudflare:** regras de *rate limit*, *Bot protection* ou *cache* de HTML/JS podem fazer a primeira carga ir bem e o **F5** cor mal. No painel, ver logs por URI `/docs/*` e desativar cache ou limites para teste nessa rota.

O teste de integracao `tests/integration/swagger_docs.integration.test.ts` confirma que `/docs/`, o bundle e o `favicon` (quando presente) respondem a nivel da aplicacao.

Script operacional (no servidor, com `bash`): [`scripts/check_swagger_edge.sh`](../scripts/check_swagger_edge.sh) — define `PORT` e `PUBLIC_URL` para comparar HTTP codes no Node vs na borda.

Para incidente intermitente (F5 as vezes carrega, as vezes 503), rode a amostragem repetida:

```bash
PORT=4000 PUBLIC_URL=https://api.seudominio.com npm run check:swagger-flaky
```

Saida esperada em ambiente estavel: apenas `200` na secao **Estabilidade em repeticao** e na secao **Simulacao de F5 (rajada de assets)**.
Se aparecer `503` em qualquer asset de `/docs/*`, o bloqueio e de borda (Nginx/CDN/WAF/rate limit), nao da app Node.

## 10) Rate limit e timeouts na borda

A **aplicação** (`REST_*_RATE_LIMIT_*`) é a autoridade — respostas **429 JSON** com `RateLimit-*`. O Nginx complementa com tectos altos anti-abuso.

| Componente | Valor | Notas |
| ---------- | ----- | ----- |
| `plug_auth_strict` | 90/min, burst 30 | Só **register** e **password-recovery/request** |
| `plug_api` | **150/s**, burst **900** | Login, refresh, API geral (afrouxado para NAT / muitos agentes) |
| `plug_conn` | **240** conexões/IP | Dashboards com muitos sockets no mesmo IP |
| `plug_metrics` | 360/min, burst 60 | `/metrics` |
| `POST .../agents/commands` | `proxy_read_timeout` **180s** | Evita 503 por timeout de 60s em RPC longos |
| Resto da API | 15s connect / **60s** read | Default no `server` block |
| Socket.IO | 24h read/send | Regex `^/socket\.io(/|$)` |

- **Sem `limit_req` em `/docs/`** — Swagger carrega assets em paralelo.
- Ficheiros: `deploy/nginx/conf.d/01-plug-rate-limit.conf`, `deploy/nginx/sites/plug-server.example.conf`.
- Guia completo: [`docs/limits/limites_acesso_e_quotas.md`](limits/limites_acesso_e_quotas.md).
- Alertas Prometheus: [`docs/observability/alerts/rate_limits.yml`](observability/alerts/rate_limits.yml).

Ajuste `rate`/`burst` se houver falsos positivos; prefira subir limites **na app** antes de apertar Nginx em login/refresh.

## 11) Compressao coordenada (gzip)

A partir desta versao, `plug_server` usa o middleware `compression` do
Express e ja entrega respostas gzipadas (>=1 KiB) para clientes que enviam
`Accept-Encoding: gzip`. O cliente que nao suporta compressao continua
recebendo o mesmo corpo bytes-identico em texto puro (`compression` so age
quando o cliente pede). Nenhuma resposta muda de shape — apenas o transporte.

No Nginx, o ajuste essencial e **nao recomprimir** respostas que chegam ja
comprimidas do upstream:

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_proxied off;                  # default: nao gzip-a proxied responses
gzip_types
    application/json
    application/javascript
    application/xml
    text/css
    text/html
    text/plain
    text/xml
    image/svg+xml;
```

O default do `gzip_proxied` ja e `off`, o que significa que o Nginx **nao**
toca em respostas vindas do `proxy_pass` (o Node ja entregou gzipado).
O `gzip on` se aplica ao que o proprio Nginx serve direto (ex.: `alias`
de `/uploads/` para imagens — que ja sao binarias e nao comprimem,
portanto inofensivo).

Se preferir centralizar a compressao no Nginx, defina `gzip_proxied any`
e desabilite o `compression` no Express via flag. Comprimir nos dois
extremos ao mesmo tempo corrompe `Content-Encoding` e quebra clientes.

O middleware Express respeita o header `X-No-Compression` (skip), util
para load tests de baseline e comparacoes A/B.

Snippet em `deploy/nginx/plug_server.conf.example` (`03-plug-gzip.conf`).

## 12) TLS global, logs e multi-instancia

- **`nginx.conf` (http):** endurecer `ssl_protocols` para **TLSv1.2 TLSv1.3**, `ssl_prefer_server_ciphers off`, e `server_tokens off` (afeta todos os virtual hosts no mesmo servidor).
- **Logs:** em Ubuntu o pacote `nginx` costuma instalar rotacao em `/etc/logrotate.d/nginx`; confirmar espaco em disco e retencao.
- **Multi-instancia / balanceador:** se houver varios processos Node, o storage em `UPLOADS_DIR` tem de ser **partilhado** (NFS, object storage) ou o Nginx tem de servir sempre o mesmo volume; caso contrario thumbnails podem falhar apos mudanca de instancia.

## 13) Upstream e `X-Hub-Instance-Id`

O deploy suportado e **um unico processo** em `127.0.0.1:4000` (ver
`deploy/pm2/ecosystem.config.cjs` e `deploy/nginx/plug_server.conf.example`).
Nao e necessario `ip_hash` nem cookie de afinidade no Nginx.

Defina `HUB_INSTANCE_ID` (ex.: `plug-4000`) para observabilidade. **Toda resposta
Express** pode incluir `X-Hub-Instance-Id` via `hubInstanceIdMiddleware`:

```bash
curl -sI -H "Authorization: Bearer $TOKEN" \
  https://api.seudominio.com/api/v1/client/me/agents \
  | grep -i x-hub-instance-id
```

O valor deve ser estavel (sempre o mesmo hub).
