export interface IAgentsHubDiagnosticsPort {
  /** Live `/agents` namespace socket count on this hub process, when the namespace is initialized. */
  getAgentsNamespaceConnectionCount(): number | undefined;
}
