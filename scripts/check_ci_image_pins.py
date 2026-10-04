#!/usr/bin/env python3
"""Ensure production and CI pin the same Node, Postgres, and Redis images."""

from __future__ import annotations

import re
import sys
from pathlib import Path

SHA256_REF = re.compile(r"^(.+)@sha256:([0-9a-f]{64})$")
FROM_NODE = re.compile(r"^FROM\s+(node:\S+)", re.MULTILINE)
IMAGE_LINE = re.compile(r"^[ \t]*image:\s*(\S+)", re.MULTILINE)


def image_pin_problems(root: Path) -> list[str]:
    """Return human-readable pin mismatches. An empty list means the tree agrees."""
    problems: list[str] = []
    nvmrc_path = root / ".nvmrc"
    dockerfile_path = root / "Dockerfile"
    compose_path = root / "docker-compose.yml"
    ci_path = root / ".github" / "workflows" / "ci.yml"

    for path in (nvmrc_path, dockerfile_path, compose_path, ci_path):
        if not path.is_file():
            problems.append(f"missing {path.relative_to(root)}")
    if problems:
        return problems

    node_version = nvmrc_path.read_text(encoding="utf-8").splitlines()[0].strip()
    expected_node = f"node:{node_version}-alpine"
    node_refs = FROM_NODE.findall(dockerfile_path.read_text(encoding="utf-8"))
    if not node_refs:
        problems.append("Dockerfile has no FROM node stage")

    digests: set[str] = set()
    for ref in node_refs:
        match = SHA256_REF.fullmatch(ref)
        if match is None or match.group(1) != expected_node:
            problems.append(
                f"Dockerfile stage {ref} must be {expected_node}@sha256:<64 hex> to match .nvmrc"
            )
            continue
        digests.add(match.group(2))
    if len(digests) > 1:
        problems.append("Dockerfile Node stages use different digests")

    ci_text = ci_path.read_text(encoding="utf-8")
    compose_text = compose_path.read_text(encoding="utf-8")
    for name in ("postgres", "redis"):
        ci_refs = _service_refs(ci_text, name)
        compose_refs = _service_refs(compose_text, name)
        if len(ci_refs) != 1:
            problems.append(f"ci.yml must pin exactly one {name} image, found {sorted(ci_refs)}")
        if len(compose_refs) != 1:
            problems.append(
                f"docker-compose.yml must pin exactly one {name} image, found {sorted(compose_refs)}"
            )
        if ci_refs != compose_refs:
            problems.append(
                f"{name} image pin differs: ci.yml={sorted(ci_refs)} docker-compose.yml={sorted(compose_refs)}"
            )
        for ref in ci_refs | compose_refs:
            if SHA256_REF.fullmatch(ref) is None:
                problems.append(f"{name} image must be tag@sha256:<64 hex>, found {ref}")
    return problems


def _service_refs(text: str, name: str) -> set[str]:
    prefix = f"{name}:"
    return {ref for ref in IMAGE_LINE.findall(text) if ref.startswith(prefix)}


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    root = Path(args[0]).resolve() if args else Path(__file__).resolve().parents[1]
    problems = image_pin_problems(root)
    if problems:
        for problem in problems:
            print(problem, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
