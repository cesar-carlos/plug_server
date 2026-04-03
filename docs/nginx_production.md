# Nginx em Producao

Este guia documenta os ajustes recomendados de Nginx para o `plug_server`.

**Ficheiro pronto a copiar:** [`deploy/nginx/plug_server.conf.example`](../deploy/nginx/plug_server.conf.example) (ajustar `server_name`, SSL e caminhos).

Cobertura:

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

## 3) Fragmentos para `http { }`

Colocar **uma vez** no contexto `http` (antes dos `server`):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream plug_server_upstream {
    server 127.0.0.1:3000;
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

    location /docs/ {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_pass http://plug_server_upstream/docs/;
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
4. Instalar a configuracao (ex.: copiar de `deploy/nginx/plug_server.conf.example`), validar com `nginx -t` e recarregar (`systemctl reload nginx`).
5. Testar:
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

## 10) Rate limit e timeouts na borda

- **limit_req** em `/docs/`, **/metrics**, rotas de **login/registo/refresh** (paths alinhados ao Express) e **API geral** — complementa o rate limit da aplicacao.
- **limit_conn** por IP no `server` — teto de conexoes simultaneas por cliente.
- **Timeouts curtos** (15s/60s) por defeito; **Socket.IO** usa regex `^/socket\.io(/|$)` e timeouts longos (24h) so nesse bloco.

Ajuste as zonas (`rate`, `burst`) se houver falsos positivos ou trafego interno legitimo (ex.: health checks em massa).

## 11) TLS global, logs e multi-instancia

- **`nginx.conf` (http):** endurecer `ssl_protocols` para **TLSv1.2 TLSv1.3**, `ssl_prefer_server_ciphers off`, e `server_tokens off` (afeta todos os virtual hosts no mesmo servidor).
- **Logs:** em Ubuntu o pacote `nginx` costuma instalar rotacao em `/etc/logrotate.d/nginx`; confirmar espaco em disco e retencao.
- **Multi-instancia / balanceador:** se houver varios processos Node, o storage em `UPLOADS_DIR` tem de ser **partilhado** (NFS, object storage) ou o Nginx tem de servir sempre o mesmo volume; caso contrario thumbnails podem falhar apos mudanca de instancia.
