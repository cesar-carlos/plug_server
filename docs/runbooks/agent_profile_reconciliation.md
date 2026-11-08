# Reconciliação de versões do perfil do agente

`agent.register` envia um snapshot local ao hub. O ACK confirma o registro da
conexão, não a aplicação do perfil nem o download do catálogo do servidor.
`agent.getProfile` também consulta o agente; repetir esse RPC não atualiza seu
perfil local. Versão de perfil não é versão do executável do agente.

Quando `remoteProfileVersion < currentProfileVersion`, o hub preserva o catálogo
mais novo. Não reduza a versão do banco, remova a proteção ou incremente apenas
o contador local: isso pode transformar conteúdo antigo em uma atualização válida.

## Diagnóstico

- `agent_profile_update_skipped_stale_remote_version`: a gravação foi ignorada.
- `agent_profile_sync_requires_reconciliation`: o snapshot de registro não foi
  aplicado porque o servidor retornou versão superior. Inclui ambas as versões
  e `recoveryAction: compare_profiles_before_reload`, sem conteúdo do perfil.
  Não há retry automático nem cache de sucesso para essa tentativa.
- Antes dessa correção, `agent_profile_sync_success` também aparecia após uma
  gravação ignorada; não use esse evento histórico como prova de convergência.

Consulte a revisão do catálogo e a auditoria, quando disponível. A ausência de
revisões históricas não prova ausência de edições: registros anteriores à
auditoria podem não ter histórico. Não registre valores pessoais em logs.

## Recuperação sem perda de dados

1. No agente afetado, preserve uma cópia do perfil local e eventuais edições
   ainda não sincronizadas. Compare com o catálogo do hub usando a identidade
   autenticada do próprio agente. Não faça PATCH exploratório.
2. Se o catálogo do hub for o conteúdo desejado, use o fluxo de recarregar perfil
   do hub disponível no agente. Ele carrega conteúdo, versão e data juntos,
   persiste a configuração e invalida o cache do snapshot de registro.
3. Se houver alterações locais legítimas, reconcilie os campos antes de salvar.
   A gravação deve usar `expectedProfileVersion` da versão que foi comparada.
   Um conflito 409 exige nova leitura e comparação, nunca repetição sem condição.
4. Confirme a persistência local de conteúdo e versão após reinício e um novo
   registro. Verifique que o aviso não reaparece. Falha de persistência local
   após PATCH não autoriza repetir a atualização sem consultar o catálogo.

O hub não tem acesso à configuração em disco do agente nem pode decidir quais
edições locais não sincronizadas descartar. A recuperação exige acesso ao agente
afetado; atualizar somente o servidor não corrige automaticamente seu snapshot.

## Investigação de 2026-11-08

O agente identificado nos diagnósticos pelo hash `b4d1226c32` enviava versão 8;
consulta somente leitura confirmou versão 9 no servidor, com
`profileUpdatedAt=2026-09-09T12:26:11.774Z`, sem revisões na tabela de auditoria.
Não é possível atribuir a origem da versão 9 com esse histórico. Nenhum conteúdo
de produção foi sobrescrito; a convergência depende da comparação local acima.

A instalação local consultada somente para identidade e metadados usa outro
agente (`3480efe56a`), com versão 46. Ela não é o alvo do incidente 8/9.
