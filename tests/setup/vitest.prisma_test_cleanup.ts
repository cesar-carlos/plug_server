import { afterEach } from "vitest";

import { cleanupTrackedTestScopePrincipals } from "../helpers/prisma_test_principal_cleanup";

/**
 * Per-test Prisma rows created by session/e2e helpers (users, clients, agents)
 * are deleted after each test when persistence is Prisma or when a distributed
 * hub child opted into cleanup. Suite-scoped fixture rows are owned by
 * `cleanupTrackedSuiteScopePrincipals` (e.g. e2e hub fixture `close`).
 */
afterEach(async () => {
  await cleanupTrackedTestScopePrincipals();
});
