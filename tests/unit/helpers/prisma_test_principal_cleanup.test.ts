import { describe, expect, it } from "vitest";

import {
  isTestPrincipalEmail,
  shouldCleanupPrismaTestPrincipals,
} from "../../helpers/prisma_test_principal_cleanup";

describe("prisma_test_principal_cleanup", () => {
  it("accepts only known test email domains", () => {
    expect(isTestPrincipalEmail("client-redis-fanout-1@test.com")).toBe(true);
    expect(isTestPrincipalEmail("e2e-client-1@plug.test")).toBe(true);
    expect(isTestPrincipalEmail("casetest-1@example.com")).toBe(true);
    expect(isTestPrincipalEmail("USER@EXAMPLE.COM")).toBe(true);
    expect(isTestPrincipalEmail("tercioscherwinski@gmail.com")).toBe(false);
    expect(isTestPrincipalEmail("graziela@casadomelfranquias.com.br")).toBe(false);
  });

  it("enables cleanup when persistence is prisma or the opt-in flag is set", () => {
    const previousMode = process.env.CONTAINER_PERSISTENCE_MODE;
    const previousFlag = process.env.VITEST_CLEANUP_PRISMA_TEST_DATA;
    try {
      delete process.env.CONTAINER_PERSISTENCE_MODE;
      delete process.env.VITEST_CLEANUP_PRISMA_TEST_DATA;
      expect(shouldCleanupPrismaTestPrincipals()).toBe(false);

      process.env.CONTAINER_PERSISTENCE_MODE = "prisma";
      expect(shouldCleanupPrismaTestPrincipals()).toBe(true);

      process.env.CONTAINER_PERSISTENCE_MODE = "memory";
      process.env.VITEST_CLEANUP_PRISMA_TEST_DATA = "true";
      expect(shouldCleanupPrismaTestPrincipals()).toBe(true);
    } finally {
      if (previousMode === undefined) {
        delete process.env.CONTAINER_PERSISTENCE_MODE;
      } else {
        process.env.CONTAINER_PERSISTENCE_MODE = previousMode;
      }
      if (previousFlag === undefined) {
        delete process.env.VITEST_CLEANUP_PRISMA_TEST_DATA;
      } else {
        process.env.VITEST_CLEANUP_PRISMA_TEST_DATA = previousFlag;
      }
    }
  });
});
