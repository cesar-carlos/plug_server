import { beforeEach, describe, expect, it } from "vitest";

import {
  bridgeCommandReplayErrorCode,
  bridgeCommandReplayReason,
  getCompletedBridgeCommandReplay,
  rememberCompletedBridgeCommand,
  resetBridgeCommandReplayGuardForTests,
} from "../../../../src/application/agent_commands/bridge_command_replay_guard";

describe("bridge command replay guard", () => {
  beforeEach(() => {
    resetBridgeCommandReplayGuardForTests();
  });

  it("detects a repeated single command id inside the replay window", () => {
    const command = {
      jsonrpc: "2.0",
      id: "req-1",
      method: "sql.execute",
      params: { sql: "SELECT 1" },
    } as const;

    rememberCompletedBridgeCommand({
      agentId: "agent-1",
      command,
      nowMs: 1_000,
    });

    const replay = getCompletedBridgeCommandReplay({
      agentId: "agent-1",
      command,
      nowMs: 1_500,
    });

    expect(replay?.response).toMatchObject({
      jsonrpc: "2.0",
      id: "req-1",
      error: {
        code: bridgeCommandReplayErrorCode,
        data: {
          reason: bridgeCommandReplayReason,
        },
      },
    });
  });

  it("scopes duplicate ids by agent and id type", () => {
    const stringCommand = {
      jsonrpc: "2.0",
      id: "1",
      method: "sql.execute",
      params: { sql: "SELECT 1" },
    } as const;
    const numberCommand = {
      jsonrpc: "2.0",
      id: 1,
      method: "sql.execute",
      params: { sql: "SELECT 1" },
    } as const;

    rememberCompletedBridgeCommand({
      agentId: "agent-1",
      command: stringCommand,
      nowMs: 1_000,
    });

    expect(
      getCompletedBridgeCommandReplay({
        agentId: "agent-2",
        command: stringCommand,
        nowMs: 1_500,
      }),
    ).toBeNull();
    expect(
      getCompletedBridgeCommandReplay({
        agentId: "agent-1",
        command: numberCommand,
        nowMs: 1_500,
      }),
    ).toBeNull();
  });

  it("does not retain ids after the ttl expires and ignores batches", () => {
    const command = {
      jsonrpc: "2.0",
      id: "req-ttl",
      method: "sql.execute",
      params: { sql: "SELECT 1" },
    } as const;
    const batch = [
      {
        jsonrpc: "2.0",
        id: "req-ttl",
        method: "sql.execute",
        params: { sql: "SELECT 1" },
      },
    ] as const;

    rememberCompletedBridgeCommand({
      agentId: "agent-1",
      command,
      nowMs: 1_000,
    });
    rememberCompletedBridgeCommand({
      agentId: "agent-1",
      command: batch,
      nowMs: 1_000,
    });

    expect(
      getCompletedBridgeCommandReplay({
        agentId: "agent-1",
        command,
        nowMs: 121_001,
      }),
    ).toBeNull();
    expect(
      getCompletedBridgeCommandReplay({
        agentId: "agent-1",
        command: batch,
        nowMs: 1_500,
      }),
    ).toBeNull();
  });
});
