# Runbook: rotacao de chave HMAC do PayloadFrame

Este runbook cobre rotacao operacional de `PayloadFrame.signature` sem mudar o
wire protocol. A chave ativa continua vindo de `PAYLOAD_SIGNING_KEY` e
`PAYLOAD_SIGNING_KEY_ID`; chaves antigas ficam apenas para verificacao inbound
em `PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON`.

## Pre-check

- Confirmar que todos os agentes que assinam frames enviam `signature.key_id`.
- Confirmar que `GET /metrics` expoe:
  - `plug_payload_frame_signature_accepted_total`
  - `plug_payload_frame_signature_rejected_total`
- Confirmar que nao ha alerta ativo para assinatura rejeitada:

```promql
rate(plug_payload_frame_signature_rejected_total[5m]) > 0
```

## Passo 1: preparar keyring de verificacao

No hub, mover a chave ativa atual para o JSON de chaves anteriores e configurar
a nova chave como ativa de saida:

```env
PAYLOAD_SIGNING_KEY_ID=hub-2026-q3
PAYLOAD_SIGNING_KEY=<new-secret>
PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON={"hub-2026-q2":"<old-secret>"}
```

Reiniciar/rollout do hub. A partir daqui:

- frames outbound do hub sao assinados com `hub-2026-q3`;
- frames inbound assinados com `hub-2026-q2` ou `hub-2026-q3` sao aceitos;
- frames assinados sem `signature.key_id` falham porque a keyring esta ativa.

## Passo 2: observar rollout

Durante a janela de migracao, acompanhar:

```promql
rate(plug_payload_frame_signature_accepted_total{key_kind="active"}[5m])
rate(plug_payload_frame_signature_accepted_total{key_kind="previous"}[5m])
rate(plug_payload_frame_signature_rejected_total[5m])
```

Se `signature_rejected` subir, verificar os logs `rpc_frame_decode_failed` e
validar se o agente esta usando `key_id` conhecido. Nao registrar nem colar
segredos em tickets ou logs.

## Passo 3: remover chave antiga

Quando `key_kind="previous"` ficar zerado por uma janela operacional segura
(por exemplo, 24h ou o ciclo completo de atualizacao do agente), remover a chave
antiga:

```env
PAYLOAD_SIGNING_KEY_ID=hub-2026-q3
PAYLOAD_SIGNING_KEY=<new-secret>
PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON={}
```

Depois do rollout, confirmar que:

- `plug_payload_frame_signature_accepted_total{key_kind="active"}` continua subindo;
- `plug_payload_frame_signature_accepted_total{key_kind="previous"}` nao sobe;
- `plug_payload_frame_signature_rejected_total` permanece zerado ou dentro do baseline esperado.

## Rollback

Se a nova chave causar falhas, voltar temporariamente a chave antiga como ativa
e manter a chave nova em `PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON` apenas se houver
agentes que ja tenham migrado:

```env
PAYLOAD_SIGNING_KEY_ID=hub-2026-q2
PAYLOAD_SIGNING_KEY=<old-secret>
PAYLOAD_SIGNING_PREVIOUS_KEYS_JSON={"hub-2026-q3":"<new-secret>"}
```

Investigar o `key_id` enviado pelos agentes e repetir o rollout quando o
contrato estiver consistente.
