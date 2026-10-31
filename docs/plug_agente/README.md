# Integração com plug_agente

Este índice direciona para contratos, integração e evidências. Detalhes normativos
ficam nos documentos responsáveis abaixo; registros históricos não comprovam
homologação atual nem autorizam publicação.

## Integração atual

| Necessidade | Documento responsável |
| --- | --- |
| Cobertura, diferenças entre repositórios e checklist de atualização | [Matriz de sincronização](communication_sync_plug_agente.md) |
| Autenticação REST, execução, input/output, erros e reconexão | [Guia REST](../api/api_rest_bridge.md) |
| Contrato da ponte I/O fiel, autorização e clientes de referência | [Integração I/O](remote_action_io_specification.md) |
| Exemplos JSON-RPC de I/O validados | [Exemplos de ações](remote_action_io_examples.md) |
| Consumidor n8n, lacunas e critérios de aceitação entre projetos | [Alinhamento plug_node](plug_node_alignment.md) |
| Transporte relay e PayloadFrame | [Protocolo relay](../socket/socket_relay_protocol.md) |
| Cliente Socket.IO | [Guia do cliente socket](../socket/socket_client_sdk.md) |
| Ownership, aprovação e revogação de Client | [Regras de acesso](../api/client_agent_business_rules.md) |
| Namespaces, registro e migração | [Migração de namespaces](migracao_plug_agente_namespaces.md) |

As extensões SQL de inspeção, expectedStructure e operações duráveis são descritas
no guia REST e acompanhadas pela matriz de sincronização. Este índice não mantém
uma segunda versão desses contratos ou das pendências de publicação.

No checkout irmão, OpenRPC e schemas em
[docs/communication](../../../plug_agente/docs/communication/) definem os métodos
do agente; action_io.md descreve execução, journal e recuperação. As fixtures em
[drafts](drafts/) são exemplos de documentação exercitados pelos testes, não
validadores de runtime nem uma indicação de que I/O ainda seja apenas proposta.

## Histórico e decisões de desempenho

- [Echo de body.id](01_relay_body_id_echo.md) — histórico das opções A/B.
- [Mudanças restritas ao hub](02_no_change_items.md) — impacto das entregas enumeradas no agente.
- [Roadmap histórico](03_performance_roadmap.md) — propostas e itens numerados.
- [Registro de implementação](04_agent_implementation_status.md) — commits e testes datados.
- [Migração de canal e desempenho](05_channel_migration_performance.md) — checklist de rollout P4.
- [ADRs](../adrs/) — decisões de protocolo, incluindo batch, echo, health e phases.
- [Aceitação nativa de 15/10/2026](../archive/native_acceptance_2026-10-15.md) — ODBC, recuperação e bootstrap Windows.

Voltar ao [índice geral](../README.md).
