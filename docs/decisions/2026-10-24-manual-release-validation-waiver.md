# Dispensa de validações manuais para publicação

Data: 2026-10-24. Origem: decisão explícita do responsável pelo projeto neste chat.

À pergunta sobre a obrigatoriedade de validação manual real de HTTPS/ChatGPT e
aceite funcional humano separado dos testes, o responsável respondeu:
"pode remover estas validações".

Para esta publicação, essas duas exigências deixam de ser pré-condições.
Devem constar como dispensadas por decisão do responsável, nunca como testes
executados, aprovados ou comprovação de funcionamento no ChatGPT real.

Continuam obrigatórios os critérios técnicos dos treze gates coordenados,
incluindo segurança e OAuth automatizados, comunicação real e compatibilidade
com plug_agente 1.8.6, Node 24, motores de banco exigidos, identidade das fontes
e do artefato testado e validação de recuperação. A dispensa não altera contratos
públicos, consentimento OAuth nem aprovação de operações em tempo de execução.

O manifesto permanece `ready:false` enquanto esses critérios estiverem pendentes.
Esta decisão não constitui evidência técnica nem autoriza promover uma imagem
cujo CI ou homologação obrigatória falhou. O registro de evidências no MCP deve
representar a dispensa explicitamente, sem inventar um revisor ou aceite humano.

A exceção termina ao encerrar esta publicação ou se o responsável restabelecer
as exigências manuais. O verificador do hub continua exigindo todos os gates;
não há mudança de código ou redução de seus controles nesta decisão.
