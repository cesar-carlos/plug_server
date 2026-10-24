# Atualização excepcional somente do servidor

Em 2026-10-24, o responsável respondeu **"Autorizar exceção apenas para o
servidor"** à escolha explícita entre aguardar o aceite completo da persona-v2
e atualizar somente as dependências do hub. Esta decisão autoriza um único
corte do plug_server, sem publicar MCP ou atualizar agentes instalados.

## Escopo fixado

- Produção anterior: `8a4d9a559702cc742a839b0b6b3b70ec3b7aa4a2`.
- Candidato de runtime: `da457e05e3fd4ee407d7aefb2c58d82c7e6d92f5`.
- Node de destino: 24.21.0, conforme `.nvmrc`; produção anterior usa 24.18.0.
- O diff entre essas revisões não altera `src`, `contracts`, `prisma` ou
  `.nvmrc`. As mudanças são dependências, testes, CI, regras e documentação.
- Não executar migrações, modificar configurações/segredos, habilitar extensões
  nem alterar contratos públicos. Preservar banco, uploads e agentes existentes.

## Evidências anteriores ao corte

- [CI do candidato](https://github.com/cesar-carlos/plug_server/actions/runs/40092383266):
  todos os jobs aprovados, incluindo testes, contratos Dart, REST e Socket.
- [CodeQL](https://github.com/cesar-carlos/plug_server/actions/runs/40092383157): aprovado.
- A primeira tentativa dos benchmarks falhou; uma repetição do mesmo commit
  passou sem mudar limites. Os dois resultados foram preservados. No REST,
  `catalog_many` passou com p95 base 5.994512 ms e candidato 6.031651 ms,
  sem erros ou timeouts. Isso não comprova eliminação da variabilidade.
- Dependências de produção: auditoria sem vulnerabilidades após as correções.
- Build isolado na VPS, Node 24.21.0: instalação, geração Prisma e build aprovados.
  Arquivo de fontes SHA-256:
  `981ec55eb7e5c94060f216c7c2e0043128a9e310041ba564cb14f1c8d800e408`.
  `dist/server.js` SHA-256:
  `57b616714587a38ce4ac1fe71d3eef220437956b0903e131fea4f0d448155565`.
- Cópia dos arquivos atuais restaurada em pasta isolada: 31.764 arquivos
  conferidos por SHA-256. Arquivo de recuperação SHA-256:
  `88d902f8e9d720362d29db09b9a2da4e0504982d82f2edd67ec67d46210f0e55`.
  Esse ensaio não representa restauração do banco nem failover real.
- Antes do corte, produção respondeu HTTP 200 e seu checkout estava limpo.

## Execução e recuperação

Usar o build já validado, conferir revisão e hashes antes da troca, preservar
o diretório de trabalho e os dados persistentes. Parar ordenadamente o processo,
substituir somente os arquivos de runtime e reiniciar com Node 24. Conferir
saúde e estabilidade do novo processo; em falha, restaurar o runtime anterior
e seu interpretador Node 24.18.0. Não reenviar operações de cliente.

Um reinício pode interromper conexões ativas; não representa garantia de
continuidade de requisições em trânsito. Não executar SQL operacional como teste.

## Limites da autorização

O manifesto persona-v2 permanece `ready:false`; nenhum gate é declarado
concluído. O avaliador de IA v2, a prova com usuários restritos e demais lacunas
continuam pendências da plataforma. O verificador de release permanece intacto.
Esta exceção explícita de operação não libera Docker, MCP ou distribuição do
agente e expira após este corte ou seu rollback. O resultado operacional deve
ser registrado separadamente, sem transformar o plano em execução comprovada.

## Resultado operacional — 2026-10-24, 08:59 America/Cuiaba

A atualização foi executada somente no plug_server. O checkout operacional
avançou para `8ae8336798889f08e04ddaf19254ab49880809f4`, que acrescenta apenas
esta decisão e sua regra ao runtime testado `da457e0`. Os arquivos de runtime
foram promovidos do build isolado já validado, sem executar instalação no
diretório ativo. O processo anterior foi parado e reiniciado; o novo PID
`2589567` usou Node 24.21.0, ficou online e não apresentou reinícios inesperados
nas verificações iniciais. A configuração do PM2 foi salva com esse interpretador.

Resultados observados:

- Saúde e prontidão locais: HTTP 200.
- HTTPS público: saúde, prontidão e Swagger HTTP 200, certificado validado.
- Handshake público WebSocket/Engine.IO: aprovado, sem autenticar cliente ou
  executar operação de negócio. A sondagem inicial por polling retornou
  `Transport unknown`, coerente com a configuração existente de produção
  somente WebSocket; nenhuma configuração foi alterada para aceitar a sondagem.
- `.env` preservado por comparação de hash antes/depois; nenhum comando de
  migração, atualização de agente ou publicação do MCP foi executado.
- Dependências carregáveis conferidas: body-parser 2.4.0, multer 2.5.0,
  nodemailer 10.2.1 e qs 6.16.1.
- Checkout limpo, manifesto persona-v2 ainda `ready:false`.
- Cópia de recuperação e diretórios do runtime anterior mantidos no servidor.
  Não houve necessidade de rollback. A verificação não simula todos os fluxos
  dos clientes nem constitui aceite integral da persona-v2.

Antes do corte, uma inspeção detectou que o checkout já havia avançado por
`git pull` para `da457e0` às 12:45:40 UTC, enquanto o processo antigo continuava
ativo. A preparação foi interrompida para conferir essa mudança; não havia
instalação concorrente ativa, e a troca do runtime ocorreu somente depois.
