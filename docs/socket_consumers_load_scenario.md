# Cenario de Carga: `/consumers`

Objetivo: validar o caminho client-facing do Socket sob carga realista, com foco em
fan-out, relay e cleanup de sessao.

## Cenario base

1. Subir um hub com `/agents` e `/consumers` ativos.
2. Manter pelo menos 1 agente online e registado.
3. Abrir:
   - 200 a 500 sockets `/consumers`
   - 60% `client`, 40% `user`
   - 30% com conversa relay ativa
4. Gerar carga mista por 10 a 15 minutos:
   - bursts de `relay:conversation.start`
   - `relay:rpc.request` com requests unicas e retries deduplicados
   - streams com `relay:rpc.chunk` + `relay:rpc.stream.pull`
   - rajadas de `client:agent.profile.updated` para o mesmo `agentId`

## O que medir

- p95/p99 de `plug_socket_relay_overload_check_avg_ms`
- backlog e p95 da outbound queue
- `plug_socket_consumers_guard_db_*`
- `plug_socket_consumers_profile_push_*`
- `plug_socket_consumers_commands_aborted_on_disconnect_total`
- heap RSS / event-loop lag
- tamanho das filas de relay e buffered chunks

## Sinais de regressao

- crescimento monotono de backlog sem recuperar
- aumento continuo de `commands_aborted_on_disconnect_total` com pending preso
- `guard_db_max_ms` muito acima do normal durante bursts
- `profile_push_fanout_max` explosivo sem aumento correspondente de recipients reais
- `503 SERVICE_UNAVAILABLE` por overload fora de picos esperados

## Validacoes operacionais

- bloquear um `User` e um `Client` durante o teste e confirmar desconexao ativa do socket
- revogar um `ClientAgentAccess` durante stream ativo e confirmar corte da sessao
- repetir `relay:rpc.request` com o mesmo `client_request_id` e confirmar `deduplicated`
- testar com sticky sessions habilitado e desabilitado para ver o impacto da afinidade
