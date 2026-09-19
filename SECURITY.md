# Security Policy

## Supported versions

Please use the latest published version from npm.

## Reporting a vulnerability

If you find a potential security issue:

1. Use GitHub private vulnerability reporting:
   https://github.com/caizefan34/llm-keyrot/security/advisories/new
2. Include reproduction details and impact.
3. Do **not** include real API keys in reports.

We will investigate and coordinate a responsible fix and disclosure.

## Key handling guidance

- Never commit real API keys to git history.
- Prefer environment variables or your secret manager.
- Redact keys in logs, screenshots, and issue reports.
