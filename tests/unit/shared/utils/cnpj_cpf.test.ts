import { describe, it, expect } from "vitest";
import {
  normalizeCnpjCpf,
  isValidCpf,
  isValidCnpj,
  validateCnpjCpf,
} from "../../../../src/shared/utils/cnpj_cpf";

describe("normalizeCnpjCpf", () => {
  it("strips dots, slashes and dashes from CPF", () => {
    expect(normalizeCnpjCpf("529.982.247-25")).toBe("52998224725");
  });

  it("strips dots, slashes and dashes from CNPJ", () => {
    expect(normalizeCnpjCpf("11.222.333/0001-81")).toBe("11222333000181");
  });

  it("returns already-normalized string unchanged", () => {
    expect(normalizeCnpjCpf("52998224725")).toBe("52998224725");
  });
});

describe("isValidCpf", () => {
  it("accepts a valid CPF", () => {
    expect(isValidCpf("52998224725")).toBe(true);
  });

  it("rejects a CPF with all equal digits", () => {
    expect(isValidCpf("11111111111")).toBe(false);
  });

  it("rejects a CPF with wrong check digits", () => {
    expect(isValidCpf("52998224726")).toBe(false);
  });

  it("rejects a CPF shorter than 11 digits", () => {
    expect(isValidCpf("5299822472")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidCpf("")).toBe(false);
  });
});

describe("isValidCnpj", () => {
  it("accepts a valid CNPJ", () => {
    expect(isValidCnpj("11222333000181")).toBe(true);
  });

  it("rejects a CNPJ with all equal digits", () => {
    expect(isValidCnpj("00000000000000")).toBe(false);
  });

  it("rejects a CNPJ with wrong check digits", () => {
    expect(isValidCnpj("11222333000182")).toBe(false);
  });

  it("rejects a CNPJ shorter than 14 digits", () => {
    expect(isValidCnpj("1122233300018")).toBe(false);
  });
});

describe("validateCnpjCpf", () => {
  it("returns normalized digits for a valid formatted CPF", () => {
    const result = validateCnpjCpf("529.982.247-25");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("52998224725");
  });

  it("returns normalized digits for a valid formatted CNPJ", () => {
    const result = validateCnpjCpf("11.222.333/0001-81");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("11222333000181");
  });

  it("returns error for an invalid CPF", () => {
    const result = validateCnpjCpf("000.000.000-00");
    expect(result.ok).toBe(false);
  });

  it("returns error for an invalid CNPJ", () => {
    const result = validateCnpjCpf("11.222.333/0001-99");
    expect(result.ok).toBe(false);
  });

  it("returns error for wrong digit count", () => {
    const result = validateCnpjCpf("123456");
    expect(result.ok).toBe(false);
  });

  it("accepts valid raw digits for CPF", () => {
    const result = validateCnpjCpf("52998224725");
    expect(result.ok).toBe(true);
  });

  it("accepts valid raw digits for CNPJ", () => {
    const result = validateCnpjCpf("11222333000181");
    expect(result.ok).toBe(true);
  });
});
