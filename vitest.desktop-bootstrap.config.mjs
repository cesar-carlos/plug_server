import recoveryConfig from "./vitest.sql-recovery.config.mjs";

export default {
  ...recoveryConfig,
  test: {
    ...recoveryConfig.test,
    include: [
      "tests/integration/desktop_bootstrap.integration.test.ts",
      "tests/integration/configured_desktop_bootstrap.integration.test.ts",
    ],
  },
};
