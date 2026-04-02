# Estudo: Relay Fast-Path (benchmark-gated)

## Objetivo

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
