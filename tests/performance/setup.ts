import type * as SocketAuditModule from "../../src/application/services/socket_audit.service";
import { vi } from "vitest";

// Measure protocol work independently of database availability and audit batching.
vi.mock("../../src/application/services/socket_audit.service", async (importOriginal) => ({
  ...(await importOriginal<typeof SocketAuditModule>()),
  recordSocketAuditEvent: vi.fn(async (): Promise<void> => undefined),
}));
