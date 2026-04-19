import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The deployed `.env` of this repo points `UPLOADS_DIR` at an absolute path
 * outside the workspace (e.g. `/var/lib/plug_server/uploads`, used in
 * production behind nginx alias). Tests must not depend on that operator
 * choice — both for sandboxed runs (where writes outside the workspace fail
 * with `EACCES`) and for clean isolation between repos.
 *
 * Force a per-process temp directory before `env.ts` Zod-parses `process.env`.
 * The OS reclaims `os.tmpdir()` content on its own schedule, so no extra
 * cleanup is wired here. Keeps the override deterministic regardless of
 * whatever `.env` the operator has in place locally.
 */
const uploadsDir = path.join(tmpdir(), `plug_server_test_uploads_${process.pid}`);
mkdirSync(uploadsDir, { recursive: true });
process.env.UPLOADS_DIR = uploadsDir;
