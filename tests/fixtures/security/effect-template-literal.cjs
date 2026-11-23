const assert = require("node:assert/strict");
const { Schema } = require(process.argv[2]);
const matches = Schema.is(
  Schema.TemplateLiteral(Schema.String, ":", Schema.String, ":", Schema.String, "X"),
);
assert.equal(matches("a:b:cX"), true);
assert.equal(matches(":".repeat(20_000)), false);
process.stdout.write("MATCHING_COMPLETED");
