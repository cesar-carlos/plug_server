#!/usr/bin/env python3
"""
Testa o retorno do agente quando client_token está errado.

Uso:
    python scripts/test_agent_wrong_token.py

Com token direto:
    ACCESS_TOKEN=seu_token python scripts/test_agent_wrong_token.py

Com login:
    TEST_EMAIL=seu@email.com TEST_PASSWORD=SuaSenha123 python scripts/test_agent_wrong_token.py
"""

import json
import os
import sys
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3002/api/v1")


def request(method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    url = f"{BASE_URL.rstrip('/')}/{path.lstrip('/')}"
    data = json.dumps(body).encode("utf-8") if body else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = Request(url, data=data, headers=headers, method=method)
    with urlopen(req) as resp:
        return resp.status, json.loads(resp.read().decode())


def request_raw(method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, str]:
    url = f"{BASE_URL.rstrip('/')}/{path.lstrip('/')}"
    data = json.dumps(body).encode("utf-8") if body else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req) as resp:
            return resp.status, resp.read().decode()
    except HTTPError as e:
        body = e.read().decode() if e.fp else ""
        return e.code, body


def main() -> int:
    token = os.environ.get("ACCESS_TOKEN")

    if not token and os.environ.get("TEST_EMAIL") and os.environ.get("TEST_PASSWORD"):
        print("=== 1. Login para obter token ===")
        try:
            status, body = request_raw(
                "POST",
                "auth/login",
                body={
                    "email": os.environ["TEST_EMAIL"],
                    "password": os.environ["TEST_PASSWORD"],
                },
            )
            if status != 200:
                print(f"Login falhou: {status} - {body}")
                return 1
            data = json.loads(body)
            token = data.get("accessToken")
            if not token:
                print("Resposta sem accessToken:", data)
                return 1
            print("Token obtido com sucesso")
        except Exception as e:
            print(f"Login falhou: {e}")
            return 1
    elif not token:
        print("Defina ACCESS_TOKEN ou TEST_EMAIL+TEST_PASSWORD")
        return 1

    print("\n=== 2. POST /agents/commands com client_token errado ===")
    payload = {
        "agentId": "3183a9f2-429b-46d6-a339-3580e5e5cb31",
        "timeoutMs": 15000,
        "pagination": {
            "page": 1,
            "pageSize": 100,
            "cursor": "eyJ2IjoyLCJwYWdlIjoyfQ",
        },
        "command": {
            "jsonrpc": "2.0",
            "method": "sql.execute",
            "id": "req-123",
            "params": {
                "sql": "SELECT 1",
                "client_token": "1773500889073537_c75955",
                "options": {"page": 1, "page_size": 100},
            },
        },
    }

    try:
        status, body = request_raw("POST", "agents/commands", body=payload, token=token)
        print(f"Status: {status}")
        try:
            parsed = json.loads(body)
            print("Resposta:", json.dumps(parsed, indent=2, ensure_ascii=False))
        except json.JSONDecodeError:
            print("Body:", body)
    except Exception as e:
        print(f"Erro: {e}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
