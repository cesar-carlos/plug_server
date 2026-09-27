#!/usr/bin/env python3
"""Post or update a PR comment with socket-bridge bench deltas."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

MARKER = "<!-- plug-server-socket-bridge-bench -->"


def read_report(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    report_path = Path(path)
    if not report_path.is_file():
        return None
    return json.loads(report_path.read_text(encoding="utf-8"))


def scenario_map(report: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if report is None:
        return {}
    scenarios = report.get("scenarios")
    if not isinstance(scenarios, list):
        return {}
    mapped: dict[str, dict[str, Any]] = {}
    for item in scenarios:
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            mapped[item["name"]] = item
    return mapped


def fmt_ms(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return "n/a"
    return f"{value:.3f}"


def fmt_rate(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return "n/a"
    return f"{value:.0f}"


def fmt_delta(head: Any, base: Any) -> str:
    if not isinstance(head, (int, float)) or not isinstance(base, (int, float)) or base == 0:
        return "--"
    ratio = (head - base) / base * 100
    sign = "+" if ratio > 0 else ""
    return f"{sign}{ratio:.1f}%"


def build_body(head: dict[str, Any], base: dict[str, Any] | None, outcome: str) -> str:
    head_scenarios = scenario_map(head)
    base_scenarios = scenario_map(base)
    names = list(head_scenarios.keys()) or list(base_scenarios.keys())
    rows = [
        "| Scenario | p95 (ms) | vs base | throughput/s | vs base |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    for name in names:
        current = head_scenarios.get(name, {})
        reference = base_scenarios.get(name, {})
        rows.append(
            "| {name} | {p95} | {p95_delta} | {tps} | {tps_delta} |".format(
                name=name,
                p95=fmt_ms(current.get("p95Ms")),
                p95_delta=fmt_delta(current.get("p95Ms"), reference.get("p95Ms")),
                tps=fmt_rate(current.get("throughputPerSec")),
                tps_delta=fmt_delta(
                    current.get("throughputPerSec"),
                    reference.get("throughputPerSec"),
                ),
            )
        )
    status = "passed" if outcome == "success" else outcome
    baseline_note = (
        "Compared with the PR base commit on the same runner."
        if base is not None
        else "No comparable base report; correctness-only run."
    )
    return "\n".join(
        [
            MARKER,
            "### Socket bridge bench",
            "",
            f"Job outcome: `{status}`. {baseline_note}",
            "On pull requests this job is informational (noisy GitHub runners); `main` still gates.",
            "",
            *rows,
            "",
        ]
    )


def api_request(method: str, url: str, token: str, payload: dict[str, Any] | None = None) -> Any:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "plug-server-ci-bench-comment",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API {method} {url} failed: {error.code} {detail}") from error


def main() -> int:
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    pr_number = os.environ.get("PR_NUMBER", "").strip()
    head_path = os.environ.get("BENCH_HEAD_PATH", "").strip()
    base_path = (
        os.environ.get("BENCH_BASE_PATH", "").strip()
        or os.environ.get("SOCKET_BRIDGE_BENCH_BASELINE_PATH", "").strip()
        or None
    )
    outcome = os.environ.get("BENCH_OUTCOME", "unknown").strip() or "unknown"

    if not token or not repository or not pr_number:
        print("GITHUB_TOKEN, GITHUB_REPOSITORY, and PR_NUMBER are required", file=sys.stderr)
        return 1

    head = read_report(head_path)
    if head is None:
        print(f"bench report not found: {head_path}", file=sys.stderr)
        return 1

    body = build_body(head, read_report(base_path), outcome)
    comments_url = f"https://api.github.com/repos/{repository}/issues/{pr_number}/comments"
    comments = api_request("GET", f"{comments_url}?per_page=100", token)
    existing_id = None
    if isinstance(comments, list):
        for comment in comments:
            if isinstance(comment, dict) and str(comment.get("body", "")).startswith(MARKER):
                existing_id = comment.get("id")
                break

    if existing_id is not None:
        api_request(
            "PATCH",
            f"https://api.github.com/repos/{repository}/issues/comments/{existing_id}",
            token,
            {"body": body},
        )
        print(f"updated bench comment {existing_id}")
        return 0

    api_request("POST", comments_url, token, {"body": body})
    print("created bench comment")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
