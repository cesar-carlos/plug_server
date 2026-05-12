import { randomInt } from "node:crypto";

import { appendCnpjCheckDigits } from "../../../src/shared/utils/cnpj_cpf";

/**
 * Distinct valid CNPJs for integration tests.
 * Uses a random 12-digit root + Mod-11 check digits so parallel Vitest workers
 * do not collide on the same sequential suffix (shared DB unique constraints).
 */
export function nextValidTestCnpj(): string {
  const twelve = String(randomInt(100_000_000_000, 1_000_000_000_000));
  return appendCnpjCheckDigits(twelve);
}
