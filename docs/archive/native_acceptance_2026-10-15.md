# Evidências históricas de aceitação nativa — 15/10/2026

Registro preservado da documentação REST. As seções abaixo descrevem execuções e
pendências naquela data; não representam o estado atual dos gates nem autorizam
publicação. Consulte a [matriz de sincronização](../plug_agente/communication_sync_plug_agente.md)
e as [decisões de publicação](../README.md#decisões-de-publicação-e-segurança).
O contrato HTTP permanece no [guia REST](../api/api_rest_bridge.md).

## Direct agent recovery with real ODBC (2026-10-15)

The opt-in `vitest.sql-recovery.config.mjs` runs the direct Socket.IO recovery
harness without global HTTP/Prisma setup or checkout dotenv loading. Set
`RUN_DART_SQL_OPERATION_TRANSPORT=true`, `FLUTTER_BIN` and
`PLUG_SQL_OPERATION_NATIVE_MANIFEST` to an isolated three-engine fixture manifest;
include the private PostgreSQL driver and SQL Anywhere Bin64 in PATH.
Without the native manifest it runs the synthetic regression instead.

Six real-ODBC cases passed: PostgreSQL, SQL Server and SQL Anywhere, each with
abrupt agent-process exit before commit and after native commit but before
journal completion. The hub returns non-retryable unknown outcome. Restarted
get/duplicate execute/cancel preserve the same unknown receipt and null count;
the agent verifies zero physical rows before commit, one after commit, and zero
reopened transactions. The fixture uses fixed test authority, not Client approval
or least-privilege acceptance. Native in-flight commit interruption, power loss,
production bootstrap and remaining coordinated gates are still pending.
Production release remains blocked. No MCP implementation is involved in this test.

## Native commit in flight, restricted login and desktop bootstrap (2026-10-15)

The direct recovery matrix now passes nine real-ODBC cases (three engines times
before/after/in-flight commit). In-flight testing uses a private loopback TCP
proxy: after the pre-commit barrier, native request bytes reach the database and
server bytes are withheld. The controller proves no native-call return, then
kills only its owned agent tree. Recovery returns the same unknown receipt and
null count with no reopened transaction; independent physical verification sees
zero rows before commit and one after commit/withheld confirmation. This covers
an ODBC call awaiting confirmation, not server power loss or all storage windows.

Each native case uses SELECT/INSERT on one exact fixture table plus required
identity metadata access. UPDATE/DELETE, DDL, unrelated data and insertion after
REVOKE are refused by the actual engines. Provisioning/observation use only the
private DBA fixture. Client/transport authorization remains separate chain evidence.

The explicit vitest.desktop-bootstrap.config.mjs, with
RUN_NATIVE_DESKTOP_BOOTSTRAP=true, launches the agent debug target
 tool/homologation/desktop_bootstrap_fixture.dart from its staged complete bundle
at build/homologation/desktop-bootstrap. Both cold startup and restart passed:
real AppInitializer/DI, native window/tray and AppRoot first frame, DPAPI roundtrip,
SQLite integrity/journal, default-disabled SQL operations, ready negotiation,
rpc.discover and clean shutdown. Installation identity persists; boot identity
changes. Ready-file publication is atomic and RPC waits for agent:ready.

Paths point exclusively to temporary data/support/documents; the default production
storage resolver remains unchanged unless explicitly injected by the fixture.
The existing --installation-check native mode allows coexistence with the running
installed app. Machine auto-start repair, notifications and updater registrations
are locally excluded because they share that app's OS identity. Installer startup
with configured credentials, system integrations, power loss and coordinated
release gates remain pending. Production installer/appcast remain blocked.

Validation: nine native cases, 61 agent bootstrap/journal tests, native desktop
cold/restart integration, synthetic recovery, Dart analysis, server lint and type
checks. The private database fixture and temporary app profiles were removed.

## Configured native desktop acceptance (2026-10-15)

The opt-in desktop runner now also includes
`configured_desktop_bootstrap.integration.test.ts`. It uses the production test
server with real registration approval, owner binding, agent login, refresh and
Socket.IO ready negotiation. The Windows debug target runs AppInitializer/AppRoot,
real repositories and DPAPI in an exclusive temporary profile. Cold boot and restart
both restore/rotate the Hub session automatically; restart receives no bootstrap
credential seed or credential environment. Stable config/installation identity and
new boot identity are checked; SQL operations remain disabled and SQLite metadata
contains no raw credentials. The configured ODBC target is deliberately offline;
Hub auto-connect succeeds after native pool warm-up fails. This does not replace
the three-engine native ODBC matrix or durable hub restart acceptance.

Both native desktop cases passed, alongside 29 agent bootstrap/session regressions,
four real temporary HKCU adapter tests, 31 installer/repair tests and the approved
real-host optional repair. The repair corrected inheritance of updater authorization
when /AUTOUPDATE=0; the accepted run preserved updater policy/binaries, profile,
vault, app EXEs, startup/protocol registrations and authorization. Non-elevated data
access passed. Server source/test lint and TypeScript test checks passed. Temporary
profiles/Run entries were removed; real-host backups remain private and local.
Full installer lifecycle, shell activation, notifications, updater migration/recovery,
signing and remaining coordinated gates are still pending. Production stays blocked.

## Native Windows integrations follow-up — 2026-10-15

The native desktop test now accepts RUN_NATIVE_WINDOWS_NOTIFICATIONS=true to
exercise production NotificationService with an exclusive AppUserModelId/GUID.
Cold/restart passed registration, show/cancel calls, activator registry binding,
normal RPC readiness/discovery and cleanup of temporary notification keys.
Production identity defaults are unchanged. This is API/registry acceptance, not
visual delivery, notification-click, Windows logon or protocol-shell acceptance.
The agent's isolated installer/service lifecycle and recovery-contract-2 IPC
correction are documented in its updater plan; no REST or business RPC changed.
All production and coordinated release gates stay blocked.
