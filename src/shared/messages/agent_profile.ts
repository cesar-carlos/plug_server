/** User-facing and repository diagnostics for agent profile / tax document flows. */

export const AGENT_DOCUMENT_CONFLICT_DEFAULT_MESSAGE =
  "This tax document is already registered to another agent";

/** Used when normalized digits are not 11 (CPF) or 14 (CNPJ). */
export const AGENT_DOCUMENT_INVALID_LENGTH_MESSAGE =
  "Agent tax document must be a valid CPF (11 digits) or CNPJ (14 digits)";

export const AGENT_DOCUMENT_MISSING_DIGITS_MESSAGE = "Agent tax document must contain digits";
