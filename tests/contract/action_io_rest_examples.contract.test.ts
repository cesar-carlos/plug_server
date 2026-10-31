import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { agentCommandBodySchema } from "../../src/shared/validators/agent_command";
import { captureActionIoExpectation } from "../../src/shared/validators/action_io_response_expectation";
import { isValidActionIoResponse } from "../../src/shared/validators/action_io_result";
import { clientLoginBodySchema } from "../../src/presentation/http/validators/client_auth.validator";
import { isRecord } from "../../src/shared/utils/rpc_types";

const section = readFileSync("docs/api/api_rest_bridge.md", "utf8")
  .split("## Fluxo REST completo de I/O fiel")[1]!
  .split("## Chunks colunares")[0]!;
const examples: unknown[] = [...section.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) =>
  JSON.parse(match[1]!),
);

it("validates full REST I/O requests and correlated response examples", () => {
  const commands = new Map<unknown, Record<string, unknown>>();
  for (const value of examples) {
    if (!isRecord(value) || !isRecord(value.command)) continue;
    expect(agentCommandBodySchema.safeParse(value).success).toBe(true);
    commands.set(value.command.id, value.command);
  }
  expect(commands.size).toBe(7);
  for (const value of examples) {
    if (!isRecord(value) || !isRecord(value.response)) continue;
    expect(value.response.type).toBe("single");
    const item = value.response.item;
    expect(isRecord(item)).toBe(true);
    if (!isRecord(item)) throw Error("Invalid item");
    const command = commands.get(item.id);
    expect(command).toBeDefined();
    expect(
      isValidActionIoResponse(
        String(command!.method),
        {
          jsonrpc: "2.0",
          id: item.id,
          result: item.result,
        },
        captureActionIoExpectation(command),
      ),
    ).toBe(true);
  }
});

it("uses the Client login route and its current credential schema", () => {
  const request = section.match(/```http\r?\n([\s\S]*?)```/)?.[1];
  expect(request).toContain("POST /api/v1/client-auth/login");
  const body = request?.split(/\r?\n\r?\n/)[1];
  expect(clientLoginBodySchema.safeParse(JSON.parse(body!)).success).toBe(true);
});
