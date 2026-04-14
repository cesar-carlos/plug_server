import {
  AGENT_DOCUMENT_INVALID_LENGTH_MESSAGE,
  AGENT_DOCUMENT_MISSING_DIGITS_MESSAGE,
} from "../messages/agent_profile";
import { badRequest } from "../errors/http_errors";
import { isValidCnpj, isValidCpf, normalizeCnpjCpf } from "./cnpj_cpf";

/** Matches `Agent.document` column `VarChar(20)`; CPF/CNPJ digits fit within this. */
export const MAX_AGENT_DOCUMENT_STORED_LENGTH = 20;

/**
 * Canonical form for persisted agent tax documents (CPF/CNPJ): digits only, max DB length.
 * Uses {@link normalizeCnpjCpf} so formatting rules stay aligned with validation.
 * Returns `undefined` when there are no digits (clears invalid or punctuation-only input).
 */
export function normalizeAgentDocumentForStorage(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const digits = normalizeCnpjCpf(raw);
  if (digits.length === 0) {
    return undefined;
  }
  return digits.slice(0, MAX_AGENT_DOCUMENT_STORED_LENGTH);
}

/**
 * Validates checksum when the client submitted a non-null document value.
 * Call after {@link normalizeAgentDocumentForStorage} produced a defined string.
 */
export function validateAgentDocumentChecksumForSubmittedValue(normalizedDigits: string): void {
  const len = normalizedDigits.length;
  if (len === 11) {
    if (!isValidCpf(normalizedDigits)) {
      throw badRequest("Invalid CPF");
    }
    return;
  }
  if (len === 14) {
    if (!isValidCnpj(normalizedDigits)) {
      throw badRequest("Invalid CNPJ");
    }
    return;
  }
  throw badRequest(AGENT_DOCUMENT_INVALID_LENGTH_MESSAGE);
}

/**
 * Validates a submitted profile document field (non-null). Empty / whitespace clears without error.
 */
export function assertSubmittedAgentProfileDocumentValid(raw: string | null | undefined): void {
  if (raw === undefined || raw === null) {
    return;
  }
  if (raw.trim() === "") {
    return;
  }
  const normalized = normalizeAgentDocumentForStorage(raw);
  if (normalized === undefined) {
    throw badRequest(AGENT_DOCUMENT_MISSING_DIGITS_MESSAGE);
  }
  validateAgentDocumentChecksumForSubmittedValue(normalized);
}
