#!/usr/bin/env python3
"""
Smoke test for two hub replicas + Redis agent presence / bridge forward.

Usage (after PM2 two-replica profile is up):
  python3 scripts/test_multi_replica_bridge.py
  python3 scripts/test_multi_replica_bridge.py --agent-id <uuid> --email admin@example.com --password '...'

Checks:
  1. Each port returns a distinct X-Hub-Instance-Id (plug-4000 / plug-4001).
  2. Optional: POST /api/v1/agents/commands on the "other" port does not return HTTP 404
     when the agent is online (requires valid admin JWT + connected agent).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

DEFAULT_PORTS = (4000, 4001)
DEFAULT_BASE = os.environ.get("PLUG_TEST_BASE_URL", "http://127.0.0.1")


def http_request(
    method: str,
    url: str,
    *,
    body: dict[str, Any] | None = None,
    token: str | None = None,
) -> tuple[int, dict[str, str], bytes]:
    headers: dict[str, str] = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data: bytes | None = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def check_hub_instances(ports: tuple[int, ...]) -> dict[int, str]:
    seen: dict[int, str] = {}
    for port in ports:
        status, headers, _ = http_request("GET", f"{DEFAULT_BASE}:{port}/api/v1/health")
        hub_id = headers.get("X-Hub-Instance-Id") or headers.get("x-hub-instance-id") or ""
        print(f"  :{port} health -> {status}, X-Hub-Instance-Id={hub_id!r}")
        if status != 200:
            print(f"    WARN: expected 200 from health on port {port}")
        seen[port] = hub_id
    return seen


def login(base_url: str, email: str, password: str) -> str:
    status, _, raw = http_request(
        "POST",
        f"{base_url}/api/v1/auth/login",
        body={"email": email, "password": password},
    )
    if status != 200:
        raise RuntimeError(f"login failed HTTP {status}: {raw.decode('utf-8', errors='replace')[:500]}")
    data = json.loads(raw.decode("utf-8"))
    token = data.get("data", {}).get("accessToken") or data.get("accessToken")
    if not token:
        raise RuntimeError(f"login response missing accessToken: {data}")
    return str(token)


def probe_agent_command(
    base_url: str,
    token: str,
    agent_id: str,
    *,
    label: str,
) -> int:
    payload = {
        "agentId": agent_id,
        "command": {
            "jsonrpc": "2.0",
            "id": "multi-replica-probe",
            "method": "agent.getHealth",
            "params": {},
        },
        "timeoutMs": 10_000,
    }
    status, _, raw = http_request(
        "POST",
        f"{base_url}/api/v1/agents/commands",
        body=payload,
        token=token,
    )
    snippet = raw.decode("utf-8", errors="replace")[:300]
    print(f"  {label} POST /agents/commands -> HTTP {status} body[:300]={snippet!r}")
    return status


def main() -> int:
    parser = argparse.ArgumentParser(description="Two-replica bridge smoke test")
    parser.add_argument("--ports", default="4000,4001", help="Comma-separated hub ports")
    parser.add_argument("--agent-id", default=os.environ.get("PLUG_TEST_AGENT_ID", "").strip())
    parser.add_argument("--email", default=os.environ.get("PLUG_TEST_ADMIN_EMAIL", "").strip())
    parser.add_argument("--password", default=os.environ.get("PLUG_TEST_ADMIN_PASSWORD", "").strip())
    args = parser.parse_args()
    ports = tuple(int(p.strip()) for p in args.ports.split(",") if p.strip())

    print("=== 1. Distinct hub instance ids ===")
    seen = check_hub_instances(ports)
    hub_values = [v for v in seen.values() if v]
    if len(ports) >= 2 and len(set(hub_values)) < 2:
        print("FAIL: expected different X-Hub-Instance-Id per port")
        return 1
    print("OK: each replica exposes its hub instance id\n")

    if not args.agent_id or not args.email or not args.password:
        print(
            "=== 2. Agent command probe (skipped) ===\n"
            "Set --agent-id, --email, --password (or PLUG_TEST_* env) to verify bridge forward vs 404.\n"
            "Ensure plug_agente is connected, then run again.",
        )
        return 0

    print("=== 2. Agent command on each replica (same agentId) ===")
    token = login(f"{DEFAULT_BASE}:{ports[0]}", args.email, args.password)
    statuses: list[int] = []
    for port in ports:
        statuses.append(
            probe_agent_command(
                f"{DEFAULT_BASE}:{port}",
                token,
                args.agent_id,
                label=f":{port}",
            ),
        )

    if any(s == 404 for s in statuses):
        print("\nFAIL: got HTTP 404 on at least one replica (bridge/presence may be down or agent offline)")
        return 1
    if all(s in (200, 503) for s in statuses):
        print("\nOK: no 404 on either replica (200 success or 503 timeout/offline is acceptable)")
        return 0

    print(f"\nWARN: unexpected status codes: {statuses}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
