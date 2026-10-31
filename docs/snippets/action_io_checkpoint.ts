import { open, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { ActionIoClientError, type ActionIoReferenceClient } from "./action_io_reference_client";

// Each exclusive, flushed intent file precedes its only possible dispatch.
// An incomplete file or unconfirmed lookup requires manual reconciliation.
export async function claim<T>(path: string, intent: T): Promise<{ fresh: boolean; intent: T }> {
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { fresh: false, intent: JSON.parse(await readFile(path, "utf8")) as T };
  }
  try {
    await file.writeFile(JSON.stringify(intent));
    await file.sync();
  } finally {
    await file.close();
  }
  return { fresh: true, intent };
}

async function dispatchOnce(send?: () => Promise<unknown>): Promise<void> {
  try {
    await send?.();
  } catch (error) {
    if (!(error instanceof ActionIoClientError && error.outcomeUnknown)) throw error;
  }
}

export async function reconcileRun(
  client: ActionIoReferenceClient,
  actionId: string,
  key: string,
  send?: () => Promise<unknown>,
): Promise<string> {
  await dispatchOnce(send);
  const found = await client.findExecution(actionId, key);
  if (found.found !== true || typeof found.execution_id !== "string")
    throw new Error("Run outcome unknown; preserve checkpoint and reconcile the original key");
  return found.execution_id;
}

export async function writeConfirmed(
  client: ActionIoReferenceClient,
  id: string,
  message: string,
  send?: () => Promise<unknown>,
): Promise<void> {
  await dispatchOnce(send);
  const deadline = Date.now() + 30000;
  while (true) {
    const receipt = await client.getInputStatus(id, message);
    if (receipt.state === "written") return;
    if (!["accepted", "writing"].includes(String(receipt.state)) || Date.now() >= deadline)
      throw new Error(
        "Delivery failed or unknown; preserve checkpoint and reconcile the original message",
      );
    await delay(100);
  }
}
