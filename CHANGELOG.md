# Changelog

Todas as mudancas notaveis neste projeto serao documentadas aqui.

O formato segue orientacoes de [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

## [Unreleased]

### Changed

- **Métricas REST bridge**: percentis p95/p99 de latencia usam **quickselect** compartilhado (`shared/utils/percentile.ts`).
- **Relay / `rpc_bridge`**: amostras de latencia por agente em **buffer circular** (`shared/utils/latency_ring_buffer.ts`); cleanup de streams/relay indexado por consumer/agent (**O(k)** no disconnect); `rpc:batch_ack` com varios IDs reutiliza **um** `JSON.stringify`+gzip por payload; logs de ack/stream em **DEBUG**.
- **Auditoria Socket**: opcao de **lote** (`SOCKET_AUDIT_BATCH_MAX` / `SOCKET_AUDIT_BATCH_FLUSH_MS`), flush no shutdown, gauge `plug_socket_audit_queued_events`.
- **Bridge REST e Socket (`agents:command`)**: `id` JSON-RPC **omitido** passa a receber **UUID gerado pelo servidor** antes do envio ao agente; a API **aguarda** `rpc:response` (HTTP `200` / resposta completa no Socket). Antes, `id` omitido era tratado como notification (HTTP `202` sem corpo de resultado).

### Migration

- Clientes que dependiam de **HTTP 202** ao **omitir** `id` devem:
  - passar a omitir `id` e consumir **HTTP 200** com `response` normalizada, **ou**
  - enviar explicitamente **`"id": null`** se o comportamento desejado continuar sendo fire-and-forget (notification).
- Clientes Socket em `agents:command` com a mesma expectativa de “notification sem `id`” devem usar **`id: null`** ou adaptar para a resposta com resultado.

### Added

- Variavel de ambiente **`BRIDGE_LOG_JSONRPC_AUTO_ID`**: quando `true`, log **INFO** estruturado ao auto-atribuir `id`.
- Em **`NODE_ENV=development`**, o mesmo evento e emitido em nivel **DEBUG** (sem variavel).

## Roadmap tecnico

- **Modularizar `rpc_bridge.ts`**: extrair filas/pending REST, relay, streaming, metricas e PayloadFrame em modulos menores para reduzir acoplamento e risco de regressao (ver `docs/api_rest_bridge.md` — mapa de arquivos).
