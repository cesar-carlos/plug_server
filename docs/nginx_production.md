# Nginx em Producao

Este guia documenta os ajustes recomendados de Nginx para o `plug_server`,
considerando:

- API HTTP em `/api/v1`
- Socket.IO (`/socket.io`)
- arquivos de thumbnail servidos em `/uploads`
- upload de thumbnail (`POST /api/v1/client-auth/thumbnail`)

## 1) Objetivo operacional

Configurar o proxy reverso para:

- encaminhar trafego HTTP/Socket para a app Node
- preservar `X-Forwarded-*` para `trust proxy`
- permitir upload de imagem dentro do limite configurado
- expor a rota publica de thumbnails sem quebrar cache/proxy

## 2) Premissas do backend

Verificar no backend:

- `HTTP_TRUST_PROXY=true` em producao (ja previsto em `env.ts`)
- `UPLOADS_DIR` apontando para diretorio persistente no servidor
- `UPLOADS_PUBLIC_BASE_URL` com URL publica final (ex.: `https://api.seudominio.com/uploads`)
- `CLIENT_THUMBNAIL_MAX_BYTES` coerente com `client_max_body_size` no Nginx

## 3) Exemplo de server block

Exemplo base (ajustar dominio, certificados e upstream):

```nginx
upstream plug_server_upstream {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 443 ssl http2;
    server_name api.seudominio.com;

    # SSL (exemplo)
    ssl_certificate     /etc/letsencrypt/live/api.seudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.seudominio.com/privkey.pem;

    # Upload: manter igual ou maior que CLIENT_THUMBNAIL_MAX_BYTES
    client_max_body_size 5m;

    # Timeouts conservadores para API
    proxy_connect_timeout 15s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;

    # Se quiser servir arquivos direto pelo Nginx (mais eficiente),
    # use alias para o mesmo diretorio de UPLOADS_DIR.
    location /uploads/ {
        alias /var/lib/plug_server/uploads/;
        access_log off;
        expires 7d;
        add_header Cache-Control "public, max-age=604800";
        try_files $uri =404;
    }

    # API REST
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

    # Socket.IO (namespace /agents e /consumers usam este endpoint de transporte)
    location /socket.io/ {
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_pass http://plug_server_upstream;
    }

    # Rotas legadas fora de /api/v1 (se usadas)
    location /auth/ {
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_pass http://plug_server_upstream;
    }
}
```

## 4) Upload de thumbnail: pontos criticos

- `client_max_body_size` no Nginx deve ser >= `CLIENT_THUMBNAIL_MAX_BYTES`.
- Se o Nginx servir `/uploads` via `alias`, manter permissao de leitura para o usuario do Nginx.
- Se preferir que o Node sirva `/uploads`, remova o bloco `location /uploads/` e encaminhe para upstream.
- Garantir persistencia em disco (volume) para nao perder thumbnails em restart/deploy.
- Definir rotina de backup e limpeza de thumbnails antigas/orfas se o volume nao for descartavel.
- Em ambiente multi-instancia, preferir storage compartilhado/objeto remoto; storage local por pod/VM pode quebrar acesso ao arquivo apos balanceamento ou troca de instancia.

## 5) Header forwarding e seguranca

Recomendado manter:

- `X-Forwarded-For`
- `X-Forwarded-Proto`
- `Host`

Isso evita inconsistencias de IP/URL base e ajuda em logs/rate-limit.

Tambem e recomendado:

- redirecionar HTTP para HTTPS
- usar HSTS no endpoint publico
- restringir origem no backend (`CORS_ORIGIN`), sem `*` em producao

## 6) Checklist de deploy

1. Aplicar migration de banco referente a `thumbnail_url` e `client_password_recovery_tokens`.
2. Atualizar `.env` com `UPLOADS_DIR`, `UPLOADS_PUBLIC_BASE_URL` e `CLIENT_THUMBNAIL_MAX_BYTES`.
3. Criar diretorio persistente de upload e validar permissoes.
4. Publicar e recarregar config Nginx (`nginx -t` e depois `systemctl reload nginx`).
5. Testar:
   - `POST /api/v1/client-auth/thumbnail`
   - acesso direto a URL retornada da thumbnail
   - `POST /api/v1/client-auth/password-recovery/request`
   - Socket.IO conectando normalmente
