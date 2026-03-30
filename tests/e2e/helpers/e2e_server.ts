/**
 * E2E entry point for spinning the same stack as production tests:
 * Express + Socket.IO on an ephemeral port.
 */
export { createTestServer, type TestServerResult } from "../../helpers/test_server";
