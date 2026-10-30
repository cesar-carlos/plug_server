import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function validateChangelog(text, version, release = false) {
  const chunks = text.split(/^## /m).slice(1);
  if (!chunks.length || !/^\[?Unreleased\]?\r?\n/.test(chunks[0]))
    throw new Error("CHANGELOG must start with Unreleased");
  const pending = chunks[0].split(/\r?\n/).slice(1).join("\n");
  const entries = new Map();
  let previous;
  let previousDay;
  for (const chunk of chunks.slice(1)) {
    const [heading] = chunk.split(/\r?\n/);
    const match = /^\[?(\d+\.\d+\.\d+)\]? - (\d{4}-\d{2}-\d{2})$/.exec(heading);
    if (!match) throw new Error(`Invalid CHANGELOG heading: ${heading}`);
    const [, number, day] = match;
    if (!Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)
      throw new Error("Invalid release date");
    if (previousDay && day > previousDay) throw new Error("Dates must be descending");
    previousDay = day;
    const key = number.split(".").map(Number);
    if (
      entries.has(number) ||
      (previous &&
        !key.some((v, i) => v < previous[i] && key.slice(0, i).every((n, j) => n === previous[j])))
    )
      throw new Error("Versions must be unique and descending");
    previous = key;
    if (!/^Status: (baseline|local|tagged|prepared)\r?$/m.test(chunk))
      throw new Error("Missing release status");
    if (!chunk.split(/\r?\n/).includes(`Build: ${number}`))
      throw new Error("Build/version mismatch");
    if (!/^- \S/m.test(chunk)) throw new Error("Missing change notes");
    entries.set(number, chunk);
  }
  if (entries.keys().next().value !== version) throw new Error("Current version must be latest");
  const entry = entries.get(version);
  if (!entry) throw new Error(`Missing CHANGELOG entry for ${version}`);
  if (
    release &&
    (!/^Status: prepared\r?$/m.test(entry) || pending.replace(/^### .*$/gm, "").trim())
  )
    throw new Error("Release requires prepared notes and no pending Unreleased changes");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  try {
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
    if (pkg.version !== lock.version || pkg.version !== lock.packages[""].version)
      throw new Error("Package/lock version mismatch");
    validateChangelog(
      readFileSync(new URL("CHANGELOG.md", root), "utf8"),
      pkg.version,
      process.argv.includes("--release"),
    );
    console.log(`Changelog valid for ${pkg.version}`);
  } catch (error) {
    console.error(`Changelog validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
