import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.env.PLUG_AGENTE_ROOT?.trim();
const openRpcPath =
  root !== undefined && root.length > 0
    ? join(root, "docs", "communication", "openrpc.json")
    : "";

const shouldRun = openRpcPath.length > 0 && existsSync(openRpcPath);

const contractDescribe = shouldRun ? describe : describe.skip;

contractDescribe("plug_agente OpenRPC (set PLUG_AGENTE_ROOT to enable)", () => {
  it("lists core SQL / RPC methods", () => {
    const raw = readFileSync(openRpcPath, "utf8");
    const doc = JSON.parse(raw) as { methods?: { name: string }[] };
    const names = new Set((doc.methods ?? []).map((m) => m.name));
    expect(names.has("sql.execute")).toBe(true);
    expect(names.has("sql.executeBatch")).toBe(true);
    expect(names.has("sql.cancel")).toBe(true);
    expect(names.has("rpc.discover")).toBe(true);
  });
});
