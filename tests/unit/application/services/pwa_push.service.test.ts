import { describe, it, expect, vi } from "vitest";
import { PwaPushService } from "../../../../src/application/services/pwa_push.service";
import type {
  PwaPushStore,
  PwaPushSender,
  PwaPushJob,
} from "../../../../src/domain/ports/pwa_push.port";
const subscription = {
  clientId: "client",
  installationId: "installation",
  endpoint: "https://fcm.googleapis.com/test",
  p256dh: "key",
  auth: "auth",
};
function fixture(
  outcome: "sent" | "expired" | "retry",
  attempts = 1,
): { store: PwaPushStore; sender: PwaPushSender; service: PwaPushService } {
  const job: PwaPushJob = {
    id: "job",
    subscription,
    message: { eventId: "event", type: "access-approved" },
    attempts,
  };
  const store: PwaPushStore = {
    save: vi.fn(),
    remove: vi.fn(),
    enqueue: vi.fn(),
    claim: vi.fn().mockResolvedValueOnce(job).mockResolvedValue(null),
    complete: vi.fn(),
    retry: vi.fn(),
  };
  const sender: PwaPushSender = { send: vi.fn().mockResolvedValue(outcome) };
  return {
    store,
    sender,
    service: new PwaPushService(store, sender, { enabled: true, publicKey: "public" }),
  };
}
describe("PWA push delivery", () => {
  it("completes successful delivery", async () => {
    const f = fixture("sent");
    await f.service.drain();
    expect(f.store.complete).toHaveBeenCalledWith("job");
    expect(f.store.retry).not.toHaveBeenCalled();
  });
  it("removes expired subscriptions", async () => {
    const f = fixture("expired");
    await f.service.drain();
    expect(f.store.remove).toHaveBeenCalledWith("client", "installation");
  });
  it("bounds retries", async () => {
    const f = fixture("retry", 3);
    await f.service.drain();
    expect(f.store.complete).toHaveBeenCalledWith("job");
    expect(f.store.retry).not.toHaveBeenCalled();
  });
  it("schedules transient failures without leaking payloads", async () => {
    const f = fixture("retry");
    await f.service.drain();
    expect(f.store.retry).toHaveBeenCalledOnce();
    expect(f.store.complete).not.toHaveBeenCalled();
  });
  it("prevents overlapping drains", async () => {
    const f = fixture("sent");
    await Promise.all([f.service.drain(), f.service.drain()]);
    expect(f.sender.send).toHaveBeenCalledOnce();
  });
});
