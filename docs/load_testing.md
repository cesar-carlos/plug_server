# Load testing (notas)

Este repositório não inclui um runner de carga fixo; podes validar o hub com ferramentas externas.

## HTTP (REST bridge)

Com token de utilizador válido:

```bash
# Exemplo: autocannon (npm i -g autocannon)
autocannon -m POST -H "Authorization=Bearer YOUR_ACCESS_TOKEN" \
  -H "Content-Type=application/json" \
  -b '{"agentId":"YOUR_AGENT","command":{"jsonrpc":"2.0","id":"1","method":"rpc.discover","params":{}}}' \
  http://localhost:3000/api/v1/agents/commands
```

Observa `plug_rest_bridge_*` e `plug_socket_relay_*` em `GET /metrics` durante o teste.

## Socket.IO

Cenários realistas precisam de **dois clientes** (agente em `/agents` + consumer em `/consumers`) e payloads `PayloadFrame`. Para smoke de latência, um único cliente pode stressar `agents:command` ou relay após login HTTP.

## O que monitorizar

- CPU do processo Node (gzip/gunzip sync vs async conforme env).
- `plug_socket_relay_chunks_dropped_total`, `plug_socket_relay_circuit_open_rejects_total`.
- Memória se usares streams SQL muito grandes no REST materializado.
