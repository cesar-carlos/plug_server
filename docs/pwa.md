# Colmeia PWA contracts

These additive routes are mounted below `/api/v1/client/me/pwa`. Every route requires a client bearer token and a fresh active-account check. Existing REST and Socket contracts are unchanged.

| Method and path | Result |
| --- | --- |
| POST `/offline-authorization` | `{agentIds: UUID[]}` (1–100 unique IDs); success envelope `data` contains `version:1`, authenticated `userId`, approved active `agentIds`, UTC `issuedAt`, and `expiresAt` exactly 24 hours later. |
| GET `/push-key` | Success envelope `data: {enabled, publicKey}`. Private VAPID material is never returned. |
| PUT `/subscriptions/:installationId` | UUID installation plus `{endpoint, keys:{p256dh,auth}}`; 204. Identity comes exclusively from authentication. |
| DELETE `/subscriptions/:installationId` | Idempotent removal scoped to the authenticated client; 204. Pending deliveries for this installation are cancelled. |

Offline grants authorize local reads only. They are not accepted as HTTP or Socket credentials. Revoked/unknown/inactive agents produce 403; missing/expired client authentication produces 401. No grant or key response may be cached by an intermediary (`Cache-Control: no-store`).

## Deployment

Apply migration `20261026130000_pwa_push` before enabling the feature. Configure `PWA_PUSH_ENABLED=true`, `PWA_VAPID_PUBLIC_KEY`, `PWA_VAPID_PRIVATE_KEY`, and `PWA_VAPID_SUBJECT` (a contact `mailto:` or HTTPS URL). Generate one stable VAPID pair with the installed `web-push` library; keep the private key in the server secret manager. Do not place it in Colmeia assets, defines, logs, or public configuration. Key rotation requires browser re-subscription.

Allow the Colmeia HTTPS origin through existing CORS/Socket origin settings, including Authorization, Content-Type, POST, PUT and DELETE preflights. Use WSS for browser Socket connections. No deployment or real-database migration is performed automatically by these changes.

Subscription endpoints are restricted to HTTPS Google FCM, Mozilla push and Windows notification hosts. Credentials, fragments, custom ports and lookalike hostnames are rejected. Keep this allowlist explicit when adding providers.

## Delivery

Approval/revocation decisions persist generic delivery records in the same PostgreSQL transaction as the access change. The worker can only observe committed records. A database uniqueness constraint deduplicates event/installation pairs. The worker leases jobs with an optimistic compare-and-swap, sends at most three attempts, retries transient failures with bounded backoff, and removes expired (404/410) subscriptions. Queue and delivery logging contains outcomes/attempt counts, never endpoint credentials, encryption keys or financial data.

The notification contains only event identity and approval/revocation type. Colmeia's shared service worker displays generic text and opens its guarded agents route. Browser permission must follow an explicit action; refusal must not affect normal application use. A browser/system may decline background delivery even when the server accepts a subscription.

A delivery persistence failure rolls back the access decision and returns the existing service-unavailable failure; it cannot leave a committed decision without its queued notifications. Committed deliveries survive server restart and are recovered by the worker. Repeated approvals/revocations do not create another event after the access transition has already completed. In-memory persistence does not enable Push. Transaction rollback, queue persistence and claims have been tested against an isolated PostgreSQL instance; mocked sender tests alone do not prove provider delivery.

## Verification

Run `npm run typecheck`, `npm run lint`, `npm test`, and the optional database-backed `tests/integration/pwa_push_store.integration.test.ts` with `PWA_DATABASE_TEST=true` and `DATABASE_URL` pointing only to a disposable test database containing the migration. Never point this opt-in test at a shared or production database.

The Colmeia repository owns production-browser shell tests in `tool/pwa-tests`. Its optional `push-smoke.mjs` generates temporary VAPID keys in memory, subscribes a temporary browser profile and attempts real provider delivery after closing the application tab. Production acceptance still requires successful real delivery on supported devices, including revocation and logout.
