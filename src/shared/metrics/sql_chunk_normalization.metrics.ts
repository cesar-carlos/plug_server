let frames = 0;
let receivedBytes = 0;
let normalizedBytes = 0;
let failures = 0;

export const noteSqlChunkNormalization = (received: number, normalized: number): void => {
  frames++;
  receivedBytes += received;
  normalizedBytes += normalized;
};
export const noteSqlChunkNormalizationFailure = (): void => {
  failures++;
};
export const getSqlChunkNormalizationDiagnostics = (): Readonly<Record<string, number>> => ({
  frames,
  receivedBytes,
  normalizedBytes,
  failures,
});
export const buildSqlChunkNormalizationMetricsLines = (): readonly string[] =>
  Object.entries({
    frames,
    received_bytes: receivedBytes,
    normalized_bytes: normalizedBytes,
    failures,
  }).flatMap(([name, value]) => [
    `# TYPE plug_sql_chunk_normalization_${name}_total counter`,
    `plug_sql_chunk_normalization_${name}_total ${value}`,
  ]);
