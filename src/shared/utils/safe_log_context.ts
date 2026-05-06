type JsonLike =
  | null
  | boolean
  | number
  | string
  | JsonLike[]
  | { readonly [key: string]: JsonLike };

const normalizePrimitive = (value: unknown): JsonLike => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (value === undefined) {
    return null;
  }
  return String(value);
};

const visit = (value: unknown, seen: WeakSet<object>, depth: number): JsonLike => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Date ||
    value instanceof Error ||
    value === undefined
  ) {
    return normalizePrimitive(value);
  }

  if (depth <= 0) {
    return "[max-depth]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => visit(item, seen, depth - 1));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        visit(nested, seen, depth - 1),
      ]),
    );
  }

  return normalizePrimitive(value);
};

export const toSafeLogContext = (
  context: Record<string, unknown>,
  options?: { readonly depth?: number },
): Record<string, JsonLike> => {
  const depth = Math.max(1, options?.depth ?? 4);
  const seen = new WeakSet<object>();
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [key, visit(value, seen, depth)]),
  );
};
