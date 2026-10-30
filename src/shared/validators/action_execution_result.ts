import { z } from "zod";

// Mirrors the canonical agent action result schemas; I/O selection is enforced by the response guard.
export const actionExecutionResultSchema = z
  .object({
    execution_id: z.string().min(1),
    action_id: z.string().min(1),
    action_type: z.enum([
      "commandLine",
      "executable",
      "script",
      "jar",
      "email",
      "comObject",
      "developer",
    ]),
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "skipped",
      "cancelled",
      "killed",
      "timedOut",
      "interrupted",
      "unknown",
    ]),
    source: z.enum(["localUi", "scheduler", "remoteHub", "appLifecycle"]),
    requested_at: z.string().datetime({ offset: true }),
    idempotency_key: z.string().min(1).optional(),
    requested_by: z.string().min(1).optional(),
    trace_id: z.string().min(1).optional(),
    runtime_instance_id: z.string().min(1).optional(),
    runtime_session_id: z.string().min(1).optional(),
    trigger: z
      .object({
        trigger_id: z.string().min(1).optional(),
        trigger_type: z
          .enum([
            "manual",
            "remote",
            "once",
            "interval",
            "daily",
            "weekly",
            "monthly",
            "appStart",
            "appClose",
            "actionSucceeded",
            "actionFailed",
          ])
          .optional(),
        scheduled_at: z.string().datetime({ offset: true }).optional(),
        triggered_at: z.string().datetime({ offset: true }).optional(),
      })
      .strict()
      .optional(),
    timestamps: z
      .object({
        queue_started_at: z.string().datetime({ offset: true }).optional(),
        process_started_at: z.string().datetime({ offset: true }).optional(),
        finished_at: z.string().datetime({ offset: true }).optional(),
        timeout_at: z.string().datetime({ offset: true }).optional(),
      })
      .strict(),
    process: z
      .object({
        pid: z.number().int().min(0).optional(),
        exit_code: z.number().int().optional(),
        executable: z.string().min(1).optional(),
        argument_count: z.number().int().min(0).optional(),
        command_preview: z.string().min(1).optional(),
      })
      .strict(),
    output: z
      .object({
        stdout: z
          .object({
            captured: z.boolean(),
            text: z.string().optional(),
            truncated: z.boolean(),
            utf8_total_bytes: z.number().int().min(0),
            offset: z.number().int().min(0),
            next_offset: z.number().int().min(0),
            response_truncated: z.boolean(),
          })
          .strict(),
        stderr: z
          .object({
            captured: z.boolean(),
            text: z.string().optional(),
            truncated: z.boolean(),
            utf8_total_bytes: z.number().int().min(0),
            offset: z.number().int().min(0),
            next_offset: z.number().int().min(0),
            response_truncated: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    flags: z
      .object({
        terminal: z.boolean(),
        skipped: z.boolean(),
        timed_out: z.boolean(),
        cancelled: z.boolean(),
        killed: z.boolean(),
        redaction_applied: z.boolean(),
      })
      .strict(),
    context_hash: z.string().min(1).optional(),
    definition_snapshot_hash: z.string().min(1).optional(),
    failure: z
      .object({
        code: z.string().min(1).optional(),
        phase: z.string().min(1).optional(),
        corrective_action: z
          .enum([
            "review_path",
            "review_runner",
            "review_exit_code",
            "review_queue",
            "review_timeout",
            "retry_kill",
            "review_definition_validation",
            "review_preflight",
            "review_start_process",
            "review_runtime",
          ])
          .optional(),
        message: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    io: z
      .object({
        version: z.literal(1),
        mode: z.literal("faithful"),
        process_state: z.enum(["queued", "starting", "running", "finished", "unknown"]),
        stdin_state: z.enum(["pending", "open", "closing", "closed", "failed"]),
        capture_state: z.enum(["capturing", "draining", "complete", "incomplete", "expired"]),
        output_expired: z.boolean(),
        initial_message_id: z.literal("system:initial").optional(),
        close_message_id: z.literal("system:close").optional(),
        next_input_sequence: z.number().int().min(0),
      })
      .strict()
      .optional(),
  })
  .strict();
export const actionValidateRunResultSchema = z
  .object({
    valid: z.literal(true),
    action_id: z.string().min(1),
    action_type: z.string().min(1),
    definition_snapshot_hash: z.string().optional(),
    would_replay_existing_execution: z.boolean(),
    existing_execution_id: z.string().min(1).optional(),
  })
  .strict();
export const actionCancelResultSchema = z
  .object({
    cancelled: z.boolean(),
    execution_id: z.string().min(1),
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "killed",
      "timedOut",
      "interrupted",
      "unknown",
    ]),
    reason: z.enum(["cancelled", "killed", "cancel_requested"]),
    execution: actionExecutionResultSchema,
  })
  .strict();
