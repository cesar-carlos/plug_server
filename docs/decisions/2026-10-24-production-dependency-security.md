# Correções de dependências antes da publicação

A auditoria de produção em 2026-10-24 encontrou cinco pacotes afetados no lockfile
de `8f7cf8a`: dois avisos altos e três moderados. O CI anterior não executava
essa auditoria; seu sucesso não comprovava ausência desses avisos.

O lockfile atualiza as dependências dentro das faixas já autorizadas pelo
`package.json`, sem alterar contratos HTTP/Socket, configurações ou Node 24:

| Dependência | Antes | Depois |
| --- | --- | --- |
| body-parser | 2.3.0 | 2.4.0 |
| multer | 2.4.0 | 2.5.0 |
| fast-uri | 3.1.8 | 3.1.9 |
| ip-address | 10.7.3 | 10.7.4 |
| nodemailer | 10.1.2 | 10.2.1 |
| qs (dependência do parser) | 6.16.0 | 6.16.1 |

Referências dos avisos altos: [body-parser](https://github.com/advisories/GHSA-27r3-jxmh-p828)
e [multer](https://github.com/advisories/GHSA-q7qp-rjg7-q26m).

O job obrigatório Static passa a executar
`npm audit --omit=dev --audit-level=high`, sem ignorar falhas. A auditoria
reproduziu o problema antes da atualização e retornou zero vulnerabilidades
após resolver as dependências corrigidas. Os metadados de plataforma das
dependências nativas não relacionadas foram preservados.

O build isolado de `8f7cf8a` no VPS é evidência histórica e não deve ser promovido.
A revisão corrigida precisa de seu próprio CI, build e evidência integrada.
As dispensas de validação manual e de teste específico instalado 1.8.6 não
dispensam segurança de dependências. O deploy permanece bloqueado enquanto
os critérios técnicos coordenados estiverem pendentes.
