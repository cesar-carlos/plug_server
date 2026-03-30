/**
 * REST-only: credit window for materializing plug_agente `sql.execute` streams
 * (rpc:stream.pull + rpc:chunk + rpc:complete) into a single HTTP response.
 * Keeps state out of `rpc_bridge.ts` as the first slice of modularization.
 */

export const REST_STREAM_AGGREGATE_CONSUMER_ID = "__plug_rest_sql_stream_aggregate__";

const creditsByRequestId = new Map<string, number>();

/**
 * Pure step: decrement one chunk credit; when exhausted, next stored value is a full window after pull.
 */
export const stepRestSqlStreamMaterializeCredits = (
  storedCredits: number | undefined,
  windowSize: number,
): { nextStoredCredits: number; shouldEmitPull: boolean } => {
  let c = storedCredits ?? 0;
  c -= 1;
  if (c <= 0) {
    return { nextStoredCredits: windowSize, shouldEmitPull: true };
  }
  return { nextStoredCredits: c, shouldEmitPull: false };
};

export const restSqlStreamMaterializeSeedCredits = (
  requestId: string,
  windowSize: number,
): void => {
  creditsByRequestId.set(requestId, windowSize);
};

export const restSqlStreamMaterializeConsumeChunk = (
  requestId: string,
  windowSize: number,
  emitPull: () => void,
): void => {
  const { nextStoredCredits, shouldEmitPull } = stepRestSqlStreamMaterializeCredits(
    creditsByRequestId.get(requestId),
    windowSize,
  );
  if (shouldEmitPull) {
    emitPull();
  }
  creditsByRequestId.set(requestId, nextStoredCredits);
};

export const restSqlStreamMaterializeClearRequest = (requestId: string): void => {
  creditsByRequestId.delete(requestId);
};

export const restSqlStreamMaterializeReset = (): void => {
  creditsByRequestId.clear();
};
