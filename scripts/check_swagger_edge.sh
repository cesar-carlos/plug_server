#!/usr/bin/env bash
# Compara respostas do Swagger na app Node (localhost) vs URL publica (Nginx/CDN).
# Uso no servidor:
#   PORT=3000 PUBLIC_URL=https://seu-dominio.com bash scripts/check_swagger_edge.sh
set -euo pipefail

PORT="${PORT:-3000}"
# URL publica (HTTPS) — obrigatoria para comparar borda com Node
PUBLIC_URL="${PUBLIC_URL:-}"
LOCAL_BASE="http://127.0.0.1:${PORT}"

code() {
  local url="$1"
  curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 3 --max-time 15 "$url" || echo "ERR"
}

echo "=== Node direto (sem Nginx): ${LOCAL_BASE} ==="
echo "GET /docs/ -> $(code "${LOCAL_BASE}/docs/")"
echo "GET /docs/swagger-ui-bundle.js -> $(code "${LOCAL_BASE}/docs/swagger-ui-bundle.js")"
echo "GET /docs/favicon-16x16.png -> $(code "${LOCAL_BASE}/docs/favicon-16x16.png")"
echo ""
if [ -n "$PUBLIC_URL" ]; then
  echo "=== Readiness (URL publica): ${PUBLIC_URL}/api/v1/health/ready ==="
  if ! curl -sS --connect-timeout 5 --max-time 15 "${PUBLIC_URL}/api/v1/health/ready" | head -c 800; then
    echo "(falhou o curl para ${PUBLIC_URL})"
  fi
  echo ""
  echo "=== Borda (URL publica): ${PUBLIC_URL} ==="
  echo "GET /docs/ -> $(code "${PUBLIC_URL}/docs/")"
  echo "GET /docs/swagger-ui-bundle.js -> $(code "${PUBLIC_URL}/docs/swagger-ui-bundle.js")"
  echo "GET /docs/favicon-16x16.png -> $(code "${PUBLIC_URL}/docs/favicon-16x16.png")"
  echo ""
else
  echo "=== Readiness e borda: omitido (defina PUBLIC_URL=https://seu-dominio) ==="
  echo "GET local /api/v1/health/ready -> $(code "${LOCAL_BASE}/api/v1/health/ready")"
  echo ""
fi
echo "Se 'Node direto' devolver 200 e a borda 503, o problema e Nginx/CDN/WAF, nao o Express."
