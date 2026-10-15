import { expect, it } from "vitest";
import { buildSwaggerSpec } from "../../src/presentation/docs/swagger";

it("should advertise only optional negotiated structural capabilities in the actual OpenAPI", () => {
  const raw = buildSwaggerSpec().spec as {
    components: {
      schemas: Record<string, { required: string[]; properties: Record<string, unknown> }>;
    };
  };
  const schema = raw.components.schemas.ClientAccessibleAgent!;
  for (const name of ["sourceIdentity", "sourceSchema", "sourceConstraints"]) {
    expect(schema.properties[name]).toMatchObject({ type: "integer", enum: [1], nullable: true });
    expect(schema.required).not.toContain(name);
  }
  expect(schema.properties.sqlOperations).toMatchObject({
    nullable: true,
    properties: { structureGuard: { type: "integer", enum: [1] } },
  });
  expect(schema.required).toContain("hasClientToken");
  expect(schema.required).toContain("isHubConnected");
});
