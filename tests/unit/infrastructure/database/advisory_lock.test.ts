import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithAdvisoryLock } from "../../../../src/infrastructure/database/advisory_lock";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  dispose: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
}));
vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    connect = mocks.connect;
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.connect.mockResolvedValue({
    underlyingDriver: () => ({
      connect: async () => ({ query: mocks.query, release: mocks.release }),
    }),
    dispose: mocks.dispose,
  });
  mocks.query.mockResolvedValue({ rows: [{ acquired: true }] });
});

describe("maintenance lock connection ownership", () => {
  it("skips work and disposes the pool when lock acquisition fails", async () => {
    mocks.query.mockRejectedValue(new Error("connection unavailable"));
    const work = vi.fn();
    await expect(runWithAdvisoryLock(1n, "test", work)).resolves.toEqual({
      acquired: false,
      result: null,
    });
    expect(work).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("acquires and releases on the dedicated pool and closes it", async () => {
    await expect(runWithAdvisoryLock(1n, "test", async () => 42)).resolves.toEqual({
      acquired: true,
      result: 42,
    });
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls[0]?.[1]).toEqual(["1"]);
    expect(mocks.query.mock.calls[1]?.[0]).toContain("pg_advisory_unlock");
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledWith(true);
  });

  it("preserves the primary failure when unlock and disposal fail", async () => {
    const primary = new Error("job failed");
    mocks.query
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(new Error("unlock failed"));
    mocks.dispose.mockRejectedValue(new Error("dispose failed"));
    await expect(
      runWithAdvisoryLock(1n, "test", async () => {
        throw primary;
      }),
    ).rejects.toBe(primary);
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("skips work and closes the pool when another session owns the lock", async () => {
    mocks.query.mockResolvedValue({ rows: [{ acquired: false }] });
    const work = vi.fn();
    await expect(runWithAdvisoryLock(1n, "test", work)).resolves.toEqual({
      acquired: false,
      result: null,
    });
    expect(work).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
