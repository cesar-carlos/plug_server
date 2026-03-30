import { type Result, ok, err } from "../errors/result";
import { badRequest } from "../errors/http_errors";

export const normalizeCnpjCpf = (raw: string): string => raw.replace(/\D/g, "");

export const isValidCpf = (digits: string): boolean => {
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  const calcDigit = (slice: string, weights: number[]): number => {
    const sum = slice.split("").reduce((acc, d, i) => acc + Number(d) * weights[i]!, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const d1 = calcDigit(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d1 !== Number(digits[9])) return false;

  const d2 = calcDigit(digits.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d2 === Number(digits[10]);
};

export const isValidCnpj = (digits: string): boolean => {
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;

  const calcDigit = (slice: string, weights: number[]): number => {
    const sum = slice.split("").reduce((acc, d, i) => acc + Number(d) * weights[i]!, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const d1 = calcDigit(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d1 !== Number(digits[12])) return false;

  const d2 = calcDigit(digits.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d2 === Number(digits[13]);
};

/**
 * Validates a CPF or CNPJ string (with or without formatting).
 * Returns the normalized digits-only string on success, or an error.
 */
export const validateCnpjCpf = (raw: string): Result<string> => {
  const digits = normalizeCnpjCpf(raw);

  if (digits.length === 11) {
    if (!isValidCpf(digits)) {
      return err(badRequest("Invalid CPF"));
    }
    return ok(digits);
  }

  if (digits.length === 14) {
    if (!isValidCnpj(digits)) {
      return err(badRequest("Invalid CNPJ"));
    }
    return ok(digits);
  }

  return err(badRequest("CPF must have 11 digits and CNPJ must have 14 digits"));
};
