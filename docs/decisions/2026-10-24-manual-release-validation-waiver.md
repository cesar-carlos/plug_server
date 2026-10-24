# Dispensa de validações manuais para publicação

Data: 2026-10-24. Origem: decisão explícita do responsável pelo projeto neste chat.

À pergunta sobre a obrigatoriedade de validação manual real de HTTPS/ChatGPT e
aceite funcional humano separado dos testes, o responsável respondeu:
"pode remover estas validações".

Para esta publicação, essas duas exigências deixam de ser pré-condições.
Devem constar como dispensadas por decisão do responsável, nunca como testes
executados, aprovados ou comprovação de funcionamento no ChatGPT real.

Continuam obrigatórios os demais critérios técnicos dos treze gates coordenados,
incluindo segurança e OAuth automatizados, comunicação real, Node 24,
motores de banco exigidos, identidade das fontes
e do artefato testado e validação de recuperação. A dispensa não altera contratos
públicos, consentimento OAuth nem aprovação de operações em tempo de execução.

O manifesto permanece `ready:false` enquanto esses critérios estiverem pendentes.
Esta decisão não constitui evidência técnica nem autoriza promover uma imagem
cujo CI ou homologação obrigatória falhou. O registro de evidências no MCP deve
representar a dispensa explicitamente, sem inventar um revisor ou aceite humano.

A exceção termina ao encerrar esta publicação ou se o responsável restabelecer
as exigências manuais. O verificador do hub continua exigindo todos os gates;
não há mudança de código ou redução de seus controles nesta decisão.

## Dispensa posterior da validação específica 1.8.6

Na mesma data, à solicitação de uma VM isolada para validar o instalador público,
o responsável respondeu: "nao precrisa fazer teste de compatibilidade com
plug_agente 1.8.6 . remova se tiver em alguma documentacao exigencia".

A exigência documental de validação específica de compatibilidade com 1.8.6 é
dispensada nesta publicação, inclusive execução do binário instalado em VM.
Não é necessário disponibilizar uma VM para essa finalidade. A cobertura
automatizada já existente no CI permanece inalterada; esta decisão não remove
jobs nem testes. Resultados anteriores são históricos e não comprovam um novo
candidato por si só.

Essa dispensa não autoriza mudanças nos contratos ou no comportamento dos
clientes existentes, nem comprova suporte do agente antigo às extensões novas.
As verificações dispensadas devem ser identificadas como tais, nunca aprovadas.
