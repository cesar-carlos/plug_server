import { describe, expect, it } from "vitest";

import { Agent } from "../../../../../src/domain/entities/agent.entity";
import { toClientAgentDto } from "../../../../../src/presentation/http/mappers/client_agent.mapper";

describe("toClientAgentDto", () => {
  const createdAt = new Date("2025-01-10T12:00:00.000Z");
  const updatedAt = new Date("2026-04-15T08:30:00.000Z");
  const profileUpdatedAt = new Date("2026-04-14T18:00:00.000Z");

  const baseAgent = new Agent({
    agentId: "71f895be-1234-5678-9abc-def012345678",
    name: "Loja Centro",
    tradeName: "Comércio Centro LTDA",
    document: "12345678000190",
    documentType: "cnpj",
    phone: "1133334444",
    mobile: "11999998888",
    email: "contato@exemplo.com",
    street: "Rua Exemplo",
    number: "100",
    district: "Centro",
    postalCode: "01000-000",
    city: "São Paulo",
    state: "SP",
    notes: "nota",
    profileUpdatedAt,
    profileVersion: 3,
    lastLoginUserId: undefined,
    status: "active",
    createdAt,
    updatedAt,
  });

  it("maps domain Agent and isHubConnected into the client JSON contract", () => {
    const dto = toClientAgentDto(baseAgent, true);
    expect(dto).toEqual({
      agentId: "71f895be-1234-5678-9abc-def012345678",
      name: "Loja Centro",
      tradeName: "Comércio Centro LTDA",
      document: "12345678000190",
      cnpjCpf: "12345678000190",
      documentType: "cnpj",
      phone: "1133334444",
      mobile: "11999998888",
      email: "contato@exemplo.com",
      address: {
        street: "Rua Exemplo",
        number: "100",
        district: "Centro",
        postalCode: "01000-000",
        city: "São Paulo",
        state: "SP",
      },
      notes: "nota",
      observation: "nota",
      profileUpdatedAt: "2026-04-14T18:00:00.000Z",
      profileVersion: 3,
      status: "active",
      createdAt: "2025-01-10T12:00:00.000Z",
      updatedAt: "2026-04-15T08:30:00.000Z",
      isHubConnected: true,
    });
  });

  it("reflects isHubConnected false without altering other fields", () => {
    const dto = toClientAgentDto(baseAgent, false);
    expect(dto.isHubConnected).toBe(false);
    expect(dto.agentId).toBe(baseAgent.agentId);
  });
});
