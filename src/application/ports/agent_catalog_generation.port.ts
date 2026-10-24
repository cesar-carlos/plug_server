/** Monotonic catalog revision. `null` means the revision cannot be confirmed. */
export interface AgentCatalogGeneration {
  read(): Promise<number | null>;
  bump(): Promise<void>;
}
