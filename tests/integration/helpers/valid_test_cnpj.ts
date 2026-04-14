import { appendCnpjCheckDigits } from "../../../src/shared/utils/cnpj_cpf";

let seq = 0;

/** Distinct valid CNPJs for integration tests (sequential roots in one process). */
export function nextValidTestCnpj(): string {
  seq += 1;
  const twelve = `11222333${String(seq % 10000).padStart(4, "0")}`;
  return appendCnpjCheckDigits(twelve);
}
