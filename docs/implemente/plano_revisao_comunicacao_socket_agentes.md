# Plano de implementacao — comunicacao Socket.IO hub ↔ agente

**Estado:** implementado no hub e em testes locais; matriz Node ↔ Dart obrigatoria em CI (`main` e `v1.8.5`); bridge distribuido permanece fora de escopo  
**Data da revisao:** 2026-09-27  
**Escopo:** `plug_server` e a integracao Socket.IO com o checkout irmao
`D:\Developer\plug_database\plug_agente`  
**Nao incluido neste plano:** alteracoes de regra de negocio, REST que nao participa
do bridge, ou reescrita completa do protocolo JSON-RPC.

## 1. Contexto e resultado da revisao

O hub usa dois namespaces:

```text
agente (/agents)
  -> handshake autenticado
  -> connection:ready
  -> agent:register
  -> agent:capabilities
  -> agent:ready (quando negociado)
  -> rpc:response / rpc:chunk / rpc:complete / ACKs

consumer (/consumers)
  -> relay:conversation.* / relay:rpc.*
  -> bridge/dispatch para o agente
  -> relay:rpc.response / relay:rpc.chunk / relay:rpc.complete
```

O sistema ja possui protecoes relevantes: `PayloadFrame` binario com gzip e
assinatura opcional, validacao de contrato, limites de pending/streams/buffers,
fila FIFO de dispatch por agente, fila outbound por `requestId`, timeout e
settlement atomico, rate limits e metricas.

Na revisao de 2026-09-27, os seguintes checks passaram sem alteracoes no
working tree:

```powershell
npm run test:contract   # 8 arquivos / 44 testes
npm run check:openrpc   # 2 arquivos / 6 testes
```

Os documentos de referencia do agente foram lidos em:

- `D:\Developer\plug_database\plug_agente\docs\communication\socket_communication_standard.md`
- `D:\Developer\plug_database\plug_agente\docs\communication\socketio_client_binary_transport.md`
- `D:\Developer\plug_database\plug_agente\docs\plug_server\01_transport_extensions.md`

> O caminho `D:\Developer\plug\_database\...` informado originalmente nao
> existe neste ambiente. O checkout disponivel usa `plug_database`.

## 2. Achados, prioridade e decisao

| Prioridade | Achado | Evidencia | Decisao |
| --- | --- | --- | --- |
| P0 | Possivel corrida entre o stream-open em `rpc:response` e o primeiro `rpc:chunk`/`rpc:complete`. | `rpc:response` inicia decode assincrono independente; chunks entram em fila separada e sao ignorados se nao encontram rota ativa. | Corrigir antes de qualquer tuning de capacidade. |
| P1 | Nao ha quota de ingress especifica para `rpc:response`, `rpc:chunk` e `rpc:complete` de um agente. | Register e heartbeat possuem limiters; o caminho de dados inbound nao limita frames, bytes decodificados ou backlog por socket. | Adicionar guard de admissao com rollout observavel. |
| P1 | `agent:register` pode executar concorrente no mesmo socket. | O listener dispara handler assincrono e `socket.data.agentId` so e definido apos decode, rate limit e bind de ownership. | Implementar estado de handshake por socket/idempotencia curta. |
| P1 | Backlog outbound e medido em jobs, mas nao em bytes por consumer. | `relay_outbound_queue.ts` mantem tails por request ID e conta jobs; consumidor lento pode acumular memoria ate os limites indiretos. | Adicionar contabilizacao e cap de bytes, sem sacrificar a entrega terminal. |
| P2 | Presence Redis em listagens resolve IDs remotos sequencialmente. | `resolveClusterHubConnectedAgentIds` executa `await presence.resolveRoute()` dentro do loop. | Implementar lote/pipeline ou concorrencia limitada. |
| P2 | Relay state continua local ao processo. | Conversas, pending requests, streams e idempotencia relay nao sao externalizados; Redis adapter nao remove necessidade de sticky sessions. | Manter afinidade como requisito ou abrir projeto arquitetural separado. |
| P2 | Homologacao com runtime Dart real e majoritariamente opt-in/live. | Os contract tests Node passam; os E2E de hub do agente dependem de ambiente e segredos. | Criar matriz deterministica Node ↔ Dart no CI. |

### 2.1 Detalhe do defeito P0

Arquivos relevantes:

- `src/presentation/socket/hub/register_agent_socket_handlers.ts`
  registra `rpc:response` nas linhas aproximadas 637–639 e `rpc:chunk` /
  `rpc:complete` nas linhas 649–655.
- `src/presentation/socket/hub/relay/rpc_bridge_agent_inbound.ts`
  inicia o processamento de response de modo assincrono na funcao
  `handleAgentRpcResponse`; chunks e complete usam apenas
  `orderedStreamInbound`.
- A funcao `decodeAndResolveStreamRoute` retorna `null` quando ainda nao existe
  uma `ActiveStreamRoute`.

Socket.IO preserva a ordem de chegada, mas nao a ordem de conclusao de handlers
que fazem `await`. Uma response comprimida pode terminar o `gunzip` depois de
um chunk posterior. Neste caso o chunk nao encontra a rota que a response abriria
e deixa de ser encaminhado. Esse cenario precisa de um teste que force o
agendamento invertido; nao deve depender de timing real.

## 3. Regras obrigatorias para a IA executora

1. Ler `AGENTS.md` e, antes de editar, `./.cursor/rules/governance.mdc`.
2. Aplicar tambem `websocket_api.mdc`, `architecture.mdc`, `security.mdc`,
   `performance.mdc`, `testing.mdc` e `typescript.mdc`.
3. Preservar compatibilidade do `PayloadFrame`, `requestId`,
   `clientRequestId`, `meta.request_id` e dos eventos ja publicados.
4. **Nao alterar contratos publicos** — nomes de eventos, namespaces, formatos
   de `PayloadFrame`, envelopes JSON-RPC, ACKs, schemas OpenRPC e valores de
   correlacao — neste plano. Qualquer necessidade futura de mudanca contratual
   exige decisao explicita, ADR, versionamento/adaptador de compatibilidade e
   homologacao coordenada com `plug_agente` e consumers.
5. Atualizar, ao final de cada fase que produza mudanca material, a
   documentacao normativa afetada (`docs/socket/socket_relay_protocol.md`,
   `docs/socket/socket_client_sdk.md`, `docs/configuration.md`,
   `docs/performance/performance_hub_agent.md`) e este plano/status, quando
   necessario. Nao documentar comportamento ainda nao implementado.
6. Nao mudar defaults produtivos sem metrica, feature flag, documentacao e
   teste de regressao.
7. Nao introduzir `any`, nem colocar regra de negocio em listeners Socket.
8. Manter o handler como adaptador: validar/admitir -> chamar componente
   especializado -> emitir resposta normalizada.
9. Nao criar branch sem pedido explicito do usuario.

## 4. Fase 0 — caracterizacao e baseline

### Objetivo

Medir o estado anterior para que limites e otimizações tenham justificativa e
rollback seja objetivo.

### Tarefas

1. Confirmar configuracao atual com:

   ```powershell
   npm run perf:audit-env
   npm run perf:baseline
   npm run load:socket-bridge
   ```

2. Executar carga representativa em quatro cenarios:

   - unary pequeno sem gzip;
   - unary grande com gzip;
   - streaming com 1, 8 e 32 streams por agente;
   - consumer lento/desconectando no meio de uma stream.

3. Capturar antes/depois em `/metrics`:

   - p50/p95/p99 de `plug_socket_relay_frame_decode_*`;
   - `plug_socket_relay_outbound_queue_*`;
   - chunks encaminhados, descartados, timeout e late response;
   - retries de ACK;
   - heap, RSS e event-loop lag do processo;
   - fila/tempo de dispatch por agente.

4. Documentar carga, versao de Node, CPU, quantidade de agentes e valores de
   env usados. Nao comparar benchmarks de maquinas diferentes sem registrar a
   diferenca.

### Criterios de aceite

- Baseline versionado em `docs/performance/` ou no PR da implementacao.
- SLOs definidos: zero perda de chunk anterior ao stream-open; sem crescimento
  ilimitado de heap; regressao unary p95 inferior a 5%, salvo justificativa
  documentada.

### Teste automatizado de regressao de desempenho

1. Criar um benchmark deterministico no repositorio, preferencialmente em
   `scripts/` com teste Vitest de orquestracao, que inicie um hub isolado e
   exercite pelo menos estes caminhos:

   - response unary pequeno;
   - response gzip acima do limiar;
   - stream de N chunks com consumer normal;
   - stream de N chunks com consumidor deliberadamente lento.

2. O benchmark deve produzir JSON com versao do Node, configuracao relevante,
   amostras, p50/p95/p99, throughput, bytes e pico de heap. Nunca deve conter
   SQL real, JWT, chaves HMAC ou payload de usuario.

3. Armazenar um baseline aprovado por ambiente de CI em fixture versionada. O
   gate nao deve comparar tempos absolutos entre maquinas heterogeneas: deve
   normalizar por cenario ou usar limiares amplos e estaveis, por exemplo:

   - unary p95 nao piora mais de 5%;
   - throughput nao cai mais de 10%;
   - pico de heap nao cresce mais de 10%;
   - nenhum chunk valido e perdido ou entregue fora de ordem.

   Implementacao: o microbenchmark em processo aplica piso de ruido absoluto
   para latencias submilissegundo e tolerancias de throughput aferidas localmente;
   os SLOs produtivos de 5%/10% exigem a janela de carga representativa da
   Fase 0. Ver `docs/performance/performance_hub_agent.md`.

4. Rodar o teste em CI como job separado e permitir atualizacao do baseline
   somente por comando/revisao explicita. Falha de desempenho deve anexar o
   JSON comparativo ao artefato do job.

5. Para reduzir flakiness, usar warmup, numero minimo de iteracoes, timeout
   fixo, payload sintetico deterministico e mediana de repeticoes. O job de
   performance nao substitui testes funcionais e de contrato.

## 5. Fase 1 — sequenciamento correto de eventos inbound (P0)

### Objetivo

Garantir que a abertura de uma stream pelo `rpc:response` seja consolidada antes
de `rpc:chunk` e `rpc:complete` subsequentes do mesmo socket, mesmo quando o
decode assincrono termina fora de ordem.

### Desenho recomendado

1. Criar componente focado, por exemplo:

   ```text
   src/presentation/socket/hub/relay/agent_inbound_sequencer.ts
   ```

2. Cada frame de `rpc:response`, `rpc:chunk` e `rpc:complete` recebe um numero
   de sequencia no instante em que o listener e invocado.

3. Separar duas etapas:

   - **decode/validacao:** pode usar gzip assincrono e executar em paralelo;
   - **commit de estado:** deve respeitar a sequencia de chegada por socket.

4. O commit de response deve criar a `ActiveStreamRoute` antes de permitir o
   commit do chunk/complete posterior.

5. O commit nao deve esperar encode/emissao outbound. Depois que a rota e
   estabelecida, deve apenas enfileirar o trabalho existente em
   `relay_outbound_queue.ts`; isso evita serializar indevidamente streams
   independentes.

6. Manter `ordered_stream_inbound_queue.ts` somente se ele continuar tendo uma
   responsabilidade distinta. Evitar duas filas com garantia de ordem ambigua.
   Idealmente, o novo sequenciador substitui a fronteira de ordenacao entre os
   tres eventos de stream.

7. O ACK Socket.IO do agent deve ocorrer apos a decisao de decode, assinatura e
   validacao, com o frame admitido no sequenciador. Preservar o comportamento
   publico de confirmar tambem frames rejeitados pela validacao: o ACK significa
   recebimento/decisao de transporte, nao sucesso da RPC nem entrega ao consumer.

8. No disconnect, invalidar filas pendentes por geracao, liberar referencias e
   impedir side effects de trabalhos que ja nao pertencem a sessao atual.

### Arquivos provaveis

- `src/presentation/socket/hub/register_agent_socket_handlers.ts`
- `src/presentation/socket/hub/relay/rpc_bridge_agent_inbound.ts`
- `src/presentation/socket/hub/relay/ordered_stream_inbound_queue.ts`
- novo `agent_inbound_sequencer.ts`
- `src/presentation/socket/hub/relay/rpc_bridge.ts` ou lifecycle, para reset e
  cleanup de testes.

### Testes obrigatorios

1. Response de stream atrasada artificialmente e primeiro chunk rapido:
   response, chunk e complete devem chegar ao consumer em ordem e uma unica vez.
2. Varios chunks apos response, preservando `chunk_index`.
3. Duas streams simultaneas de um mesmo agente, sem head-of-line blocking na
   emissao outbound de requests diferentes.
4. Disconnect entre response e chunk: nenhuma rota/zombie permanece.
5. Frame invalido e falha no decode nao bloqueiam frames posteriores.
6. ACK e retry: ACK ocorre uma vez; retry nao produz duplicacao da resposta.

### Metricas novas

- `plug_socket_agent_inbound_sequencer_wait_ms` (histograma);
- `plug_socket_agent_inbound_out_of_order_prevented_total`;
- `plug_socket_agent_stream_chunk_without_route_total`;
- gauges de jobs/idade pendentes por socket.

### Aceite

- O teste de corrida falha no codigo anterior e passa de forma deterministica.
- Nenhum chunk normal e descartado por rota ainda nao aberta.
- A carga de streaming nao viola o SLO definido na fase 0.

## 6. Fase 2 — admissao e protecao do ingress do agente (P1)

### Objetivo

Evitar que um agente mal configurado, com bug ou comprometido consuma CPU,
thread pool zlib e memoria sem limite por meio de responses/chunks.

### Desenho recomendado

1. Criar `agent_inbound_ingress_guard.ts` no modulo Socket hub.
2. Avaliar, por socket e agentId quando disponivel:

   - frames por janela;
   - bytes comprimidos;
   - bytes originais/decomprimidos declarados;
   - itens aguardando decode/commit;
   - violacoes consecutivas.

3. Usar orcamentos separados:

   - ACKs (`rpc:request_ack`, `rpc:batch_ack`) com teto pequeno e prioritario;
   - responses unary;
   - chunks/complete de stream.

4. Fazer a admissao barata antes de decode logico. A estrutura do frame e
   `compressedSize` precisam ser checadas antes de reservar trabalho; o decode
   completo continua responsavel por assinatura, tamanho real e JSON.

5. Politica de excesso:

   - registrar e rejeitar trabalho que ainda nao iniciou;
   - ao atingir limite de stream, emitir terminal controlado ao consumer;
   - desconectar apenas por violacoes repetidas, usando erro seguro e motivo
     operacional sem payload sensivel.

6. Introduzir envs com valores conservadores e feature flag de observacao:

   ```text
   SOCKET_AGENT_INBOUND_GUARD_MODE=observe|enforce
   SOCKET_AGENT_INBOUND_MAX_FRAMES_PER_WINDOW
   SOCKET_AGENT_INBOUND_MAX_COMPRESSED_BYTES_PER_WINDOW
   SOCKET_AGENT_INBOUND_MAX_DECODED_BYTES_PER_WINDOW
   SOCKET_AGENT_INBOUND_MAX_PENDING_WORK
   SOCKET_AGENT_INBOUND_VIOLATIONS_BEFORE_DISCONNECT
   ```

   Os nomes finais devem seguir o parser existente de `env.ts` e ser
   documentados em `.env.example` e `docs/configuration.md`.

### Testes obrigatorios

- Burst de chunks respeita limite e mantem processo estavel.
- Um agente legitimo dentro do orcamento nao sofre rejeicao.
- Assinatura/frame invalido nao recebe credito indevido.
- Repetidas violacoes desconectam somente o socket agressor.
- Consumidor recebe terminal observavel, sem pending infinito.
- Estado do limiter e removido no disconnect/sweep.

### Metricas novas

- `plug_socket_agent_inbound_rejected_total{event,reason}`;
- `plug_socket_agent_inbound_bytes_rejected_total{kind}`;
- `plug_socket_agent_inbound_violation_disconnect_total`;
- `plug_socket_agent_inbound_pending_work`.

### Rollout

1. `observe` em canario, sem rejeitar.
2. Comparar percentis com baseline e escolher limites por capacidade real.
3. Ativar `enforce` para ambiente interno.
4. Ampliar gradualmente; manter rollback por env.

## 7. Fase 3 — serializar e idempotentizar `agent:register` (P1)

### Objetivo

Impedir que retransmissoes ou eventos concorrentes no mesmo socket criem bind,
presence sync, capabilities e profile sync duplicados.

### Desenho recomendado

1. Criar estado privado por socket:

   ```text
   unregistered -> registering -> registered -> disconnected
   ```

2. Ao receber `agent:register` em `registering`:

   - se `agentId` e `requestId` sao os mesmos, coalescer na mesma Promise ou
     devolver resultado estavel;
   - se diferem, emitir `agent:register_error` com `invalid_request`;
   - nunca iniciar segundo `bindOwnershipOnRegister`.

3. Ao receber registro em `registered`:

   - permitir somente retry sem alteracao de identidade/capabilities se a
     compatibilidade atual exigir;
   - preferir resposta idempotente a repetir efeitos colaterais;
   - rejeitar troca de `agentId`.

4. Se houver disconnect durante o bind, descartar o resultado e nao sincronizar
   presence nem perfil para socket morto.

5. Garantir que takeover continue a notificar e desconectar a sessao anterior
   conforme `SOCKET_AGENT_SESSION_POLICY`.

### Arquivos provaveis

- `src/presentation/socket/hub/handlers/agent_register.handler.ts`
- `src/presentation/socket/hub/register_agent_socket_handlers.ts`
- novo helper de estado de handshake, se o handler ficar grande.

### Testes obrigatorios

- Dois `agent:register` iguais simultaneos: um bind e um capabilities emitido.
- Dois registros para IDs distintos no mesmo socket: segundo e rejeitado.
- Disconnect durante bind: registry e presence nao retem socket morto.
- Corrida de takeover: somente a sessao vencedora fica registrada.
- Retry apos falha transiente continua permitido pelo contrato atual.

## 8. Fase 4 — limitar backlog outbound por bytes (P1)

### Objetivo

Completar a protecao atual, que mede backlog em quantidade de jobs, com limites
de memoria por consumer e globais.

### Desenho recomendado

1. Evoluir `relay_outbound_queue.ts` para rastrear:

   - bytes pendentes globais;
   - bytes pendentes por consumer;
   - request IDs ativos por consumer;
   - idade maxima do trabalho pendente.

2. Passar metadados de tamanho para a fila usando `PayloadFrame.originalSize`
   ou bytes ja conhecidos. Nao serializar JSON novamente apenas para contar.

3. Definir dois limiares:

   - **shed threshold:** rejeita novas requisicoes no consumer antes de esgotar
     memoria;
   - **hard threshold:** encerra stream/consumer lento de forma controlada e
     limpa buffers/rotas.

4. Manter eventos de controle (`accepted`, erro terminal, `complete`) com via
   de prioridade para que backpressure de chunks nao deixe requests pendentes.

5. Se uma emissao terminal falhar, manter timeout/cleanup deterministico; nao
   deixar rota viva esperando um consumer que nao pode receber.

### Configuracao candidata

```text
SOCKET_RELAY_OUTBOUND_MAX_PENDING_BYTES
SOCKET_RELAY_OUTBOUND_MAX_PENDING_BYTES_PER_CONSUMER
SOCKET_RELAY_OUTBOUND_MAX_PENDING_REQUEST_IDS_PER_CONSUMER
SOCKET_RELAY_OUTBOUND_HARD_LIMIT_ACTION=close_stream|disconnect_consumer
```

Validar nomes, defaults e necessidade real na fase 0 antes de publica-los.

### Testes obrigatorios

- Consumer lento com muitas streams: bytes e jobs nao crescem sem teto.
- Consumer saudavel nao sofre bloqueio por outro consumer.
- Ao atingir limite, streams recebem terminal consistente e todos os registries
  sao limpos.
- Reconnect posterior funciona e nao reutiliza estado antigo.

## 9. Fase 5 — presence e escalabilidade horizontal (P2)

### 9.1 Otimizacao de presence

1. Estender o port Redis com `resolveRoutes(agentIds)` usando pipeline/MGET,
   ou concorrencia limitada caso a estrutura de chaves impeça MGET.
2. Manter consulta local em memoria como fast path.
3. Preservar fallback seguro se Redis estiver indisponivel.
4. Adicionar histograma de latencia, contador de IDs e contador de fallback.
5. Testar 1, 100, 1.000 e 10.000 IDs para demonstrar que nao ha crescimento
   linear por RTT.

### 9.2 Decisao de arquitetura para replicas

Antes de codificar, obter decisao de produto/operacao:

| Necessidade | Acao |
| --- | --- |
| Sticky sessions garantidas por Nginx/load balancer | Manter relay local; documentar, validar config no startup e testar afinidade. |
| Replica sem afinidade obrigatoria | Abrir projeto separado de bridge distribuido. |

O bridge distribuido precisa incluir todos estes elementos; Redis adapter sozinho
nao resolve nenhum deles:

1. encaminhar comando ao `HUB_INSTANCE_ID` dono do agente;
2. roteamento de response/chunk/complete de volta ao dono da conversa;
3. armazenamento distribuido de conversation, pending route, stream flow e
   idempotencia;
4. lease/TTL e fencing para failover;
5. cancelamento, timeout e settlement atomico entre instancias;
6. testes de kill/restart da instancia proprietaria;
7. seguranca de canal interno e metricas por instancia.

Nao iniciar esta subfase sem requisito formal: ela altera o modelo de
confiabilidade e deve ter ADR proprio.

## 10. Fase 6 — contrato e homologacao Node ↔ Dart (P2)

### Objetivo

Transformar o alinhamento atual de docs e testes Node em verificacao continua
com o codec/runtime Dart do agente.

### Tarefas

1. Criar fixtures versionadas e livres de segredo para:

   - `PayloadFrame` (`none`, `gzip`, HMAC);
   - `agent:register`, `agent:capabilities`, `agent:ready`;
   - response unary, stream-open, chunk, complete;
   - `rpc:request_ack`, `rpc:batch_ack`, retry e takeover;
   - erro terminal, frame invalido e limites de tamanho.

2. Manter schema/OpenRPC como fonte do agente e validar a versao/assinatura
   esperada pelo hub. Evitar copiar manualmente contratos divergentes.

3. Adicionar matriz deterministica em CI:

   - Node hub real + cliente Dart do `plug_agente`;
   - fake agent previsivel para testes de corridas do hub;
   - versao atual e uma versao de compatibilidade suportada.

4. Manter testes live opcionais somente para homologacao de ambiente remoto;
   testes de CI nao podem depender de JWT real, rede publica ou chave de
   producao.

5. Fazer os testes da fase 1 parte da matriz para que a ordem logica de stream
   seja comprovada cross-runtime.

## 11. Sequencia recomendada de entrega

1. Fase 0: baseline e SLOs.
2. Fase 1: corrigir corrida response/chunk, testes e metricas.
3. Fase 3: tornar register idempotente, pois reduz ruido em reconnect.
4. Fase 2: ingress guard em modo observe e calibracao.
5. Fase 4: cap outbound por bytes, apos medir consumo real.
6. Fase 6: matriz CI Node ↔ Dart.
7. Fase 5.1: batch de presence quando catalogos grandes justificarem.
8. Fase 5.2: somente com decisao de operar sem sticky sessions.

Cada fase deve ser um PR independente, com mudanca coesa, feature flags quando
ha alteracao de comportamento operacional e um plano de rollback.

## 12. Checklist de verificacao por PR

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test:contract
npm run check:openrpc
npm run test
```

Tambem executar o subconjunto de testes Socket criado/alterado e, para fases de
desempenho, repetir a carga equivalente da fase 0. Se qualquer check nao puder
rodar, registrar explicitamente o motivo e o impacto no handoff.

## 13. Checklist de rollout e rollback

### Antes do canario

- Baseline anexado e thresholds configurados.
- Dashboard/alertas de novas metricas preparados.
- Env documentada em `.env.example` e `docs/configuration.md`.
- Testes de disconnect, timeout, retry e slow consumer passando.
- Confirmada a politica de sticky sessions em producao.

### Durante o canario

- Comecar com agentes internos e trafego limitado.
- Observar p95/p99, heap, event-loop lag, rejeicoes, chunks sem rota e retries.
- Comparar com baseline pelo menos por uma janela de carga completa.
- Manter guard de ingress em `observe` antes de `enforce`.

### Condicoes de rollback

- Aumento de p95 acima do SLO por duas janelas consecutivas.
- Qualquer perda confirmada de chunk normal.
- Crescimento continuo de heap/backlog.
- Aumento inesperado de `AGENT_DISCONNECTED`, timeout ou retry de ACK.

Rollback deve ser feito pela flag/env da fase. A instrumentacao, os testes de
corrida e as protecoes de cleanup devem permanecer para diagnostico.

## 14. Resultado esperado ao final

Ao concluir as fases P0/P1, o hub deve:

- preservar a sequencia logica de abertura, chunks e termino de streams;
- resistir a floods ou falhas de agentes sem exaurir recursos compartilhados;
- tratar retransmissao de `agent:register` sem efeitos duplicados;
- limitar memoria outbound por consumidor com terminais previsiveis;
- fornecer metricas suficientes para ajustar capacidade e investigar incidentes.

As fases P2 tornam o contrato entre repositorios verificavel continuamente e
preparam a escala horizontal sem prometer que Redis adapter, por si so, fornece
um bridge distribuido.
