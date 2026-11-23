import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Prisma config dependency compatibility", () => {
  const requireHere = createRequire(resolve("package.json"));
  const requirePrisma = createRequire(requireHere.resolve("@prisma/config"));

  it("rejects ambiguous template literal input without unbounded regex backtracking", () => {
    // Run in a killable child: the affected dependency blocks the event loop.
    const result = execFileSync(
      process.execPath,
      [
        resolve("tests/fixtures/security/effect-template-literal.cjs"),
        requirePrisma.resolve("effect"),
      ],
      { timeout: 5_000, encoding: "utf8" },
    );
    expect(result).toBe("MATCHING_COMPLETED");
  });
});
