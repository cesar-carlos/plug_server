import webPush from "web-push";
import type {
  PwaPushMessage,
  PwaPushSender,
  PwaPushSubscription,
} from "../../domain/ports/pwa_push.port";
import { isAllowedPwaPushEndpoint } from "../../domain/policies/pwa_push_endpoint.policy";
export class WebPushSender implements PwaPushSender {
  constructor(
    private readonly config: { subject: string; publicKey: string; privateKey: string },
  ) {}
  async send(
    subscription: PwaPushSubscription,
    message: PwaPushMessage,
  ): Promise<"sent" | "expired" | "retry"> {
    if (!isAllowedPwaPushEndpoint(subscription.endpoint)) return "expired";
    try {
      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(message),
        {
          TTL: 3600,
          timeout: 10_000,
          vapidDetails: this.config,
        },
      );
      return "sent";
    } catch (error: unknown) {
      if (error instanceof webPush.WebPushError && [404, 410].includes(error.statusCode))
        return "expired";
      return "retry";
    }
  }
}
