#!/usr/bin/env bash
# Compara respostas do Swagger na app Node (localhost) vs URL publica (Nginx/CDN),
# incluindo amostragem repetida para capturar falhas intermitentes (ex.: F5).
# Uso no servidor:
#   PORT=3000 PUBLIC_URL=https://seu-dominio.com LOOPS=30 BURST=8 bash scripts/check_swagger_edge.sh
set -euo pipefail

PORT="${PORT:-3000}"
# URL publica (HTTPS) — obrigatoria para comparar borda com Node
PUBLIC_URL="${PUBLIC_URL:-}"
LOCAL_BASE="http://127.0.0.1:${PORT}"
LOOPS="${LOOPS:-20}"
BURST="${BURST:-6}"
MAX_TIME="${MAX_TIME:-15}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-3}"

code() {
  local url="$1"
  curl -sS -o /dev/null -w "%{http_code}" --connect-timeout "${CONNECT_TIMEOUT}" --max-time "${MAX_TIME}" "$url" || echo "ERR"
}

sample_codes() {
  local label="$1"
  local url="$2"
  local loops="$3"

  echo "--- ${label} (${loops}x) ---"
  local tmp_file
  tmp_file="$(mktemp)"

  for _ in $(seq 1 "${loops}"); do
    code "$url" >>"${tmp_file}"
    echo >>"${tmp_file}"
  done

  sort "${tmp_file}" | uniq -c | sed 's/^ *//'
  rm -f "${tmp_file}"
}

burst_codes() {
  local label="$1"
  local url="$2"
  local burst="$3"

  echo "--- ${label} (rajada paralela ${burst}x) ---"
  local tmp_file
  tmp_file="$(mktemp)"

  seq "${burst}" | xargs -I{} -P "${burst}" sh -c \
    "curl -sS -o /dev/null -w '%{http_code}\n' --connect-timeout '${CONNECT_TIMEOUT}' --max-time '${MAX_TIME}' '${url}' || echo ERR" \
    >"${tmp_file}"

  sort "${tmp_file}" | uniq -c | sed 's/^ *//'
  rm -f "${tmp_file}"
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
  echo "=== Estabilidade em repeticao (${LOOPS}x) ==="
  sample_codes "Borda /docs/" "${PUBLIC_URL}/docs/" "${LOOPS}"
  sample_codes "Borda /docs/swagger-ui-bundle.js" "${PUBLIC_URL}/docs/swagger-ui-bundle.js" "${LOOPS}"
  sample_codes "Borda /docs/swagger-ui-init.js" "${PUBLIC_URL}/docs/swagger-ui-init.js" "${LOOPS}"
  sample_codes "Borda /docs/favicon-16x16.png" "${PUBLIC_URL}/docs/favicon-16x16.png" "${LOOPS}"
  echo ""
  echo "=== Simulacao de F5 (rajada de assets) ==="
  burst_codes "Borda /docs/swagger-ui-bundle.js" "${PUBLIC_URL}/docs/swagger-ui-bundle.js" "${BURST}"
  burst_codes "Borda /docs/swagger-ui-init.js" "${PUBLIC_URL}/docs/swagger-ui-init.js" "${BURST}"
  burst_codes "Borda /docs/favicon-16x16.png" "${PUBLIC_URL}/docs/favicon-16x16.png" "${BURST}"
  echo ""
else
  echo "=== Readiness e borda: omitido (defina PUBLIC_URL=https://seu-dominio) ==="
  echo "GET local /api/v1/health/ready -> $(code "${LOCAL_BASE}/api/v1/health/ready")"
  echo ""
fi
echo "Se 'Node direto' devolver 200 e a borda 503, o problema e Nginx/CDN/WAF, nao o Express."
