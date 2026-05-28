# Estudo: Relay Fast-Path (benchmark-gated)

> **Status (2026-05-28): SHIPPED.** O fast-path opt-in via `fastPath: true`
> no envelope de `relay:rpc.request` foi implementado. Defeito JSON-RPC
> 2.0 §5 reportado pelo cliente Colmeia foi corrigido reescrevendo
> `body.id` na borda hub→consumer (Opcao B). Ver
> [`docs/plug_agente/01_relay_body_id_echo.md`](plug_agente/01_relay_body_id_echo.md)
> para o racional cross-repo e a roadmap da Opcao A (eliminar o
> re-encode via negociacao agent-side).
>
> **Onde ver o contrato canonico**:
> [`docs/socket_relay_protocol.md`](socket_relay_protocol.md) — secao
> "Relay unary fast-path".
>
> Esta pagina permanece como **registro historico do estudo
> pre-implementacao**: hipotese, requisitos de seguranca, gate de
> benchmark e rollback. Util para entender a justificativa quando alguem
> revisitar a decisao no futuro.

## Resultado (resumo)

Implementado em 2026-05 conforme estrategia faseada abaixo. Numero
publicado pelo cliente Colmeia (E2E):

| cenario | wall-clock |
| ------- | ---------: |
| baseline (sem fast-path) | 7.0 s |
| fast-path (apos fix JSON-RPC 2.0 §5) | ~7.0 s (sem regressao) |
| fast-path (com defeito anterior do `body.id`) | 278 s (3 retries por SQL) |

Ganho de RTT economizado por RPC fica visivel em workloads cross-agent
de alta cardinalidade (`mergeAll` com N agentes). Metricas em
producao:

- `plug_socket_relay_fast_path_requested_total`
- `plug_socket_relay_fast_path_honored_total`
- `plug_socket_relay_fast_path_fallback_dedup_total`
- `plug_socket_relay_fast_path_fallback_error_total`
- `plug_socket_relay_fast_path_stream_inadvertent_total`
- `plug_socket_relay_body_id_echo_total` (adicionado pelo fix do §5)

## Objetivo (original)

Avaliar um modo opcional de relay com menos transformação no hub para reduzir CPU
em `relay:rpc.request`, **sem** quebrar segurança, rastreabilidade e contrato.

## Contexto atual

Hoje o relay faz:

1. decode do `PayloadFrame` do consumer;
2. validação Zod do comando;
3. normalização do comando;
4. reescrita de `id` + merge de `meta`;
5. reencode para novo `PayloadFrame` antes de `rpc:request`.

Esse fluxo é seguro, mas pode custar CPU em tráfego alto.

## Hipótese

Se `decode/validate/reencode` for o gargalo dominante no baseline, um fast-path
opcional pode reduzir latência média do hot path relay.

## Requisitos de segurança (não negociáveis)

- manter validação mínima de método permitido;
- manter controles de autorização/conversa;
- manter idempotência por `client_request_id`;
- preservar metadados mínimos de correlação (`request_id`, `trace_id`, `conversation_id`);
- manter capacidade de rejeitar payload inválido cedo.

## Gate de benchmark

Implementação só avança se baseline mostrar, de forma consistente:

- `plug_socket_relay_bridge_encode_avg_ms` e/ou `plug_socket_relay_frame_decode_avg_ms` como principais contribuidores;
- ganho estimado >= 15% no hot path relay sem aumento de erro/timeout;
- sem regressão em `plug_socket_relay_outbound_queue_overload_rejected_total`.

## Estratégia de implementação (faseada)

1. introduzir feature flag de estudo (default off);
2. criar caminho alternativo restrito a comandos compatíveis;
3. medir A/B em ambiente controlado;
4. promover apenas se os critérios do gate forem cumpridos.

## Critérios de rollback imediato

- aumento de `rpcFrameDecodeFailed`;
- aumento de `requestTimeouts` no relay;
- qualquer divergência de contrato observada em testes de integração/contrato.
