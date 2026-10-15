# Orientacoes para `plug_agente` — status e navegacao

> **Audiencia.** Time do `plug_agente` (Flutter). **Fonte unica de status
> vivo** deste folder. Detalhe historico: [`03`](03_performance_roadmap.md)
> (arquivo), [`04`](04_agent_implementation_status.md) (ledger de commits).
>
> **Demanda Colmeia:** docs do cliente em `docs/server_adjustments/`
> (relay batch, fast-path, agents:command hang, phase diagnostics).
>
> **Estado:** itens Colmeia 1–4 e roadmap 1–9 **shipped**. Aberto: item 10
> (brotli). Hub H1–H12 shipped. Alinhamento de contrato mais recente:
> [`communication_sync_plug_agente.md`](communication_sync_plug_agente.md).
> Extensoes de transporte: ADR 0009 / 0011 / 0012 (ADR 0010 e presenca Redis).

## Quatro itens Colmeia

O status histórico abaixo não cobre toda a validação de comunicação atual.
As correções de lifecycle e normalização colunar preservam o profile 2.11.2;
consulte a matriz de [sincronização](communication_sync_plug_agente.md) para
cobertura, revisions e pendências de ODBC/homologação. Brotli continua proposta.

| #   | Item                                             | Estado no hub                                                                          | Acao no `plug_agente`                               |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | Relay JSON-RPC batch (`relay:rpc.request.batch`) | ✅ Pronto, gated por `SOCKET_RELAY_BATCH_ENABLED`                                      | **Nada** — ver [`02`](02_no_change_items.md)        |
| 2   | `agents:command` fast-fail cross-agent           | ✅ Pronto                                                                              | **Nada** — ver [`02`](02_no_change_items.md)        |
| 3   | Relay unary fast-path                            | ✅ Opcao B + Opcao A ([ADR 0009](../adrs/0009-client-request-id-echo.md))              | Deploy com agente que negocia `clientRequestIdEcho` |
| 4   | Phase diagnostics                                | ✅ Hub timings + `meta.agent_phases` ([ADR 0012](../adrs/0012-agent-phase-timings.md)) | Opt-in consumer + extensao                          |

## Roadmap proativo (resumo)

| #            | Item                                                                   | Status                                                                                                   |
| ------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1–3, 6, 8, 9 | Defaults, ack coalescing, pull window, prepareForSend, schema pre-warm | ✅ shipped 2026-05-28 ([`7923e38c`](https://github.com/cesar-carlos/plug_agente/commit/7923e38c))        |
| 4, 5, 7      | `agent_phases`, health piggyback, `clientRequestIdEcho`                | ✅ shipped 2026-06-24 ([`741b5677`](https://github.com/cesar-carlos/plug_agente/commit/741b5677))        |
| 10           | Compressao brotli                                                      | proposed — [`P5`](../performance/P5_future_gates.md) + [study](../studies/brotli_payload_frame_study.md) |

Commits / arquivos tocados: [`04_agent_implementation_status.md`](04_agent_implementation_status.md).
Detalhe historico do roadmap: [`03_performance_roadmap.md`](03_performance_roadmap.md).

## Como ler estes docs

1. Este `README.md` (status).
2. [`02_no_change_items.md`](02_no_change_items.md) — o que e hub-only.
3. [`01_relay_body_id_echo.md`](01_relay_body_id_echo.md) — historico Opcao B/A.
4. [`05_channel_migration_performance.md`](05_channel_migration_performance.md) — checklist P4 canal.
5. [`communication_sync_plug_agente.md`](communication_sync_plug_agente.md) — checklist sync.
6. [`migracao_plug_agente_namespaces.md`](migracao_plug_agente_namespaces.md) — runbook `/agents`.

## Contratos canonicos

- [`socket_relay_protocol.md`](../socket/socket_relay_protocol.md) — `relay:*`
- [`api_rest_bridge.md`](../api/api_rest_bridge.md) — REST + `agents:*`
- [`docs/adrs/`](../adrs/) — 0008 batch, 0009 echo, 0011 health, 0012 phases
- Repo agente (checkout lado a lado): `../../../plug_agente/docs/communication/`

## Politica

- Atualize **este README** quando o status de entrega mudar.
- `03` / `04` sao historico/ledger — nao duplicar tabelas de status aqui.
- Paths cross-repo relativos (`../plug_agente/`) quando o checkout esta lado-a-lado.

## Inspeção estrutural persona-v2

Contrato REST aditivo 1.12.0 e extensão sourceSchema v1, em desenvolvimento.
sql.describeSchema exige sourceSchema/sourceIdentity v1 na inscrição autenticada;
o hub revalida no dispatch, sem fallback/retry. Encaminha escopo limitado e valida
metadados; não interpreta SQL nem acessa bancos. PKs, índices únicos e FKs incluem
estado por recurso. SQL Anywhere mantém enforcement desconhecido.

sql.execute.expectedStructure preserva colunas e constraints utilizadas. Constraints
exigem sourceConstraints v1 negociada; agentes antigos são recusados. O agente
verifica na mesma conexão antes/depois do SELECT. metadataPage e nulos são preservados.
Não concede execução, aprovação semântica, DML ou deploy. OpenAPI, validadores,
paridade, snapshot e hashes consumidos pelo MCP permanecem sincronizados; o snapshot
é um patch contra o commit-base, nunca um commit upstream inventado.

## Structural SQL operation transport — contract 1.14.0

sql.operation.execute optionally carries expectedStructure with expectedSource.
It requires exact sqlOperations.structureGuard:1 plus sourceSchema/sourceIdentity
v1 on the authenticated ready agent; constraint expectations also require
sourceConstraints v1. The hub advertises support but exposes the guard in Client
detail only when actually negotiated. Old peers still serve supported ordinary
operations; they cannot receive a structural operation through fallback.

REST, agents:command, mixed batches and relay revalidate the capability before
emission, including after asynchronous waits. Unknown nullability or non-enabled
constraint expectations are refused by operation validation. SQL, metadata nulls
and the expectation are forwarded unchanged; the hub neither interprets SQL nor
opens a database. Verification runs on the agent's executing connection before
transaction begin and counts toward 32 native statements. No automatic retry.

MCP adapter support and the pinned contract are coordinated; this transport does
not publish a shared DML skill or grant execution. Durable safe refusal reasons,
qualified DML resources and MCP shared publication/preparation remain pending.
Production release stays blocked by all persona-v2 gates.
