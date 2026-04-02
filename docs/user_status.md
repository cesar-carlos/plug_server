# User account status (`UserStatus`)

Values: `pending`, `active`, `rejected`, `blocked`.

## Transitions

| From      | To        | How |
|-----------|-----------|-----|
| —         | `pending` | User registers (`POST /auth/register`). |
| `pending` | `active`  | Registration approval flow (admin token). |
| `pending` | `rejected`| Registration rejection flow. |
| `pending` | `blocked` | Admin `PATCH /admin/users/:id/status` with `{ "status": "blocked" }` (optional; blocks before approval). |
| `active`  | `blocked` | Admin same endpoint; **all refresh tokens for that user are revoked**. |
| `blocked` | `active`  | Admin same endpoint with `{ "status": "active" }` (unblock only; does not replace registration approval for `pending`). |
| `rejected`| `blocked` | Admin may block; account remains unusable for login until unblocked or re-registered. |

Admin actions on `PATCH /admin/users/:id/status` are **rate-limited per admin** (JWT `sub`); see `REST_ADMIN_USER_STATUS_RATE_LIMIT_*` in `.env.example`. Successful changes emit structured log `admin_user_status_set` with `actorUserId`, `targetUserId`, `status`, `requestId` (no email/PII).

## API behaviour

- **Login / refresh:** `blocked` accounts receive **403** with message `Account is blocked`.
- **Bearer routes:** After JWT validation, the server loads the user and denies access if status is `blocked` (**403**), so a still-valid access token cannot be used until unblocked. The loaded row is kept on `response.locals.activeAccountUser` for the request; handlers can call `resolveActiveAccountUser` (or pass the entity into services) to avoid a second `SELECT` for the same user.
- **Socket.IO (`/agents`, `/consumers`):** After JWT validation (and namespace role rules), the server loads the user and rejects the handshake if status is `blocked` (**403**), aligned with HTTP. On `/consumers`, sensitive operations also revalidate active account status per event, so blocking the account after connection immediately stops new authorized operations. The socket may remain connected until disconnect/expiry, but operational permission no longer remains active.
- **Profile (`PATCH /auth/me`):** Authenticated users may set or clear `celular` (same validation as registration; `null` removes). **403** while `blocked`.
- **Change password:** **403** while `blocked`.

## Metrics (Prometheus)

- `plug_auth_login_blocked_total` — login attempts denied due to `blocked`.
- `plug_auth_refresh_blocked_total` — refresh denied due to `blocked`.
- `plug_auth_socket_blocked_total` — Socket.IO handshake attempts denied due to `blocked` (after valid JWT).
- `plug_admin_user_status_set_total` — successful admin status updates (block/unblock).
- `plug_rest_http_rate_limit_admin_user_status_rejected_total` — admin status PATCH rejected by rate limit.

## Client account status (`ClientStatus`)

Values: `pending`, `active`, `blocked`.

- **Register (`POST /client-auth/register`)**: creates `Client` in `pending` and sends owner approval flow.
- **Public validation (`POST /client-auth/register`)**: `ownerEmail` unavailable/inactive returns a generic **400** so the endpoint does not expose owner-account existence or status.
- **Approve (`POST /client-auth/registration/approve`)**: transitions `pending -> active`.
- **Reject (`POST /client-auth/registration/reject`)**: transitions `pending -> blocked`.
- **Owner governance (`PATCH /me/clients/:id/status`)**: only reviewed clients may change between `active` and `blocked`; `pending` must stay on the registration approval flow.
- **Login / refresh / protected routes / socket ops**: only `active` clients can operate.
