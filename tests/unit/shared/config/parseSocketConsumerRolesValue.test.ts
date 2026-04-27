import { describe, expect, it } from "vitest";

import { parseSocketConsumerRolesValue } from "../../../../src/shared/config/env";

describe("parseSocketConsumerRolesValue", () => {
  it("appends client when missing", () => {
    expect(parseSocketConsumerRolesValue("user,admin")).toEqual({
      roles: ["user", "admin", "client"],
      clientAppended: true,
    });
  });

  it("does not duplicate when client is present", () => {
    expect(parseSocketConsumerRolesValue("user,admin,client")).toEqual({
      roles: ["user", "admin", "client"],
      clientAppended: false,
    });
  });
});
