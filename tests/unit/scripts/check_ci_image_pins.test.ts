import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.resolve(process.cwd(), "scripts/check_ci_image_pins.py");
const nodeDigest = "a".repeat(64);
const postgresDigest = "b".repeat(64);
const redisDigest = "c".repeat(64);
const postgresImage = `postgres:16-alpine@sha256:${postgresDigest}`;
const redisImage = `redis:7-alpine@sha256:${redisDigest}`;
const tempRoots: string[] = [];

const writeTree = (
  overrides: {
    nodeRef?: string;
    composePostgres?: string;
  } = {},
): string => {
  const root = mkdtempSync(path.join(tmpdir(), "image-pins-"));
  tempRoots.push(root);
  const nodeRef = overrides.nodeRef ?? `node:24.21.0-alpine@sha256:${nodeDigest}`;
  writeFileSync(path.join(root, ".nvmrc"), "24.21.0\n");
  writeFileSync(
    path.join(root, "Dockerfile"),
    `FROM ${nodeRef} AS deps\nFROM ${nodeRef} AS runtime\n`,
  );
  mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    `image: ${postgresImage}\nimage: ${redisImage}\n`,
  );
  writeFileSync(
    path.join(root, "docker-compose.yml"),
    `image: ${overrides.composePostgres ?? postgresImage}\nimage: ${redisImage}\n`,
  );
  return root;
};

const runCheck = (root?: string): { status: number | null; stderr: string } => {
  const result = spawnSync("python3", root ? [script, root] : [script], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
};

describe("check_ci_image_pins", () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("should accept matching Node, Postgres, and Redis pins", () => {
    const result = runCheck(writeTree());

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("should reject a Node image that does not match .nvmrc", () => {
    const result = runCheck(writeTree({ nodeRef: "node:26-alpine" }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be node:24.21.0-alpine@sha256:");
  });

  it("should reject a Compose digest that differs from CI", () => {
    const result = runCheck(
      writeTree({
        composePostgres: `postgres:16-alpine@sha256:${"d".repeat(64)}`,
      }),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("postgres image pin differs");
  });

  it("should accept the repository image pins", () => {
    const result = runCheck();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
