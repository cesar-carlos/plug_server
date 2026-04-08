import { describe, expect, it } from "vitest";

import { Agent } from "../../../../src/domain/entities/agent.entity";
import { agentsProfileCatalogContentEqual } from "../../../../src/application/services/agent_profile_catalog_compare";

describe("agentsProfileCatalogContentEqual", () => {
  const base = (): Agent =>
    Agent.create({
      agentId: "a1",
      name: "Acme",
      tradeName: "Acme LTDA",
      document: "123",
      documentType: "cnpj",
      phone: "11",
      mobile: "22",
      email: "a@b.c",
      address: { street: "Rua 1", city: "SP" },
      notes: "n",
      profileVersion: 1,
    });

  it("returns true for identical agents", () => {
    const a = base();
    const b = base();
    expect(agentsProfileCatalogContentEqual(a, b)).toBe(true);
  });

  it("treats empty string optional fields like undefined", () => {
    const a = Agent.create({ agentId: "a1", name: "Acme", profileVersion: 1 });
    const b = a.update({ tradeName: "" });
    expect(agentsProfileCatalogContentEqual(a, b)).toBe(true);
  });

  it("returns false when a catalog field differs", () => {
    const a = base();
    const b = a.update({ name: "Other" });
    expect(agentsProfileCatalogContentEqual(a, b)).toBe(false);
  });
});
