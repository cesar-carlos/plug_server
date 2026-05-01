import { describe, expect, it } from "vitest";

import { resolveRootLandingLang } from "../../../../../src/presentation/http/helpers/root_landing";

describe("resolveRootLandingLang", () => {
  it("returns pt or en when configured fixed", () => {
    expect(resolveRootLandingLang("pt", "en-US,en;q=0.9")).toBe("pt");
    expect(resolveRootLandingLang("en", undefined)).toBe("en");
  });

  it("parses Accept-Language in auto mode", () => {
    expect(resolveRootLandingLang("auto", undefined)).toBe("pt");
    expect(resolveRootLandingLang("auto", "pt-BR,pt;q=0.9,en;q=0.8")).toBe("pt");
    expect(resolveRootLandingLang("auto", "en-US,en;q=0.9")).toBe("en");
    expect(resolveRootLandingLang("auto", "en")).toBe("en");
  });
});
