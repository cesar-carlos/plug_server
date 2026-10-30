import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPlugAgenteContractPaths } from "../helpers/plug_agente_contract";

const paths = getPlugAgenteContractPaths();
(paths ? describe : describe.skip)("agent communication documentation catalog", () => {
  it("documents mandatory faithful authorization on methods shared with legacy actions", () => {
    const document = JSON.parse(readFileSync(paths!.openRpcPath, "utf8")) as {
      methods: Array<{ name: string; description?: string }>;
    };
    for (const name of ["run", "validateRun", "getExecution", "cancel"]) {
      const method = document.methods.find((item) => item.name === `agent.action.${name}`);
      expect(method?.description, name).toContain("faithful");
      expect(method?.description, name).toContain("mandatory");
      expect(method?.description, name).toContain("local Client credential");
    }
  });
  it("lists every published RPC method in the implemented scope", () => {
    const document = JSON.parse(readFileSync(paths!.openRpcPath, "utf8")) as {
      methods: Array<{ name: string }>;
    };
    const standard = readFileSync(
      join(dirname(paths!.openRpcPath), "socket_communication_standard.md"),
      "utf8",
    );
    const scope = standard
      .split("## Escopo Atual (implementado)")[1]
      ?.split("## Status de implementacao")[0];
    expect(scope).toBeDefined();
    for (const method of document.methods)
      expect(scope, method.name).toContain(`\`${method.name}\``);
  });
});
