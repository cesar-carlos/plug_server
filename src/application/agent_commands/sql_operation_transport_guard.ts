import {
  capabilityReason,
  capabilityUnavailable,
} from "../../shared/errors/capability_unavailable";
import { negotiateSqlOperations } from "../../shared/constants/sql_operation_transport";
import { AppError } from "../../shared/errors/app_error";
import { isRecord } from "../../shared/utils/rpc_types";
import type { BridgeCommand } from "../../shared/validators/agent_command";

export const hasSqlOperation = (command: BridgeCommand): boolean =>
  (Array.isArray(command) ? command : [command]).some((item) =>
    item.method.startsWith("sql.operation."),
  );

export const requiresLiveSqlCapability = (command: BridgeCommand): boolean =>
  hasSqlOperation(command) ||
  (Array.isArray(command) ? command : [command]).some(
    (item) =>
      item.method === "sql.describeSource" ||
      item.method === "sql.describeSchema" ||
      (isRecord(item.params) &&
        "expectedSource" in item.params &&
        item.params.expectedSource != null),
  );

/** Applies to the live authenticated agent registration, never consumer-provided metadata. */
export const assertSqlOperationTransport = (
  command: BridgeCommand,
  capabilities: Record<string, unknown> | null,
): void => {
  const items = Array.isArray(command) ? command : [command];
  const advertised =
    capabilities && isRecord(capabilities.extensions) ? capabilities.extensions : {};
  const needsConstraints = items.some((item) => {
    if (
      !isRecord(item.params) ||
      !("expectedStructure" in item.params) ||
      !isRecord(item.params.expectedStructure)
    )
      return false;
    const resources = item.params.expectedStructure.resources;
    return (
      Array.isArray(resources) &&
      resources.some((r: unknown) => isRecord(r) && r.constraints !== undefined)
    );
  });
  if (
    needsConstraints &&
    (!capabilities ||
      !isRecord(capabilities.extensions) ||
      capabilities.extensions.sourceConstraints !== 1)
  )
    throw capabilityUnavailable(
      "sourceConstraints v1",
      capabilityReason(advertised.sourceConstraints),
    );
  if (
    items.some(
      (item) =>
        item.method === "sql.describeSchema" ||
        (isRecord(item.params) &&
          "expectedStructure" in item.params &&
          item.params.expectedStructure !== undefined),
    ) &&
    (!capabilities ||
      !isRecord(capabilities.extensions) ||
      capabilities.extensions.sourceSchema !== 1)
  )
    throw capabilityUnavailable("sourceSchema v1", capabilityReason(advertised.sourceSchema));
  if (
    items.some((item) => item.method === "sql.describeSource") &&
    (!capabilities ||
      !isRecord(capabilities.extensions) ||
      capabilities.extensions.sourceDiscovery !== 1)
  )
    throw capabilityUnavailable("sourceDiscovery v1", capabilityReason(advertised.sourceDiscovery));
  if (
    items.some(
      (item) =>
        isRecord(item.params) &&
        "expectedSource" in item.params &&
        item.params.expectedSource != null,
    ) &&
    (!capabilities ||
      !isRecord(capabilities.extensions) ||
      capabilities.extensions.sourceIdentity !== 1)
  ) {
    throw capabilityUnavailable("sourceIdentity v1", capabilityReason(advertised.sourceIdentity));
  }
  if (!hasSqlOperation(command)) return;
  const extensions =
    capabilities && isRecord(capabilities.extensions) ? capabilities.extensions : null;
  const negotiated = negotiateSqlOperations(extensions?.sqlOperations);
  if (!negotiated)
    throw capabilityUnavailable("sqlOperations v1", capabilityReason(advertised.sqlOperations));
  for (const item of Array.isArray(command) ? command : [command]) {
    if (item.method !== "sql.operation.execute") continue;
    if (item.params.expectedStructure && negotiated.structureGuard !== 1)
      throw capabilityUnavailable(
        "sqlOperations.structureGuard v1",
        capabilityReason(negotiated.structureGuard),
      );
    if (
      item.params.steps.length > negotiated.maxSteps ||
      item.params.maxAffectedRows > negotiated.maxAffectedRows ||
      item.params.timeoutMs > negotiated.timeoutMs
    ) {
      throw new AppError("SQL operation exceeds negotiated limits.", {
        statusCode: 409,
        code: "SQL_OPERATION_NEGOTIATED_LIMIT",
        details: { retryable: false },
      });
    }
  }
};
