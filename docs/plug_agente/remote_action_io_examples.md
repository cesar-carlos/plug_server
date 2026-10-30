# Guia de integração de ações: entrada, saída e erros

Revisão: 2026-10-30. Os exemplos mostram o JSON lógico dentro do transporte
existente, não substituem `PayloadFrame` nem a autenticação do canal. Credenciais
foram omitidas; chamadas reais precisam da autorização aplicável.

## 1. Contrato disponível hoje

For current availability, permissions, lifecycle and reference clients, see
[Remote action I/O integration](remote_action_io_specification.md). The extension
is implemented and validated for development, disabled by default. Legacy textual
output below is distinct from the faithful byte streams in section 2.

### Iniciar e consultar uma ação salva

```json
{"jsonrpc":"2.0","id":"run-1","method":"agent.action.run","params":{"action_id":"acao-salva","idempotency_key":"intencao-unica-1"}}
```

O resultado de `run` contém o snapshot da execução, incluindo `execution_id`.
Uma nova execução confirma admissão, não conclusão; uma chave duplicada pode
retornar a execução original já concluída. A resposta completa é definida
no OpenRPC do agente; não presumir que stdout esteja pronto ao receber `run`.

```json
{"jsonrpc":"2.0","id":"get-1","method":"agent.action.getExecution","params":{"execution_id":"exec-1","include_output":true,"stdout_offset":0,"stderr_offset":0,"max_output_bytes":65536}}
```

O resultado atual inclui `status`, `process`, `output.stdout`, `output.stderr`
e `flags`. Consulte as indicações de captura/paginação/truncamento antes de
considerar a saída completa. Offsets atuais são bytes UTF-8, não caracteres.
Esse contrato textual não deve ser confundido com os bytes opacos da extensão abaixo.

### Timeout ou desconexão após possível envio de run/cancel

Exemplo de erro lógico do relay já implementado (IDs ilustrativos):

```json
{
  "jsonrpc":"2.0",
  "id":"run-1",
  "error":{
    "code":-32000,
    "message":"Timed out waiting for agent response",
    "data":{
      "code":"ACTION_OUTCOME_UNKNOWN",
      "retryable":false,
      "outcome_unknown":true,
      "phase":"await_response",
      "origin":"hub",
      "recovery":"reconcile_execution",
      "hint":"Query agent.action.getExecution if execution_id is known; otherwise reconcile with agent history. Do not resend automatically.",
      "conversation_id":"conv-1",
      "client_request_id":"run-1"
    }
  }
}
```

REST usa o envelope HTTP de erro existente, status 503, com o mesmo código e
detalhes; não pressupor que todo erro REST seja um envelope JSON-RPC. No relay,
desconexão mantém esses detalhes com mensagem de desconexão. Recusa antes do
dispatch mantém seu erro original. Resultado desconhecido não comprova sucesso,
falha ou ausência de efeitos. Consulte `getExecution` se conhecer o ID; caso
contrário, reconcilie com o histórico do agente. Não gere nova chave para tentar
novamente automaticamente.

## 2. Binary bridge — validated documentation examples

Schema verificável: [action_io_v1.schema.json](drafts/action_io_v1.schema.json).
Estados, catálogo de erros e rastreabilidade:
[integration reference](remote_action_io_specification.md).

These examples are checked against the documentation schema. Runtime callers
must follow canonical agent OpenRPC and per-method validation. The bridge does
not interpret business content or alter encoding/framing.

### Capacidade e abertura

Negotiated representation inside `extensions.agentActions`:

```json
{"io":{"version":1,"max_block_bytes":65536,"max_read_bytes":262144,"max_page_events":256,"max_json_bytes":524288,"max_execution_bytes":67108864,"max_queued_messages":16,"max_queued_bytes":1048576,"max_execution_messages":8192,"max_execution_events":65536,"max_wait_ms":20000,"request_timeout_ms":30000,"output_retention_seconds":86400,"deduplication_retention_seconds":259200,"max_readers_per_execution":1,"max_readers_per_client":8,"max_readers_per_connection":16,"max_readers_per_agent":32,"supports_interactive_input":true,"requires_local_credential":true,"automatic_replay":false}}
```

O suporte efetivo também depende do runner e da aprovação local para modo fiel.
Capability não concede autorização. Sem suporte negociado, recusar antes de
executar; nunca remover o input e executar em modo legado.

```json
{"jsonrpc":"2.0","id":"run-2","method":"agent.action.run","params":{"action_id":"acao-salva","trigger_id":"gatilho-remoto","idempotency_key":"intencao-unica-2","io":{"version":1,"mode":"faithful","initial_input_base64":"b2kK","close_input":false}}}
```

`b2kK` representa exatamente os bytes `6f 69 0a` (`oi` e newline). O newline
está nos dados, não é inserido pela ponte. Ausência de entrada inicial significa
nenhuma mensagem inicial; string vazia representa entrada explícita de zero bytes.
Initial input explicitly supplied ocupa sequência 0; sem ela, a primeira
mensagem enviada usa sequência 0. Nunca reconstruir sequência por suposição:
usar o valor retornado pelo agente.

Admission response example:

```json
{
  "jsonrpc": "2.0",
  "id": "run-2",
  "result": {
    "execution_id": "exec-2",
    "action_id": "acao-salva",
    "action_type": "executable",
    "status": "queued",
    "source": "remoteHub",
    "requested_at": "2026-10-28T12:00:00.000Z",
    "idempotency_key": "intencao-unica-2",
    "trigger": {
      "trigger_id": "gatilho-remoto",
      "trigger_type": "remote"
    },
    "timestamps": {},
    "process": {},
    "output": {
      "stdout": {
        "captured": false,
        "truncated": false,
        "utf8_total_bytes": 0,
        "offset": 0,
        "next_offset": 0,
        "response_truncated": false
      },
      "stderr": {
        "captured": false,
        "truncated": false,
        "utf8_total_bytes": 0,
        "offset": 0,
        "next_offset": 0,
        "response_truncated": false
      }
    },
    "flags": {
      "terminal": false,
      "skipped": false,
      "timed_out": false,
      "cancelled": false,
      "killed": false,
      "redaction_applied": false
    },
    "io": {
      "version": 1,
      "mode": "faithful",
      "process_state": "queued",
      "stdin_state": "pending",
      "capture_state": "capturing",
      "output_expired": false,
      "next_input_sequence": 1,
      "initial_message_id": "system:initial"
    }
  }
}
```

Entrada adicional espera sessão pronta. `validateRun` aceita o mesmo
`io` e `trigger_id`, validando sem executar. Ambos exigem a extensão negociada.

### Enviar entrada e confirmar entrega

```json
{"jsonrpc":"2.0","id":"write-1","method":"agent.action.sendInput","params":{"execution_id":"exec-2","message_id":"msg-1","sequence":1,"data_base64":"AP+A"}}
```

`AP+A` representa `00 ff 80`, sem conversão para texto.

```json
{"jsonrpc":"2.0","id":"write-1","result":{"execution_id":"exec-2","message_id":"msg-1","sequence":1,"state":"accepted","next_input_sequence":2,"confirmed_bytes":0,"stdin_state":"open"}}
```

`accepted` confirma registro, não escrita. Consultar sem reenviar:

```json
{"jsonrpc":"2.0","id":"status-1","method":"agent.action.getInputStatus","params":{"execution_id":"exec-2","message_id":"msg-1"}}
```

```json
{"jsonrpc":"2.0","id":"status-1","result":{"execution_id":"exec-2","message_id":"msg-1","state":"written","confirmed_bytes":3,"sequence":1,"next_input_sequence":2,"stdin_state":"open"}}
```

Delivery states: `accepted`, `writing`, `written`, `failed`, `unknown`.
`written` confirma escrita no pipe, nunca consumo ou efeito de negócio. Em falha
parcial, `confirmed_bytes` pode ser desconhecido (`null`); não transformar em zero.
Mesma mensagem e bytes consultam o resultado deduplicado; conteúdo diferente é
conflito. Não reenviar automaticamente mensagens com entrega incerta.

### Fechar stdin

```json
{"jsonrpc":"2.0","id":"close-1","method":"agent.action.closeInput","params":{"execution_id":"exec-2","message_id":"close-msg-1","sequence":2}}
```

```json
{"jsonrpc":"2.0","id":"close-1","result":{"execution_id":"exec-2","message_id":"close-msg-1","state":"accepted","stdin_state":"closing","sequence":2,"next_input_sequence":3,"confirmed_bytes":0}}
```

Fechamento entra na mesma fila; `closing` recusa novas entradas e aguarda escritas
anteriores. `closed` significa EOF de stdin, não processo terminado. Consultar o
fechamento por `getInputStatus`, usando seu `message_id`.

### Ler output e retomar

```json
{"jsonrpc":"2.0","id":"read-1","method":"agent.action.readIo","params":{"execution_id":"exec-2","after_sequence":0,"max_bytes":262144,"wait_ms":20000}}
```

Cursor inicial 0, eventos numerados a partir de 1; próxima leitura usa
`next_sequence`. Page example:

```json
{
  "jsonrpc":"2.0","id":"read-1",
  "result":{
    "execution_id":"exec-2",
    "events":[
      {"sequence":1,"type":"output","stream":"stdout","offset":0,"data_base64":"b2sK"},
      {"sequence":2,"type":"output","stream":"stderr","offset":0,"data_base64":"YXZpc28K"}
    ],
    "next_sequence":2,"terminal":false,"output_complete":false
  }
}
```

stdout contém `ok\n`; stderr contém `aviso\n`. Concatenar bytes por stream e offset,
deduplicando por sequência. Limites de blocos não são limites de mensagens do
programa. Não decodificar cada bloco isoladamente: caracteres podem atravessar
blocos. Não inferir erro apenas por haver stderr. `output_complete:false` durante
a execução significa captura em andamento, não necessariamente perda.

```json
{"jsonrpc":"2.0","id":"read-2","method":"agent.action.readIo","params":{"execution_id":"exec-2","after_sequence":2,"max_bytes":262144,"wait_ms":20000}}
```

```json
{"jsonrpc":"2.0","id":"read-2","result":{"execution_id":"exec-2","events":[{"sequence":3,"type":"process_exited","exit_code":0},{"sequence":4,"type":"completed","output_complete":true}],"next_sequence":4,"terminal":true,"output_complete":true}}
```

`process_exited` não implica EOF dos pipes. O evento `completed` só vem após
drenagem ou falha explicitamente registrada. Saída incompleta continua incompleta
mesmo com exit code zero. Uma leitura longa pode retornar página vazia; nesse caso
manter cursor. Reconexão retoma pelo cursor, sem iniciar processo novamente.

### Recuperar chamada cuja resposta inicial se perdeu

```json
{"jsonrpc":"2.0","id":"find-1","method":"agent.action.findExecution","params":{"action_id":"acao-salva","idempotency_key":"intencao-unica-2"}}
```

```json
{"jsonrpc":"2.0","id":"find-1","result":{"found":false,"reason":"not_found_in_retention_window","execution_id":null}}
```

Essa resposta não prova que a execução nunca ocorreu. Saída expira após
24 horas; deduplicação tem janela própria de pelo menos três dias e não expira
execução ativa. Não reutilizar chaves após expiração. Use `findExecution` com a ação e a chave
originais quando não houver `execution_id`; consulte o histórico local quando a
janela de consulta já não estiver disponível.

## 3. Bridge failure examples

[Exemplos JSON completos de falhas e casos especiais](drafts/action_io_failure_examples.json):

- `partial-write`: dois bytes confirmados, entrega restante desconhecida; consultar mensagem.
- `duplicate-written-message`: mesma mensagem retorna `written`, sem escrever novamente.
- `out-of-order`: sequência não admitida; consultar estado antes de corrigir.
- `expired-output`: execução não é repetida para regenerar saída.
- `disk-full`: falha de persistência exige intervenção e verificação de encerramento.
- `zero-exit-incomplete-capture`: exit code zero com saída incompleta e causa registrada.

These are schema-validated documentation fixtures. Executed runtime acceptance is recorded in the integration reference.

Write-failure documentation example (illustrative JSON-RPC category; use the
canonical method schemas for runtime error codes):

```json
{"jsonrpc":"2.0","id":"write-1","error":{"code":-32000,"message":"A escrita no stdin excedeu o prazo; parte da entrada pode ter sido entregue.","data":{"code":"ACTION_STDIN_WRITE_TIMEOUT","phase":"stdin_write","origin":"runner","request_id":"write-1","execution_id":"exec-2","message_id":"msg-1","diagnostic_id":"diag-123","delivery_state":"unknown","confirmed_bytes":null,"effects_possible":true,"retryable":false,"recovery":"query_message"}}}
```

Não colocar conteúdo, segredo, stderr ou linha de comando nesse envelope. Consultar
o diagnóstico protegido pelo identificador. Falha de cleanup é secundária e não
substitui a causa primária.

| Situação | Recuperação prevista | Reenvio automático |
| --- | --- | --- |
| Base64 inválido ou bloco grande | Corrigir solicitação; nada escrito | Não |
| Capability/runner/aprovação ausente | Corrigir configuração local | Não |
| Fila cheia antes de admitir | Aguardar capacidade e confirmar não admissão | Não cego |
| Sequência ou conteúdo conflitante | Consultar mensagem e estado de entrada | Não |
| stdin fechado | Consultar execução; não abrir implicitamente | Não |
| Escrita parcial/timeout | Consultar mensagem e reconciliar | Não |
| Limite de saída/disco cheio | Verificar término solicitado e saída incompleta | Não |
| Falha de encerramento | Intervenção local; efeitos podem continuar | Não |
| Journal corrompido/chave indisponível | Intervenção local; não recriar execução | Não |
| Saída expirada | Informar `OUTPUT_EXPIRED`; não regenerar executando de novo | Não |
| Cursor inválido/expirado | Consultar disponibilidade e indicar lacuna | Não cego |
| Código de saída não aceito | Interpretar resultado do processo, não erro de transporte | Não |

Os exemplos de falha ilustram recuperação e entrega. Os códigos e campos
canônicos são definidos pelo agente; a validação destes exemplos não substitui
a aceitação dos cenários de falha no runtime.

## 4. Checklist do consumidor

1. Confirmar capacidade negociada, autorização e aprovação da ação.
2. Gerar chave única de execução e IDs de mensagem; guardar a correlação.
3. Diferenciar aceitação, escrita no pipe, consumo pelo programa e conclusão.
4. Serializar entradas e respeitar sequência/limites informados pelo agente.
5. Ler em paralelo com a escrita para não bloquear protocolos bidirecionais.
6. Persistir cursor após processar a página; reconstruir stdout/stderr separadamente.
7. Fechar stdin quando o protocolo do programa exigir EOF.
8. Tratar timeout/desconexão como potencial incerteza, não autorização de replay.
9. Não registrar payload fiel em logs operacionais; preservar permissões ao salvar downloads.
10. Não esperar terminal emulado nem recuperação de pipes após reinício do agente.


### Diagnósticos no cliente de referência

O cliente preserva falhas tipadas do transporte, incluindo recusas anteriores ao
envio. `ActionIoClientError.code` contém o código específico de `error.data.code`
quando disponível, seguido pelo `error.data.failure_code` canônico do agente;
`rpcCode` preserva o código do envelope JSON-RPC. `details`
expõe somente metadados selecionados: fase, origem, identificadores, estado de
entrega, bytes confirmados, efeitos possíveis e orientação de recuperação.
Mensagens nativas, payloads e campos arbitrários não são copiados para o erro.

O adaptador REST também reconhece o envelope de erro HTTP do hub. Para erros
`ACTION_*` e `OUTPUT_EXPIRED`, o hub mantém esses metadados seguros em produção,
sem depender da exposição de detalhes internos. Falhas sem confirmação continuam
incertas; uma recusa local antes do envio mantém `outcomeUnknown: false`.
Isso não adiciona reenvio automático nem confirma consumo pelo programa.

Uma chamada socket ainda aguardando disponibilidade do transporte, encerrada por
timeout, desconexão ou descarte, não foi emitida. Após emissão, essas falhas exigem
consulta/reconciliação. O cliente preserva essa distinção e não tenta novamente.

### Concurrent reference socket sends

The socket reference transport waits for the current Engine.IO transport to be
writable before its first volatile emission. This avoids dropping a concurrent
request while continuing to bypass Socket.IO ACK retries. The existing bounded
pending map and 30-second timer include this wait; the emitted timeout budget is
reduced accordingly. Disposal/disconnection clears unsent work. Nothing already
emitted is resent automatically. Socket adapters must expose the current
`io.engine.transport.writable` state, including after reconnection.

Real local Socket.IO command/relay regression tests reproduce the previous drop
and now pass with two concurrent requests and configured ACK retries. Desktop
fixture `sql-operation-bootstrap-FUadcE` also passed REST/socket/relay concurrent
same-key runs, terminal validation, content-conflict refusal and restart. This is
private fixture evidence, not production activation or full acceptance.
