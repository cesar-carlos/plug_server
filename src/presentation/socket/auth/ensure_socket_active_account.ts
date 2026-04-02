import { container } from "../../../shared/di/container";
import { unauthorized } from "../../../shared/errors/http_errors";
import { incrementAuthSocketBlocked } from "../../../shared/metrics/auth_account.metrics";
import type { JwtAccessPayload } from "../../../shared/utils/jwt";

/**
 * After JWT verification: rejects handshake when the user is missing or `blocked` (same rules as HTTP).
 * Increments `plug_auth_socket_blocked_total` when denied due to blocked status.
 */
export const assertJwtUserAccountActive = async (
  user: JwtAccessPayload | undefined,
): Promise<JwtAccessPayload> => {
  if (!user?.sub) {
    throw unauthorized("Authentication required");
  }

  const result =
    user.principal_type === "client"
      ? await container.clientAuthService.getActiveClient(user.sub)
      : await container.authService.getActiveAccountUser(user.sub);
  if (!result.ok) {
    if (result.error.code === "FORBIDDEN" && result.error.message === "Account is blocked") {
      incrementAuthSocketBlocked();
    }
    throw result.error;
  }

  return user;
};

export const ensureJwtUserAccountActive = async (
  user: JwtAccessPayload,
  next: (error?: Error) => void,
): Promise<boolean> => {
  try {
    await assertJwtUserAccountActive(user);
  } catch (error: unknown) {
    next(error instanceof Error ? error : unauthorized("Authentication required"));
    return false;
  }

  return true;
};
