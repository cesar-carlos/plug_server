import type { AgentCatalogGeneration } from "../ports/agent_catalog_generation.port";

/** Process-local revision used when no shared Redis adapter is configured. */
export class MemoryAgentCatalogGeneration implements AgentCatalogGeneration {
  private generation = 0;

  async read(): Promise<number> {
    return this.generation;
  }

  async bump(): Promise<void> {
    this.generation += 1;
  }
}
