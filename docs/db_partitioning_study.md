# Estudo: particionamento por tempo de `audit_events` e `bridge_latency_traces`

> **Status**: análise / não implementado.
> **Escopo**: planejamento e custos de migrar duas tabelas append-heavy do
> `plug_server` para particionamento por range em `created_at`.

## 1. Motivação

As tabelas `audit_events` e `bridge_latency_traces` são append-heavy (escritas
contínuas via `socket_audit.service.ts` / `bridge_latency_trace.service.ts`,
batches de até 48 linhas a cada 200ms) e mantidas por **90 dias**
(`SOCKET_AUDIT_RETENTION_DAYS=90`, `BRIDGE_LATENCY_TRACE_RETENTION_DAYS=90`).
A retenção atual usa `DELETE ... WHERE created_at < cutoff ORDER BY created_at LIMIT batch`
em loop ([`socket_audit.service.ts:298-321`](../src/application/services/socket_audit.service.ts),
[`bridge_latency_trace.service.ts:322-346`](../src/application/services/bridge_latency_trace.service.ts)).

Problemas observados quando essas tabelas crescem para dezenas de milhões de linhas:

| Problema | Causa | Impacto |
| --- | --- | --- |
| Prune custoso | `DELETE` em batches percorre índice + tuplas mortas; vacuum precisa rodar para liberar espaço | I/O sustentado, bloat, autovacuum sob pressão |
| Índices secundários inflados | 4–6 BTREEs em `audit_events`, 4 em `bridge_latency_traces`; cada INSERT atualiza todos | latência de escrita cresce com o tamanho dos índices |
| Sem partition pruning em consultas por janela | Todo SELECT por janela curta (ex. dashboards Grafana) varre toda a tabela ou escana o índice `created_at` | latência de leitura piora com o tempo |
| Pico de WAL | bulk INSERT (entregue em F3.2) ainda gera WAL de tamanho proporcional aos índices | replicação lag ocasional |

## 2. Particionamento por `created_at` (range, mensal)

### 2.1 Forma proposta

```sql
CREATE TABLE audit_events_partitioned (
  -- mesma definição de colunas
) PARTITION BY RANGE (created_at);

-- Partições mensais
CREATE TABLE audit_events_2026_04 PARTITION OF audit_events_partitioned
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
-- ... uma por mês
```

Granularidade mensal vs semanal:
- **Mensal**: 3 partições "vivas" por mês (mês corrente + 2 retenção). Menor
  contagem de partições, planner mais leve. Preferido para 90d retention.
- **Semanal**: 13 partições vivas (12 retenção + 1 corrente). Mais granular
  para drops de retenção, mas planner faz mais trabalho.

### 2.2 Ganhos esperados

1. **Prune O(1) via `DROP PARTITION`**: substitui o loop de `DELETE LIMIT` por
   um único comando que libera espaço imediatamente. Sem bloat residual.
2. **Índices menores por partição**: Postgres mantém um BTREE por partição;
   cada um cobre apenas ~30 dias de dados. Melhor cache hit, INSERT mais rápido.
3. **Partition pruning em SELECTs por `created_at`**: o planner descarta
   partições fora da janela. Dashboards "últimas 24h" consultam só 1 partição.
4. **Vacuum mais barato**: rodado por partição, em paralelo. Autovacuum não
   fica preso na partição inteira.

### 2.3 Custos / desafios

| Item | Custo |
| --- | --- |
| Migração inicial | tabela existe → precisa swap atômico ou dual-write |
| Manutenção | criar partição mensal antes do mês começar (idealmente automatizado via `pg_partman` ou job próprio) |
| Constraints únicas | UNIQUE precisa incluir a chave de partição (`(id, created_at)` em vez de só `id`) — para `audit_events.id` isso muda o PK |
| Foreign keys apontando para a tabela | Postgres ≤16 só permite FK *para* tabela particionada se chave de partição estiver no FK. Nem `audit_events` nem `bridge_latency_traces` são alvos de FK, então OK aqui |
| Joins | nenhum join estrutural com outras tabelas (são tabelas finais), OK |
| Prepared statements | Postgres pode resetar plans cacheados; latência inicial pós-deploy |

### 2.4 Plano de migração zero-downtime

#### Opção A — `pg_partman` (preferido se a infra já roda extensão)

```sql
CREATE EXTENSION IF NOT EXISTS pg_partman;
SELECT partman.create_parent(
  p_parent_table := 'public.audit_events',
  p_control      := 'created_at',
  p_type         := 'range',
  p_interval     := '1 month',
  p_premake      := 2
);
```

- `pg_partman` detecta tabela existente e converte (precisa janela de manutenção
  curta para o ATTACH).
- Job `partman.run_maintenance_proc()` cria partições futuras e dropa antigas
  conforme retenção configurada.

#### Opção B — Particionamento nativo Postgres + dual-write

1. **Migration 1**: criar `audit_events_v2` particionada vazia, com mesma
   estrutura + PK `(id, created_at)`.
2. **Migration 2 (deploy app)**: ativar dual-write — INSERT em ambas as
   tabelas, leituras continuam na original. Job de backfill copia partições
   por dia.
3. **Migration 3**: cortar leituras para `audit_events_v2`. Drop da original.
4. **Migration 4**: renomear `audit_events_v2` → `audit_events`.

Tempo total estimado: 2–3 sprints, com janelas de validação.

### 2.5 Job de manutenção de partições

Sem `pg_partman`, criar serviço `partition_maintenance.service.ts` que:

```sql
-- Mensalmente, sob advisory lock:
CREATE TABLE IF NOT EXISTS audit_events_YYYY_MM
  PARTITION OF audit_events
  FOR VALUES FROM (...) TO (...);

-- Após cutoff de retenção:
DROP TABLE IF EXISTS audit_events_YYYY_MM_old;
```

Reutilizar `runWithAdvisoryLock` (ver `infrastructure/database/advisory_lock.ts`)
para coordenação multi-réplica.

## 3. Alternativa intermediária: BRIN

Antes de partitioning completo, considerar **BRIN** (Block Range Index) em
`created_at`:

```sql
CREATE INDEX audit_events_created_at_brin
  ON audit_events USING BRIN (created_at)
  WITH (pages_per_range = 32);
DROP INDEX audit_events_created_at_idx;
```

- BRIN é ~1000× menor que BTREE para colunas monotonicamente crescentes.
- Suficiente para queries por janela "WHERE created_at > X" típicas.
- Não acelera ORDER BY tanto quanto BTREE; manter BTREE em `(conversation_id, created_at)` etc.
- **Trade-off**: prune ainda usa DELETE em loop (não é partition drop).

BRIN é um passo intermediário de baixo risco — recomendar antes do
partitioning pleno.

## 4. Volumetria atual estimada

> Atualizar com `SELECT pg_total_relation_size('audit_events')` em produção.
> Métricas-base estimadas a partir do tráfego documentado em
> [`docs/load_testing.md`](./load_testing.md):

| Tabela | INSERT/s estimado (prod) | Linhas/dia | Tamanho/90 dias |
| --- | --- | --- | --- |
| `audit_events` | 50/s sustentado, 250/s pico | 4.3M | ~50 GB com índices |
| `bridge_latency_traces` | 10/s (sample 100%) ou 2.5/s (sample 25%) | 850k–215k | 5–20 GB com índices |

Quando volumetria real for medida, atualizar esta tabela e o tamanho
das partições propostas.

## 5. Recomendação

| Etapa | Prioridade | Esforço |
| --- | --- | --- |
| Medir volumetria real (`pg_total_relation_size`, `pg_stat_user_tables.n_live_tup`) | **Imediata** | 1h |
| BRIN em `audit_events.created_at` | Alta | 1 sprint (migration + bench) |
| BRIN em `bridge_latency_traces.created_at` | Média | 1 sprint |
| Partitioning mensal de `audit_events` (Opção A) | Média | 1–2 sprints com janela |
| Partitioning mensal de `bridge_latency_traces` | Baixa (volume menor) | 1–2 sprints com janela |
| Job de manutenção sob advisory lock | Acompanha cada partitioning | incluído no esforço |

## 6. Decisão pendente

Antes de implementar, validar:

1. Volumetria real está dentro das estimativas? (nada mudou se BRIN sozinho resolve)
2. Versão de Postgres em prod suporta `REFRESH MATERIALIZED VIEW CONCURRENTLY` (≥9.4 — OK) e `CREATE TABLE ... PARTITION BY` (≥10 — OK)?
3. `pg_partman` está disponível? (define se Opção A é viável)
4. Janela de manutenção aceitável para o swap atômico (Opção B)?

## 7. Referências cruzadas

- `docs/configuration.md` — envs `SOCKET_AUDIT_*`, `BRIDGE_LATENCY_TRACE_*`.
- `docs/observability.md` — métricas atuais de prune (`socket_audit_pruned`, `bridge_latency_traces_pruned`).
- `src/application/services/socket_audit.service.ts` — `pruneSocketAuditOlderThanDays`.
- `src/application/services/bridge_latency_trace.service.ts` — `pruneBridgeLatencyTracesOlderThanDays`.
- `src/infrastructure/database/advisory_lock.ts` — coordenação multi-réplica.
