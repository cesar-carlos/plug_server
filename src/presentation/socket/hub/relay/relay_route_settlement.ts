import type { RelayRequestRoute } from "../registries/relay_request_registry";

/**
 * Atomically marks a relay route as terminal-settled so timeout, success, and
 * synthetic error paths cannot all enqueue outbound responses for the same request.
 */
export const trySettleRelayRoute = (route: RelayRequestRoute): boolean => {
  if (route.settled === true) {
    return false;
  }
  route.settled = true;
  return true;
};
