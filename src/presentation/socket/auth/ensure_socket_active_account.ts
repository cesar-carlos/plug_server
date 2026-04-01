import { container } from "../../../shared/di/container";
import { incrementAuthSocketBlocked } from "../../../shared/metrics/auth_account.metrics";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";

/**
 * After JWT verification: rejects handshake when the user is missing or `blocked` (same rules as HTTP).
 * Increments `plug_auth_socket_blocked_total` when denied due to blocked status.
 */
export const ensureJwtUserAccountActive = async (
  user: JwtAccessPayload,
  next: (error?: Error) => void,
): Promise<boolean> => {
  const result = await container.authService.getActiveAccountUser(user.sub);
  if (!result.ok) {
    if (result.error.code === "FORBIDDEN" && result.error.message === "Account is blocked") {
      incrementAuthSocketBlocked();
    }
    next(result.error);
    return false;
  }
  return true;
};
