# Integração do consumidor plug_node

## Objetivo e responsabilidades

O `plug_node` oferece nós n8n que consomem o hub por REST, bridge Socket ou
relay. Não executa o processo remoto e não deve implementar um segundo journal.
O agente é responsável pela execução, persistência e autorização local; o hub
valida e encaminha; o workflow mantém os identificadores de reconciliação.

Fontes normativas:

- [REST e autenticação](../api/api_rest_bridge.md).
- [Relay](../socket/socket_relay_protocol.md).
- [I/O fiel](remote_action_io_specification.md) e [exemplos](remote_action_io_examples.md).
- [Fixtures de paridade](../../contracts/action_io_shared_fixtures.json).
- OpenRPC e schemas do checkout irmão `plug_agente/docs/communication/`.

## Levantamento de 30/10/2026

A inspeção inicial encontrou apenas SQL legado e descoberta básica na união
`PlugCommandMethod` do node. Não havia superfície tipada de ações I/O, inspeção
estrutural ou operações SQL duráveis. Suporte genérico de transporte não equivale
a suporte validado e utilizável no nó n8n.

O caminho HTTP recomendava retry para falha sem resposta; a normalização de erros
não projetava os campos de diagnóstico e recuperação da extensão I/O. Renovação
de autenticação e repetição de comandos precisam distinguir operações duráveis.
Esses achados foram encaminhados ao chat responsável pelo `plug_node`; a
implementação e suas evidências ficam no relatório desse projeto.

Relatório do checkout irmão: [alinhamento do plug_node](../../../plug_node/docs/communication-alignment.md).

Na revisão cruzada, o hub também descartava os detalhes de erros de ação no
envelope de falha `agents:command_response`. O handler e o cliente de referência
foram corrigidos para preservar apenas a allowlist segura, com regressões para
diagnóstico, recuperação e exclusão de payload privado. O comportamento REST não muda.

O artefato REST versionado estava atrasado em relação ao runtime/OpenAPI de I/O.
Foi sincronizado como contrato **2.1.0** aditivo, com baseline atualizado e
`contract:check` aprovado. Isso não altera a versão 1 de `agentActions.io`,
o perfil OpenRPC 2.11.2 ou o artefato REST v1 preservado.

## Critérios de compatibilidade

| Área | Critério de conclusão |
| --- | --- |
| Superfície | run, validateRun, sendInput, closeInput, getInputStatus, readIo, findExecution, getExecution e cancel acessíveis pelo nó |
| Autenticação | Bearer do hub separado da credencial local Client; identidade estável e aprovação preservadas |
| Bytes | Entrada/saída base64 e binário n8n sem conversão, newline ou interpretação de negócio |
| Entrega | IDs e sequências preservados; written não significa consumo; mensagens incertas consultadas sem replay |
| Recuperação | Cursor e offsets persistidos pelo workflow; reconectar não reinicia processo nem fecha stdin |
| Erros | Código RPC e código de domínio, fase, origem, diagnóstico, estado de entrega, efeitos e recuperação disponíveis sem segredos |
| Limites | Validar antes de cópias/alocações; páginas e filas limitadas; evitar agregar toda a execução em memória |
| Concorrência | Espera longa não bloqueia input, fechamento ou cancelamento; controlar leituras por execução/identidade |
| SQL novo | Negociação e contratos próprios; nunca fallback para execução legada nem replay após possível efeito |

## Validação e desempenho

Executar o corpus compartilhado nos validadores dos três projetos. Checkouts
ausentes devem falhar nos gates obrigatórios; exemplos ou mocks não comprovam
execução nativa. Validar REST, agents:command e relay, fidelidade binária, entrada
vazia, erros, revogação, resposta perdida e retomada sem repetição.

No node, medir cópias de buffers, memória por página, latência de controle durante
readIo e número de conexões/listeners após encerramento. Evitar polling ocupado,
compressão duplicada, reautenticação por bloco e filas ilimitadas. Não alterar
limites para melhorar benchmarks; comparar cargas e configurações equivalentes.

Aceitação do pacote n8n, testes de contrato, transporte simulado e processo real
são evidências distintas. Esta coordenação não publica pacotes, ativa I/O em
produção ou conclui os gates coordenados de persona-v2.

## Verificação do hub nesta coordenação

Em 30/10/2026, após as correções de erros Socket e validação da sessão: 2.571 testes aprovados e
25 testes opcionais ignorados; lint, tipos, `contract:check` e `changelog:check`
aprovados. Os testes de contrato exigiram o checkout do agente. Logs locais:
`tmp/plug-node-coordination-suite-final.log`. O relatório do node distingue sua
aceitação nativa de I/O dos testes SQL simulados e dos testes isolados da UI n8n.
A repetição final usou `npm test -- --maxWorkers=2` após um timeout do teste de
gates durante carga concorrente; esse teste também passou isoladamente. Nenhum
teste, timeout ou critério de publicação foi removido ou relaxado.

## Resultado no consumidor

### Revisão de indisponibilidade — 30/10/2026

O hub agora diferencia capacidade não anunciada, explicitamente desativada,
incompatível e sessão alterada antes do dispatch. REST/socket/relay preservam
motivo, origem e recuperação seguros. O serializador REST/agents:command e o
cliente de referência explicam `-32601` sem transformar timeout em recusa conhecida.
O exemplo canônico está no [guia REST](../api/api_rest_bridge.md#mensagem-para-recurso-indisponível).

Validação do hub: 2.578 testes passaram, 25 opcionais ignorados
(`tmp/capability-suite-final.log`); após o ajuste final da mensagem do cliente
de referência, seus 22 testes passaram (`tmp/capability-reference-final.log`).
Lint, tipos, contrato gerado e changelog passaram. No node, o log
`tmp/e2e-logs/availability-verify.log` registra 900 testes gerais aprovados,
um opcional ignorado, 380 testes do pacote e cobertura/build aprovados.
Esta revisão de mensagens usou testes simulados de incompatibilidade; não
representa nova execução nativa nem instalação de uma versão antiga do agente.

### Validação ponta a ponta de indisponibilidade em 31/10/2026

O cliente **compilado** do plug_node enviou chamadas ao hub autenticado em loopback
por REST, `agents:command` e relay. Cada linha abaixo foi exercitada nos três
transportes. A contagem de encaminhamentos se refere à chamada sob teste.

| Condição | Chamadas por transporte | Resposta observada no cliente | Encaminhamentos ao agente por chamada |
|---|---|---|---:|
| Agente v1.8.6 autenticado e pronto | I/O fiel e operação SQL | `CAPABILITY_UNAVAILABLE`, `not_advertised` | 0 |
| Agente atual, I/O desativado no registro e SQL não anunciado | I/O fiel e operação SQL | `CAPABILITY_UNAVAILABLE`, `not_advertised` | 0 |
| Agente atual, handler I/O desativado após negociação | Operação de I/O | `CAPABILITY_UNAVAILABLE`, `disabled`, `origin: agent` | 1 |
| Agente atual, método removido do registro da fixture | `getExecution` | JSON-RPC `-32601`, `method_not_found` | 1 |

Os 18 casos registraram um envio por chamada, com `retryable`, `effects_possible`
e `outcome_unknown` falsos. O contador de processos na fixture atual permaneceu
constante durante as recusas. A remoção controlada do método exercitou o dispatcher
atual. A validação histórica usou os fontes da tag `v1.8.6`, commit
`865a3d074e37fe28696d9a65e78e8151e179eb93`, com o transporte, o dispatcher e o
provedor de capacidades dessa versão. O Flutter local resolveu as dependências
offline e ajustou sete versões de SDK/teste. A instalação do binário distribuído
permanece fora da cobertura desta execução.

A matriz detectou duas incompatibilidades de transporte. O cliente aguardava o
resultado do relay mesmo após uma recusa em `relay:rpc.accepted`. O hub chamava o
ACK de `rpc:response` sem argumento, o que gerava uma exceção no cliente Dart da
v1.8.6. Agora a recusa correlacionada encerra a espera, e o ACK envia um argumento
`null`. O agente também fornece motivo e orientação na recusa local anterior à
execução. [Contrato dos erros](../api/api_rest_bridge.md#mensagem-para-recurso-indisponível).

Para reproduzir, extraia a tag em um diretório de teste separado, confira o commit
e execute `flutter pub get --offline` nessa cópia. Com o plug_node compilado,
execute no diretório do plug_node, em sequência:

```powershell
node scripts/verify-native-availability.mjs ../plug_agente ../plug_server $dart
node scripts/verify-native-availability.mjs ../plug_agente ../plug_server $dart --historical-root ../plug_server/tmp/agent-v1.8.6
```

`$dart` é o caminho absoluto do executável Dart do Flutter. O cenário histórico
usa a [fixture da v1.8.6](../../tool/homologation/agent_1_8_6_availability_test.dart).
Os resultados por chamada ficam no plug_node em
`tmp/native-node-availability/availability-report.json` e
`tmp/native-node-availability-historical/availability-report.json`.

A suíte completa do plug_server passou com 2.581 testes e 25 ignorados
(`tmp/availability-native-hub-suite.log`). Lint, tipos, contratos e changelog
passaram. No plug_node, passaram 1.281 testes, com um opcional ignorado, além
de build e instalação isolada do pacote. No plug_agente, passaram os 13 testes
do handler e a análise Dart dos arquivos alterados. Os logs de execução da matriz
ficam no plug_node em `tmp/e2e-logs/availability-e2e-current.log` e
`tmp/e2e-logs/availability-e2e-historical.log`.

Na revisão interna posterior de 31/10, a repetição incluiu `listAvailable` nos
três transportes contra o código da tag histórica. Os relatórios passaram a
registrar 21 casos, 12 atuais e nove históricos. Nos três novos casos, a ausência
de `catalogVersion` retornou `not_advertised` com zero encaminhamentos. O
contrato REST 2.2.0 inclui o catálogo na união de comandos do Swagger.

### Revisão do journal do agente e do cliente n8n

O journal rejeita inteiros fora de 0–255 antes de copiá-los. Se um bloco
ultrapassar os 64 MiB acumulados, o agente confirma a transação com o prefixo
permitido antes de sinalizar `ACTION_OUTPUT_LIMIT_EXCEEDED`. Um timeout de
escrita registra `ACTION_STDIN_WRITE_TIMEOUT` com entrega `unknown`, inclusive
se a operação nativa terminar mais tarde. O cliente rejeita páginas com saltos
de sequência e conserva os parâmetros validados durante a espera pelo socket.
Uma chamada vencida na fila termina com zero emissões.

Na leitura do journal, o agente calcula o tamanho do campo base64 pela quantidade
de bytes. Um microbenchmark local com sete rodadas de 400 eventos de 64 KiB
mediu uma queda de 271,9 ms para 0,99 ms na mediana do cálculo do tamanho. A
medição excluiu SQLite, criptografia, transporte e execução do processo.

Verificação em 31/10/2026: 328 testes de I/O do agente passaram. No plug_node,
passaram 938 testes gerais e 380 do pacote, com um teste opcional ignorado,
além de lint, tipos, cobertura e build. Evidências locais no plug_node em
`tmp/e2e-logs/io-internals-final.log`, `io-internals-binary.log`,
`io-internals-current.log` e `io-internals-historical.log` na mesma pasta.

### Carga bidirecional com consumidor lento e retomada por cursor

Em 31/10/2026, o cliente compilado do plug_node enviou 64 blocos de 64 KiB a
um processo Windows via hub e agente autenticados. Cada execução produziu 4 MiB
em stdout e 4 MiB em stderr enquanto o cliente ainda escrevia. O leitor esperou
45 ms entre páginas, interrompeu a leitura por 100 ms após receber bytes dos dois
streams e retomou pelo último cursor. Consumiu até `completed` e verificou as
sequências, os offsets, os dois hashes e a quantidade de processos iniciados.

Foram comparadas três rodadas completas por versão do agente. Cada rodada
executou um processo por socket direto e outro por REST. O agente passou a
acordar o worker de stdin e o leitor de stdout/stderr após o commit do journal
da execução. As medianas dos p95 de eco passaram de 253 para 137 ms no socket e
de 335 para 253 ms no REST. A vazão observada, incluindo as pausas intencionais,
passou de 0,55 para 0,54 MiB/s no socket e de 0,44 para 0,45 MiB/s no REST.

O pico amostrado do cliente REST subiu de 124 para 143 MiB. Os picos do agente
ficaram em aproximadamente 297 MiB no socket e 300 MiB no REST após a mudança.
As medições cobrem uma execução por vez, com processos locais de teste. O p95
do eco de cada rodada corresponde ao máximo de sete blocos cadenciados. A
reconexão do socket ocorreu com nova conexão autenticada. Em REST, o leitor
recriou o adaptador, sem exigir que o sistema abrisse outra conexão TCP.

O procedimento reproduzível está no plug_node em
`docs/performance-and-reliability.md`. As medições por rodada, hashes do código,
amostragem de memória dos quatro processos e exclusões estão em
`scripts/benchmarks/native-action-io-load.json` no mesmo repositório.

Uma execução adicional com os arquivos atuais do workspace passou em socket
e REST, separada da comparação controlada. Ambas retomaram do cursor 2, com
65.536 bytes já lidos por stream, e chegaram ao evento 130 com os hashes
esperados. Os dados estão em `currentWorkspaceConfirmation` no JSON. A suíte
de I/O do agente passou com 331 testes, e a análise Dart dos arquivos alterados
passou sem avisos.

O `plug_node` concluiu os recursos Agent Action I/O e SQL Extensions: nove
operações I/O, descoberta/inspeção, operações SQL duráveis e health, cobrindo o
inventário de 22 métodos do OpenRPC junto aos métodos legados. Essa cobertura
não inclui todos os modos opcionais: a nova superfície de ações usa I/O fiel.
O modo SQL avançado também preserva expectedSource/expectedStructure.

Foram aprovados 883 testes gerais (um skip opcional), 380 testes do pacote,
limites de cobertura, build e instalação isolada do tarball. A repetição nativa
após o build final confirmou REST, Socket e relay do cliente compilado até o
processo Windows real. Logs no node: `tmp/e2e-logs/alignment-verify-release.log`,
`alignment-pack-final.log` e `alignment-native-final.log` na mesma pasta.

Conexões Socket são reutilizadas durante a execução do nó e liberadas ao final;
input e páginas permanecem limitados. A medição local de decodificação/validação
de página de 256 KiB registrou mediana de 2,46 ms e p95 de 4,71 ms, sem medir rede
ou banco e sem comparação de ganho ponta a ponta. Detalhes reproduzíveis ficam
no relatório do node. SQL em banco real e instalação em um worker/editor n8n
não foram executados nesta coordenação; não são apresentados como aceites concluídos.
