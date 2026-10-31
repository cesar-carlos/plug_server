import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ActionIoReferenceClient } from "./action_io_reference_client";
import { claim, reconcileRun, writeConfirmed } from "./action_io_checkpoint";

type Target = { url: string; agentId: string; clientId: string; name: string; triggerId?: string };
type RunIntent = { target: Target; actionId: string; key: string; initialHash: string | null };
type InputIntent = { id: string; label: string; hash: string | null; message: string };
export type IoEvent =
  | {
      type: "output";
      sequence: number;
      stream: "stdout" | "stderr";
      offset: number;
      bytes: Uint8Array;
    }
  | { type: "process_exited"; sequence: number; exitCode: number | null }
  | { type: "completed"; sequence: number; complete: boolean }
  | { type: "capture_error"; sequence: number };

async function existing<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One private checkpoint directory per execution. Use stable caller-chosen labels for input steps. */
export class ActionIoSession {
  private constructor(
    private client: ActionIoReferenceClient,
    private directory: string,
    readonly executionId: string,
    private firstSequence: number,
  ) {}

  static async open(
    client: ActionIoReferenceClient,
    directory: string,
    target: Target,
    initial?: Uint8Array,
  ) {
    if (initial && initial.length > 65536) throw new Error("Initial block exceeds 64 KiB");
    const bytes = initial === undefined ? undefined : Uint8Array.from(initial);
    const initialHash = bytes === undefined ? null : digest(bytes);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "run.json");
    let intent = await existing<RunIntent>(path);
    if (!intent) {
      const matches = [];
      for await (const action of client.listAvailable())
        if (action.name === target.name) matches.push(action);
      assert.equal(matches.length, 1, "Select a unique authorized action name");
      const actionId = matches[0]!.action_id as string;
      await client.validateRun(actionId, target.triggerId);
      intent = { target, actionId, key: randomUUID(), initialHash };
    }
    const run = await claim(path, intent);
    assert.deepEqual(run.intent.target, target, "Checkpoint belongs to a different target");
    assert.equal(
      run.intent.initialHash,
      initialHash,
      "Initial input differs from the original intent",
    );
    const id = await reconcileRun(
      client,
      run.intent.actionId,
      run.intent.key,
      run.fresh
        ? () => client.run(run.intent.actionId, run.intent.key, {
            ...(bytes === undefined ? {} : { initial: bytes }),
            ...(target.triggerId === undefined ? {} : { triggerId: target.triggerId }),
          })
        : undefined,
    );
    return new ActionIoSession(client, directory, id, bytes === undefined ? 0 : 1);
  }

  write(label: string, bytes: Uint8Array) {
    if (bytes.length > 65536) throw new Error("Input block exceeds 64 KiB");
    return this.input(label, Uint8Array.from(bytes));
  }

  close(label: string) {
    return this.input(label, undefined);
  }

  private async input(label: string, bytes?: Uint8Array) {
    assert.ok(label.trim().length > 0);
    const hash = bytes === undefined ? null : digest(bytes);
    for (let sequence = this.firstSequence; sequence < 8192; sequence++) {
      const step = await claim<InputIntent>(join(this.directory, "input-" + sequence + ".json"), {
        id: this.executionId,
        label,
        hash,
        message: randomUUID(),
      });
      assert.equal(step.intent.id, this.executionId);
      if (step.intent.label === label) {
        assert.equal(step.intent.hash, hash, "Conflicting input for existing label");
        await writeConfirmed(
          this.client,
          this.executionId,
          step.intent.message,
          step.fresh
            ? () =>
                bytes === undefined
                  ? this.client.closeInput(this.executionId, step.intent.message, sequence)
                  : this.client.sendInput(this.executionId, step.intent.message, sequence, bytes)
            : undefined,
        );
        return;
      }
      if (step.intent.hash === null) throw new Error("Input already closed");
      await writeConfirmed(this.client, this.executionId, step.intent.message);
    }
    throw new Error("Input message limit reached");
  }

  /** The consumer acknowledges a whole page by returning its JSON checkpoint.
   * If it writes elsewhere, deduplicate by execution ID and event sequence. */
  async consume<T>(
    initialState: T,
    consumePage: (events: readonly IoEvent[], previous: T) => Promise<T>,
    timeoutMs = 60000,
  ): Promise<T> {
    let cursor = 0;
    let state = initialState;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const path = join(this.directory, "page-" + cursor + ".json");
      type Page = { id: string; next: number; complete: boolean; state: T };
      let saved = await existing<Page>(path);
      if (!saved) {
        const page = await this.client.readIo(
          this.executionId,
          cursor,
          Math.min(1000, Math.max(0, deadline - Date.now())),
        );
        const next = page.next_sequence as number;
        if (next === cursor) continue;
        assert.ok(next > cursor);
        const events: IoEvent[] = (page.events as Record<string, unknown>[]).map((event) => {
          const sequence = event.sequence as number;
          if (event.type === "output")
            return {
              type: "output",
              sequence,
              stream: event.stream as "stdout" | "stderr",
              offset: event.offset as number,
              bytes: Buffer.from(event.data_base64 as string, "base64"),
            };
          if (event.type === "process_exited")
            return { type: "process_exited", sequence, exitCode: event.exit_code as number | null };
          if (event.type === "completed")
            return { type: "completed", sequence, complete: event.output_complete === true };
          return { type: "capture_error", sequence };
        });
        const intent = {
          id: this.executionId,
          next,
          complete: events.some((event) => event.type === "completed"),
          state: await consumePage(events, state),
        };
        const record = await claim(path, intent);
        assert.deepEqual(record.intent, intent);
        saved = record.intent;
      }
      assert.equal(saved.id, this.executionId);
      assert.ok(Number.isSafeInteger(saved.next) && saved.next > cursor);
      state = saved.state;
      if (saved.complete) return state;
      cursor = saved.next;
    }
    throw new Error("Read timed out; resume with the same checkpoint directory");
  }
}
