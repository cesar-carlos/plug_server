# Claude Code Entry Point

This repository keeps its authoritative coding and project rules in `./.cursor/rules`.

Do not recreate or paraphrase those rules here unless the project explicitly decides to migrate them.
Use this file as the entry point and load the rule set from `./.cursor/rules` before making changes.

## Rule source

- Primary rule directory: `./.cursor/rules`
- Rule governance and precedence: `./.cursor/rules/governance.mdc`

If `CLAUDE.md` and files in `./.cursor/rules` ever diverge, follow `./.cursor/rules` as the source of truth.

## How to read the rules

Read `./.cursor/rules/governance.mdc` first.

Then apply the relevant rules from these groups:

- Universal rules: general engineering, domain, testing, and governance guidance
- Stack-specific rules: TypeScript, Node.js performance, Express, WebSocket, security, and chosen libraries
- Project-specific rules: architecture and repository structure for this codebase

## Quick routing

- HTTP and REST work: `./.cursor/rules/express_api.mdc`
- WebSocket and Socket.IO work: `./.cursor/rules/websocket_api.mdc`
- TypeScript typing and language usage: `./.cursor/rules/typescript.mdc`
- Security-sensitive changes: `./.cursor/rules/security.mdc`
- Architecture and layer boundaries: `./.cursor/rules/architecture.mdc`, `./.cursor/rules/domain_layer.mdc`, `./.cursor/rules/project_structure.mdc`
- Performance-sensitive runtime changes: `./.cursor/rules/performance.mdc`
- Testing expectations: `./.cursor/rules/testing.mdc`

## Expected behavior

- Treat `./.cursor/rules` as the source of truth for coding, architecture, testing, verification, and project workflow.
- When rules overlap or appear to conflict, follow the precedence defined in `./.cursor/rules/governance.mdc`.
- Prefer referencing the existing rule files over duplicating instructions in new files.
- Do not rewrite the rule set into this file unless the project intentionally migrates away from `./.cursor/rules`.
