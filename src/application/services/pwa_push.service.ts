import type {
  PwaPushSender,
  PwaPushStore,
  PwaPushSubscription,
} from "../../domain/ports/pwa_push.port";
import { serviceUnavailable } from "../../shared/errors/http_errors";
import { logger } from "../../shared/utils/logger";

export class PwaPushService {
  private draining = false;
  constructor(
    private readonly store: PwaPushStore,
    private readonly sender: PwaPushSender,
    private readonly config: { readonly enabled: boolean; readonly publicKey: string },
  ) {}
  publicKey(): { enabled: boolean; publicKey: string | null } {
    return {
      enabled: this.config.enabled,
      publicKey: this.config.enabled ? this.config.publicKey : null,
    };
  }
  async subscribe(subscription: PwaPushSubscription): Promise<void> {
    if (!this.config.enabled) throw serviceUnavailable("Web Push is not configured");
    await this.store.save(subscription);
  }
  async unsubscribe(clientId: string, installationId: string): Promise<void> {
    await this.store.remove(clientId, installationId);
  }
  async drain(): Promise<void> {
    if (!this.config.enabled || this.draining) return;
    this.draining = true;
    try {
      for (let count = 0; count < 20; count++) {
        const job = await this.store.claim(new Date());
        if (!job) break;
        let outcome: "sent" | "expired" | "retry";
        try {
          outcome = await this.sender.send(job.subscription, job.message);
        } catch {
          outcome = "retry";
        }
        if (outcome === "expired")
          await this.store.remove(job.subscription.clientId, job.subscription.installationId);
        if (outcome !== "retry" || job.attempts >= 3) await this.store.complete(job.id);
        else await this.store.retry(job.id, new Date(Date.now() + 30_000 * 2 ** job.attempts));
        logger.info("pwa_push_delivery", { outcome, attempt: job.attempts });
      }
    } catch {
      logger.error("pwa_push_worker_failed");
    } finally {
      this.draining = false;
    }
  }
}
