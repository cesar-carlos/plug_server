# Integração com `plug_agente`

Este índice reúne as orientações de integração. O estado de alinhamento e suas
limitações estão na [matriz de sincronização](communication_sync_plug_agente.md).
Entregas históricas não comprovam homologação nem autorizam publicação.

## Orientações e histórico

- [Sincronização](communication_sync_plug_agente.md) — cobertura e pendências registradas.
- [Migração de namespaces](migracao_plug_agente_namespaces.md) — integração em `/agents`.
- [Mudanças restritas ao hub](02_no_change_items.md) — impacto no agente.
- [Migração de canal e desempenho](05_channel_migration_performance.md) — checklist.
- [Echo de body.id](01_relay_body_id_echo.md) — histórico das opções A/B.
- [Roadmap histórico](03_performance_roadmap.md) — itens numerados e propostas.
- [Registro de implementação](04_agent_implementation_status.md) — commits, arquivos e testes.

## Contratos canonicos

- [Remote action I/O](remote_action_io_specification.md) — implemented negotiated bridge, authorization, transport and reference clients; disabled by default.

Guia complementar: [exemplos de input/output e erros de ações](remote_action_io_examples.md).
Includes validated documentation fixtures; canonical runtime schemas remain in the agent OpenRPC.

- [`socket_relay_protocol.md`](../socket/socket_relay_protocol.md) — `relay:*`
- [`api_rest_bridge.md`](../api/api_rest_bridge.md) — REST + `agents:*`
- [`docs/adrs/`](../adrs/) — 0008 batch, 0009 echo, 0011 health, 0012 phases
- Repo agente (checkout lado a lado): `../../../plug_agente/docs/communication/`

## Inspeção estrutural persona-v2

Contrato REST aditivo 1.12.0 e extensão sourceSchema v1, em desenvolvimento.
sql.describeSchema exige sourceSchema/sourceIdentity v1 na inscrição autenticada;
o hub revalida no dispatch, sem fallback/retry. Encaminha escopo limitado e valida
metadados; não interpreta SQL nem acessa bancos. PKs, índices únicos e FKs incluem
estado por recurso. SQL Anywhere 16 pode provar estado de constraint pelo catálogo
público no escopo; evidência incompleta permanece `unknown`.

A revisão de comunicação do agente em 24/10/2026 mantém o perfil 2.11.2. O
validador do hub acompanha o schema publicado: dialetos `postgres`, `mssql` e
`sybase`; `offset` e `pageSize` explícitos; `schema` obrigatório no pedido.
Detalhe e limites: [`api_rest_bridge.md`](../api/api_rest_bridge.md).

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
