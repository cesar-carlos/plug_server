import type { Request } from "express";
import { describe, expect, it } from "vitest";

import { negotiateApprovalHtmlLang } from "../../../src/presentation/http/helpers/approval_page_locale";

const mockRequest = (acceptLanguage?: string): Request =>
  ({
    get: (name: string): string | undefined => {
      if (name.toLowerCase() === "accept-language") {
        return acceptLanguage;
      }
      return undefined;
    },
  }) as unknown as Request;

describe("negotiateApprovalHtmlLang", () => {
  it("defaults to English when header is absent", () => {
    expect(negotiateApprovalHtmlLang(mockRequest())).toBe("en");
  });

  it("prefers Portuguese when pt appears before en", () => {
    expect(negotiateApprovalHtmlLang(mockRequest("pt-BR,en;q=0.9"))).toBe("pt-BR");
    expect(negotiateApprovalHtmlLang(mockRequest("pt,en-US"))).toBe("pt-BR");
  });

  it("prefers English when en is listed before pt", () => {
    expect(negotiateApprovalHtmlLang(mockRequest("en-US,pt;q=0.8"))).toBe("en");
  });
});
