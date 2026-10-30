import { test } from "node:test";
import assert from "node:assert/strict";
import { validateChangelog } from "./check-changelog.mjs";
const valid =
  "## [Unreleased]\n\n## [1.0.0] - 2026-01-16\nStatus: prepared\nBuild: 1.0.0\n- Initial application.\n";
test("prepared release passes but historical baseline cannot publish", () => {
  validateChangelog(valid, "1.0.0", true);
  validateChangelog(valid.replace("prepared", "baseline"), "1.0.0");
  assert.throws(() => validateChangelog(valid.replace("prepared", "baseline"), "1.0.0", true));
});
test("missing versions, duplicate entries, invalid dates and missing notes fail", () => {
  for (const text of [
    valid.replaceAll("1.0.0", "0.9.0"),
    valid + valid.split("## [Unreleased]\n")[1],
    valid.replace("2026-01-16", "2026-02-30"),
    valid.replace("- Initial application.", ""),
    valid.replace("Build: 1.0.0", "Build: 1.0.1"),
  ])
    assert.throws(() => validateChangelog(text, "1.0.0"));
});
test("unassigned changes prevent publication", () => {
  for (const text of ["- New feature.", "Pending changes."])
    assert.throws(() =>
      validateChangelog(
        valid.replace("## [Unreleased]\n", "## [Unreleased]\n" + text + "\n"),
        "1.0.0",
        true,
      ),
    );
});
