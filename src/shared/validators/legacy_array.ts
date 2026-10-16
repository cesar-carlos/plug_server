import { z } from "zod";

/**
 * Preserve public element issues for oversized arrays when using Zod 4.6.7.
 * The custom check precedes size checks, retaining element-first validation
 * without changing limits or JSON Schema. Remove only when upstream preserves
 * these issues or a versioned public error contract explicitly permits removal.
 */
export const legacyArray = <T extends z.ZodType>(element: T): z.ZodArray<T> =>
  z.array(element).check(() => undefined);
