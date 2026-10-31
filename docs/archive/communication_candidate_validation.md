# Validação histórica da candidata de comunicação

Snapshot preservado da matriz de sincronização: hub f39752f e agente 55da4490,
com alterações locais daquele levantamento. Contagens, falhas e pendências abaixo
não descrevem automaticamente o checkout atual. Para contratos e evidências
posteriores, consulte a [matriz de sincronização](../plug_agente/communication_sync_plug_agente.md)
e a [integração I/O](../plug_agente/remote_action_io_specification.md).

### Estado da validação da candidata

Revisions de referência: hub `f39752f` e agente `55da4490`, acrescidas das
alterações locais de comunicação ainda não publicadas. Os relatórios locais
separam microbenchmarks, relay real, Dart e ODBC. A aprovação de rollout
permanece bloqueada pelos gates de desempenho; seus limites não foram alterados.

| Verificação | Evidência / limite |
| --- | --- |
| Hub funcional e contratos | Suíte completa, formatação, lint, tipos, contratos, OpenRPC e build; verificações Prisma, auditoria persistida e duas réplicas executadas com PostgreSQL/Redis isolados |
| Dart ↔ hub | Três variantes passaram: codecs/socket, transporte de produção com gateway determinístico e smoke ODBC real; fixtures e regressões de lifecycle/controle passaram |
| Agente completo | A última execução offline teve 4.723 testes aprovados, 14 falhas em ODBC/Agent Actions e 5 skips; análise e formatação globais também encontraram problemas fora dos arquivos de comunicação em alteração concorrente. Análise dos arquivos de comunicação passou; isso não substitui os gates globais |
| Performance | REST/Prisma e correção dos cenários colunares passaram; comparações relativas Socket e Dart falharam em p95. Heap Dart, carga conjunta com ODBC, erros/timeouts sob carga representativa e homologação de 15 minutos permanecem pendentes |
| CI remota | Workflows atualizados e YAML validado localmente; não executados remotamente nesta entrega sem push |

Os testes live/perf opt-in e as leituras Prisma que a suíte em memória ignora
foram exercitados separadamente onde indicado. Não interpretar skips restantes
ou um benchmark sem baseline compatível como aprovação integral.

