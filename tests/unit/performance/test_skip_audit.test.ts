import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each([
  ["tests/integration/desktop_bootstrap.integration.test.ts", "pending", 0],
  ["tests/unit/new_feature.test.ts", "pending", 1],
  ["tests/integration/desktop_bootstrap.integration.test.ts", "todo", 1],
])("audits %s with status %s", (name, status, expected) => {
  const directory = mkdtempSync(join(tmpdir(), "test-skip-audit-"));
  try {
    const file = join(directory, "results.json");
    writeFileSync(
      file,
      JSON.stringify({
        testResults: [{ name, assertionResults: [{ fullName: "example", status }] }],
      }),
    );
    const result = spawnSync(process.execPath, [resolve("scripts/check-test-skips.mjs"), file], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(expected);
    if (expected === 0) expect(result.stdout).toContain("Native agent fixtures (Windows)");
    else expect(result.stderr).toContain("no execution owner");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
