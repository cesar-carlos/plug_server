/** Mutations may have reached the agent even when no acknowledgement arrives. */
export const isActionMutationMethod = (method: string | undefined): boolean =>
  method === "agent.action.run" ||
  method === "agent.action.cancel" ||
  method === "agent.action.sendInput" ||
  method === "agent.action.closeInput";

/** Action states and permissions can change; their journal owns deduplication. */
export const mayCacheActionResponse = (method: string | undefined): boolean =>
  !method?.startsWith("agent.action.");
