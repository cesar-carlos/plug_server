import type { ISocketMetricsSnapshotPort } from "../../domain/ports/socket_metrics_snapshot.port";
import { getSocketMetricsSnapshot } from "../../socket";

export type SocketHubMetricsSnapshot = ReturnType<typeof getSocketMetricsSnapshot>;

export const createSocketMetricsSnapshotProvider = (): ISocketMetricsSnapshotPort & {
  getSnapshot(): SocketHubMetricsSnapshot;
} => ({
  getSnapshot: () => getSocketMetricsSnapshot(),
});
