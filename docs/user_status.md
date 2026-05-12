# User account status (`UserStatus`)

Values: `pending`, `active`, `rejected`, `blocked`.

## Transitions

| From      | To        | How |
|-----------|-----------|-----|
| —         | `pending` | User registers (`POST /api/v1/auth/register` or alias `/auth/register`). |
| `pending` | `active`  | Registration approval flow (admin token). |
| `pending` | `rejected`| Registration rejection flow. |
| `rejected`| `pending` | Registration retry flow (`POST /api/v1/auth/registration/retry`) when email/password match. |
| `pending` | `blocked` | Admin `PATCH /api/v1/admin/users/:id/status` with `{ "status": "blocked" }` (optional; blocks before approval). |
| `active`  | `blocked` | Admin same endpoint; **all refresh tokens for that user are revoked**. |
| `blocked` | `active`  | Admin same endpoint with `{ "status": "active" }` (unblock only; does not replace registration approval for `pending`). |
| `rejected`| `blocked` | Admin may block; account remains unusable for login until unblocked or re-registered. |

Admin actions on `PATCH /api/v1/admin/users/:id/status` are **rate-limited per admin** (JWT `sub`); see `REST_ADMIN_USER_STATUS_RATE_LIMIT_*` in `.env.example`. Successful changes emit structured log `admin_user_status_set` with `actorUserId`, `targetUserId`, `status`, `requestId` (no email/PII).

## API behaviour

- **Login / refresh:** `blocked` accounts receive **403** with message `Account is blocked`.
- **Bearer routes:** After JWT validation, the server loads the user and denies access if status is `blocked` (**403**), so a still-valid access token cannot be used until unblocked. The loaded row is kept on `response.locals.activeAccountUser` for the request; handlers can call `resolveActiveAccountUser` (or pass the entity into services) to avoid a second `SELECT` for the same user.
- **Socket.IO (`/agents`, `/consumers`):** After JWT validation (and namespace role rules), the server loads the user and rejects the handshake if status is `blocked` (**403**), aligned with HTTP. On `/consumers`, sensitive operations also revalidate active account status per event, so blocking the account after connection immediately stops new authorized operations. The socket may remain connected until disconnect/expiry, but operational permission no longer remains active.
- **Profile (`PATCH /api/v1/auth/me` or alias `/auth/me`):** Authenticated users may set or clear `celular` (same validation as registration; `null` removes). **403** while `blocked`.
- **Change password:** **403** while `blocked`.

## Metrics (Prometheus)

- `plug_auth_login_blocked_total` — login attempts denied due to `blocked`.
- `plug_auth_refresh_blocked_total` — refresh denied due to `blocked`.
- `plug_auth_socket_blocked_total` — Socket.IO handshake attempts denied due to `blocked` (after valid JWT).
- `plug_admin_user_status_set_total` — successful admin status updates (block/unblock).
- `plug_rest_http_rate_limit_admin_user_status_rejected_total` — admin status PATCH rejected by rate limit.

## Client account status (`ClientStatus`)

Values: `pending`, `active`, `rejected`, `blocked`.

- **Register (`POST /api/v1/client-auth/register`)**: creates `Client` in `pending` and sends owner approval flow.
- **Public validation (`POST /api/v1/client-auth/register`)**: `ownerEmail` must match an **`active`** `User`. Missing owner and inactive owner both yield the same **400** (`BAD_REQUEST`) and the same message (`Owner email is not eligible to approve client registration`), so the API does not distinguish the two cases.
- **Approve (`POST /api/v1/client-auth/registration/approve`)**: transitions `pending -> active`.
- **Reject (`POST /api/v1/client-auth/registration/reject`)**: transitions `pending -> rejected`.
- **Retry (`POST /api/v1/client-auth/registration/retry`)**: may transition `rejected -> pending` only when the client email/password match, the submitted `ownerEmail` matches the same active owner (case-insensitive), and the retry is treated as a new approval request.
- **Poll (`GET /api/v1/client-auth/registration/status`)**: returns `pending` or `expired` while the client is still `pending`; if the client row is already `active`, `rejected`, or `blocked` but a token row still exists, returns `approved`, `rejected`, or `blocked` respectively. Missing client for the token yields **404** and the orphan token is removed.
- **Storage (`users.email`, `clients.email`)**: PostgreSQL `citext` enforces **case-insensitive uniqueness** at the database level (migration `20260512190000_citext_user_client_email`). The API still normalizes addresses to lowercase on input.
- **Owner governance (`PATCH /api/v1/me/clients/:id/status`)**: only reviewed clients may change between `active` and `blocked`; `pending` must stay on the registration approval flow.
- **Login / refresh / protected routes / socket ops**: only `active` clients can operate.
- **Historical compatibility**: legacy rows already stored as `blocked` are not backfilled automatically; older rejected registrations may still appear as `blocked` until they re-enter the registration flow.
- **Operational support note**: when investigating older accounts created before the `rejected` rollout, interpret `blocked` with timeline context. A legacy `blocked` row may represent either a governance block or a historical registration rejection.
- **Recommended triage**: use the account creation date, approval/retry history, and current owner actions before treating a legacy `blocked` client as a fresh governance event.

## Public approval links and CORS

HTML review pages and `POST` approve/reject for **user** registration (`/api/v1/auth/registration/*`) and **client** registration (`/api/v1/client-auth/registration/*`) use the same global CORS middleware as other public flows (including `/api/v1/client-access/*`). Some email apps and embedded browsers send the HTTP header `Origin` with the literal value `null` (opaque origin). The server accepts that case in `buildCorsOptions` (`src/shared/config/cors.ts`) so those routes are not blocked before business logic runs. Regression coverage includes approve and reject (plus `OPTIONS` preflight where exercised): `tests/integration/auth.integration.test.ts`, `tests/integration/client_auth.integration.test.ts`, `tests/integration/client_agents.integration.test.ts`, and unit tests in `tests/unit/shared/config/cors.test.ts`.
