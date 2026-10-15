/** Internal JSON wire inspection shared by validation and normalization. */
interface SqlColumn {
  readonly name: string;
  readonly values: readonly unknown[];
}

export type SqlChunkInspection =
  | { readonly ok: true; readonly rowCount: number; readonly columns?: readonly SqlColumn[] }
  | { readonly ok: false; readonly message: string };

export type ValidSqlChunkInspection = Extract<SqlChunkInspection, { readonly ok: true }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Row maps take precedence; the optional columnar copy must never duplicate rows. */
export const inspectSqlStreamChunk = (chunk: Record<string, unknown>): SqlChunkInspection => {
  if (!Array.isArray(chunk.rows)) return { ok: false, message: "rpc:chunk rows must be an array" };
  if (chunk.rows.length > 0 || chunk.columnar === undefined) {
    return { ok: true, rowCount: chunk.rows.length };
  }
  if (!isRecord(chunk.columnar))
    return { ok: false, message: "rpc:chunk columnar must be an object" };
  const { row_count: count, columns } = chunk.columnar;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    !Array.isArray(columns)
  ) {
    return { ok: false, message: "rpc:chunk columnar row_count and columns are invalid" };
  }
  const selected = new Map<string, SqlColumn>();
  for (const column of columns) {
    if (
      !isRecord(column) ||
      typeof column.name !== "string" ||
      !["int32", "int64", "float64", "object"].includes(String(column.type)) ||
      !Array.isArray(column.values) ||
      column.values.length !== count
    ) {
      return { ok: false, message: "rpc:chunk columnar vector is invalid" };
    }
    selected.set(column.name, { name: column.name, values: column.values });
  }
  return { ok: true, rowCount: count, columns: [...selected.values()] };
};

export const countSqlChunkRows = (chunk: Record<string, unknown>): number => {
  if (Array.isArray(chunk.rows) && (chunk.rows.length > 0 || chunk.columnar === undefined))
    return chunk.rows.length;
  const result = inspectSqlStreamChunk(chunk);
  return result.ok ? result.rowCount : 0;
};

export const readSqlChunkRows = (chunk: Record<string, unknown>): readonly unknown[] => {
  if (chunk.columnar === undefined) return Array.isArray(chunk.rows) ? chunk.rows : [];
  const result = inspectSqlStreamChunk(chunk);
  if (!result.ok) throw new Error(result.message);
  if (result.columns === undefined) return chunk.rows as readonly unknown[];
  return expandInspectedSqlChunkRows(result);
};

/** The caller owns this inspection for the same unmodified, decoded chunk. */
export const expandInspectedSqlChunkRows = (
  result: ValidSqlChunkInspection,
): readonly Record<string, unknown>[] => {
  const columns = result.columns ?? [];
  const defineOwn = columns.map((column) => column.name in Object.prototype);
  const rows: Record<string, unknown>[] = new Array(result.rowCount);
  for (let index = 0; index < rows.length; index++) {
    const row: Record<string, unknown> = {};
    for (let c = 0; c < columns.length; c++) {
      const column = columns[c]!;
      if (defineOwn[c]) {
        // Preserve own data properties even for __proto__ and inherited names.
        Object.defineProperty(row, column.name, {
          value: column.values[index],
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else {
        row[column.name] = column.values[index];
      }
    }
    rows[index] = row;
  }
  return rows;
};
