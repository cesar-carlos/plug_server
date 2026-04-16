import { describe, expect, it } from "vitest";

import {
  assertSubmittedAgentProfileDocumentValid,
  MAX_AGENT_DOCUMENT_STORED_LENGTH,
  normalizeAgentDocumentForStorage,
  validateAgentDocumentChecksumForSubmittedValue,
} from "../../../src/shared/utils/agent_document_normalize";
import { AGENT_DOCUMENT_INVALID_LENGTH_MESSAGE } from "../../../src/shared/messages/agent_profile";

describe("normalizeAgentDocumentForStorage", () => {
  it("strips punctuation and keeps digits", () => {
    expect(normalizeAgentDocumentForStorage("529.982.247-25")).toBe("52998224725");
    expect(normalizeAgentDocumentForStorage("11.222.333/0001-81")).toBe("11222333000181");
  });

  it("returns undefined when there are no digits", () => {
    expect(normalizeAgentDocumentForStorage("...")).toBeUndefined();
    expect(normalizeAgentDocumentForStorage("")).toBeUndefined();
  });

  it("truncates to max stored length", () => {
    const long = "1".repeat(MAX_AGENT_DOCUMENT_STORED_LENGTH + 5);
    expect(normalizeAgentDocumentForStorage(long)?.length).toBe(MAX_AGENT_DOCUMENT_STORED_LENGTH);
  });
});

describe("validateAgentDocumentChecksumForSubmittedValue", () => {
  it("accepts valid CPF and CNPJ digits", () => {
    expect(() => validateAgentDocumentChecksumForSubmittedValue("52998224725")).not.toThrow();
    expect(() => validateAgentDocumentChecksumForSubmittedValue("11222333000181")).not.toThrow();
  });

  it("rejects wrong length", () => {
    expect(() => validateAgentDocumentChecksumForSubmittedValue("12345")).toThrow(
      AGENT_DOCUMENT_INVALID_LENGTH_MESSAGE,
    );
  });

  it("rejects invalid checksum", () => {
    expect(() => validateAgentDocumentChecksumForSubmittedValue("11222333000182")).toThrow(
      "Invalid CNPJ",
    );
  });
});

describe("assertSubmittedAgentProfileDocumentValid", () => {
  it("no-ops for undefined, null, and whitespace-only", () => {
    expect(() => assertSubmittedAgentProfileDocumentValid(undefined)).not.toThrow();
    expect(() => assertSubmittedAgentProfileDocumentValid(null)).not.toThrow();
    expect(() => assertSubmittedAgentProfileDocumentValid("   ")).not.toThrow();
  });

  it("validates formatted input", () => {
    expect(() => assertSubmittedAgentProfileDocumentValid("11.222.333/0001-81")).not.toThrow();
  });
});
