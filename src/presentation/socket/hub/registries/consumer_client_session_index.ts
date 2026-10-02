/** Per-namespace client membership, sorted only when the set of principals changes. */
export class ConsumerClientSessionIndex {
  private readonly socketsByClient = new Map<string, Set<string>>();
  private readonly clientBySocket = new Map<string, string>();
  private sortedClients: readonly string[] | null = null;

  public register(socketId: string, clientId: string): void {
    if (this.clientBySocket.get(socketId) === clientId) return;
    this.remove(socketId);
    let sockets = this.socketsByClient.get(clientId);
    if (!sockets) {
      sockets = new Set();
      this.socketsByClient.set(clientId, sockets);
      this.sortedClients = null;
    }
    sockets.add(socketId);
    this.clientBySocket.set(socketId, clientId);
  }

  public remove(socketId: string): void {
    const clientId = this.clientBySocket.get(socketId);
    if (clientId === undefined) return;
    this.clientBySocket.delete(socketId);
    const sockets = this.socketsByClient.get(clientId);
    sockets?.delete(socketId);
    if (sockets?.size === 0) {
      this.socketsByClient.delete(clientId);
      this.sortedClients = null;
    }
  }

  public getSortedClientIds(): readonly string[] {
    return (this.sortedClients ??= [...this.socketsByClient.keys()].sort((left, right) =>
      left.localeCompare(right),
    ));
  }

  public getSocketIds(clientId: string): ReadonlySet<string> {
    return this.socketsByClient.get(clientId) ?? new Set<string>();
  }

  public clear(): void {
    this.socketsByClient.clear();
    this.clientBySocket.clear();
    this.sortedClients = null;
  }
}
