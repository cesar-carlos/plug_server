-- PostgreSQL performance tuning for plug_server
-- Target host: ~16 GB RAM, 4 cores, SSD, shared with other services (n8n, etc.).
--
-- This file has two parts:
--   PART A (ALTER DATABASE): per-database planner / memory defaults. No superuser
--           needed (the `plug_server` role owns the `plug_server` database). Takes
--           effect on NEW connections. Already applied by the agent on 2026-05-29.
--   PART B (ALTER SYSTEM):  cluster-wide postmaster settings. Requires a SUPERUSER
--           (e.g. `postgres`) and a cluster RESTART for shared_buffers/max_connections.
--
-- Rollback: replace SET with RESET (e.g. `ALTER DATABASE plug_server RESET work_mem;`
--           or `ALTER SYSTEM RESET shared_buffers;`).

-- =====================================================================
-- PART A — per-database (run as the `plug_server` owner; no restart)
--   psql "postgresql://plug_server:***@127.0.0.1:5432/plug_server" -f tuning.sql
-- =====================================================================
ALTER DATABASE plug_server SET work_mem = '16MB';
ALTER DATABASE plug_server SET maintenance_work_mem = '256MB';
ALTER DATABASE plug_server SET effective_cache_size = '6GB';
ALTER DATABASE plug_server SET random_page_cost = 1.1;
ALTER DATABASE plug_server SET effective_io_concurrency = 200;

-- =====================================================================
-- PART B — cluster-wide (run as SUPERUSER, then reload + restart)
--   sudo -u postgres psql -c "ALTER SYSTEM SET ..."   (or run this block as postgres)
--
-- shared_buffers and max_connections are postmaster context: they only take
-- effect after `systemctl restart postgresql@16-main`.
-- The rest are sighup context: `SELECT pg_reload_conf();` is enough.
-- =====================================================================
-- ALTER SYSTEM SET shared_buffers = '2GB';                 -- restart required
-- ALTER SYSTEM SET max_connections = 200;                  -- restart required
-- ALTER SYSTEM SET wal_buffers = '16MB';                   -- restart required
-- ALTER SYSTEM SET effective_cache_size = '6GB';
-- ALTER SYSTEM SET maintenance_work_mem = '512MB';
-- ALTER SYSTEM SET max_wal_size = '2GB';
-- ALTER SYSTEM SET min_wal_size = '512MB';
-- ALTER SYSTEM SET checkpoint_completion_target = 0.9;
-- ALTER SYSTEM SET random_page_cost = 1.1;
-- ALTER SYSTEM SET effective_io_concurrency = 200;
-- SELECT pg_reload_conf();
-- -- then, for shared_buffers / max_connections:
-- --   systemctl restart postgresql@16-main
