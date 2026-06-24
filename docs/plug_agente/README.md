# Orientacoes para `plug_agente` — performance Socket / relay (2026-05)

> **Audiencia.** Time do `plug_agente` (Flutter). Este conjunto de
> documentos descreve (1) as melhorias entregues no `plug_server` no
> ciclo de performance Socket vs REST e o que precisa (ou nao precisa)
> ser ajustado no agente e (2) um roadmap priorizado de melhorias que
> dependem de codigo no `plug_agente` para destravar mais ganhos.
>
> **Fonte da demanda do cliente Colmeia.**
> `D:\Developer\Flutter\colmeia\docs\server_adjustments\` — README +
> `DELIVERED.md` + um doc por item (relay batch, fast-path, agents:command
> hang, phase diagnostics).
>
> **Estado atual do hub** (2026-06-24): Opcao A `clientRequestIdEcho` shippada
> ([`560ef2f`](https://github.com/cesar-carlos/plug_server/commit/560ef2f));
> onda de performance hub H1–H8 em [`a6fbc2c`](https://github.com/cesar-carlos/plug_server/commit/a6fbc2c)
> + transport extensions.
>
> **Estado atual do agente** (2026-06-24): itens 1–9 do roadmap shippados
> (6 em [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c),
> extensões ADR em [`741b5677`](https://github.com/cesar-carlos/plug_agente/commit/741b5677)).
> Item 10 (brotli) continua `proposed`.

## Visao geral dos quatro itens do cliente Colmeia

| # | Item | Estado no hub | Acao no `plug_agente` |
| - | ---- | ------------- | --------------------- |
| 1 | Relay JSON-RPC batch (`relay:rpc.request.batch`) | ✅ Pronto, gated por `SOCKET_RELAY_BATCH_ENABLED` | **Nada** — o hub re-encaminha como N `rpc:request` unarios. Ver [`02_no_change_items.md`](02_no_change_items.md). |
| 2 | `agents:command` fast-fail cross-agent | ✅ Pronto via `AgentDisconnectedBeforeDispatchError` | **Nada** — fast-fail e puramente no hub. Ver [`02_no_change_items.md`](02_no_change_items.md). |
| 3 | Relay unary fast-path | ✅ Opcao B + Opcao A negociada ([ADR 0009](../adrs/0009-client-request-id-echo.md)) | **Deploy coordenado** com agente [`741b5677`](https://github.com/cesar-carlos/plug_agente/commit/741b5677) para bypass re-encode. |
| 4 | Server-side phase diagnostics (`requestServerTimings`) | ✅ Pronto + `meta.agent_phases` ([ADR 0010](../adrs/0010-agent-phase-timings.md)) | **Opt-in** consumer + extensao negociada. |

## Roadmap proativo (audit cross-repo 2026-05-28)

Alem dos 4 itens do cliente, foram identificadas oportunidades
adicionais durante o audit dos hot paths cross-repo. Detalhe completo,
priorizacao, gates, pseudocodigo **e status apos a onda de 2026-05-28**
em [`03_performance_roadmap.md`](03_performance_roadmap.md). Top items:

| # | Item | Impacto | Esforco | Status |
| - | ---- | ------- | ------- | ------ |
| 🚨 1 | Default `enableSocketDeliveryGuarantees=true` (hub ja espera ack, retry de 1 s desperdicado hoje) | **high** | **low** | ✅ shipped (agent [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28) |
| 🚨 2 | Reavaliar default `enableSocketStreamingChunks=false` para queries grandes | **high** | **low** | ✅ shipped (agent [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28) |
| 3 | Coalescing de `rpc:request_ack` em `rpc:batch_ack` (debouncer 5 ms) | medium | low | ✅ shipped (agent [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28) |
| 4 | Per-phase agent timings em `meta.agent_phases` | medium | medium | ✅ shipped (2026-06-24) |
| 5 | Health piggyback | medium | medium | ✅ shipped (2026-06-24) |
| 7 | `clientRequestIdEcho` Opcao A | low-medium | medium | ✅ shipped (2026-06-24) |
| 6 | `recommendedStreamPullWindowSize` default 1 → 8 + env override | medium | low | ✅ shipped (agent [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28) |
| 8 | `prepareForSend` preserva `meta.request_id` propagado | low | trivial | ✅ shipped preventivamente (agent [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28) |
| 9 | Pre-warm de schema validators / JSON schemas | low | medium | ✅ shipped (agent [`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c) 2026-05-28) |

Os itens 🚨 sao **divergencias de defaults entre hub e agente** que
causavam perda de performance silenciosa em producao — foram tratados
como bugs e shippados nesta onda no commit
[`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c)
do `plug_agente` (validado com `flutter test`: 3017 passed, 0 failed).
**Snapshot completo da entrega cross-repo** (arquivos tocados, testes
adicionados, acoes pendentes para o release) em
[`04_agent_implementation_status.md`](04_agent_implementation_status.md).

## Como ler estes docs

1. Leia este `README.md` (1 minuto).
2. Se quiser apenas confirmar que **nao ha trabalho obrigatorio** para
   o agente nos 4 itens do cliente, leia
   [`02_no_change_items.md`](02_no_change_items.md).
3. Se quiser entender o defeito do fast-path corrigido no hub e a
   evolucao opcional do contrato `body.id` (Opcao A), leia
   [`01_relay_body_id_echo.md`](01_relay_body_id_echo.md).
4. **Se quiser priorizar trabalho proativo no `plug_agente`** para
   destravar mais performance, leia
   [`03_performance_roadmap.md`](03_performance_roadmap.md) — itens
   ordenados por impacto vs esforco com gates de medicao.
5. **Se quiser ver o estado atual da entrega cross-repo** (o que o
   `plug_agente` ja shippou, em que arquivos, com que testes, e
   acoes pendentes para o release), leia
   [`04_agent_implementation_status.md`](04_agent_implementation_status.md).
   Esta pagina e atualizada a cada nova onda de entrega.
6. **Migração de canal para desempenho (P4)** — REST materializado → relay,
   fastPath + Opcao A: [`05_channel_migration_performance.md`](05_channel_migration_performance.md).

## Documentos canonicos do contrato

Estes continuam sendo a fonte de verdade — qualquer mudanca no agente
deve referenciar:

- [`docs/socket/socket_relay_protocol.md`](../socket/socket_relay_protocol.md) — contrato
  do canal `relay:*` no namespace `/consumers`.
- [`docs/api/api_rest_bridge.md`](../api/api_rest_bridge.md) — contrato REST +
  `agents:command` no namespace `/agents`.
- [`docs/plug_agente/communication_sync_plug_agente.md`](communication_sync_plug_agente.md)
  — checklist de sincronizacao com o repositorio irmao. **Pasta atual e
  cross-linked daqui**.
- [`docs/adrs/`](../adrs/) — decisoes de protocolo (ADR 0008 batch, ADR
  0009 client-request-id echo).
- `../plug_agente/docs/communication/socket_communication_standard.md` —
  contrato do lado do agente.
- `../plug_agente/docs/communication/openrpc.json` e
  `../plug_agente/docs/communication/schemas/` — schemas normativos do
  agente.

## Politica de mudancas neste folder

- Edite estes ficheiros somente quando o hub fizer uma mudanca que afete
  o que e cobrado / esperado / oferecido ao agente — **nunca** use como
  changelog detalhado por PR.
- Mantenha os exemplos Dart compatives com o agente production-ready (ex:
  null-safety, sem dependencias internas).
- Mantenha as referencias cross-repo com paths relativos (`../plug_agente/`)
  para facilitar a leitura quando o checkout esta lado-a-lado.
