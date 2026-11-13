# Security Policy

GAK stores provider API keys and issues gateway keys, so a vulnerability here can leak
credentials. Please report privately — **do not open a public issue** for a security bug.

## Reporting a vulnerability

Use GitHub's private reporting channel:

1. Open the **Security** tab of this repository.
2. Choose **Report a vulnerability** (GitHub Security Advisories).

That keeps the report visible only to the maintainers. Include:

- the affected version or commit,
- the exact request / configuration needed to reproduce it,
- what an attacker gains (key disclosure, auth bypass, SSRF, RCE, …),
- and, if you have one, a suggested fix.

**Never include a real API key in a report.** Use a revoked or fabricated key
(`sk-test-…`) and redact anything that came from your own `.env` or `data/gateway.db`.

You can expect an acknowledgement within a few days. Once a fix is released the advisory
is published with credit unless you ask to stay anonymous.

## Supported versions

The project is pre-1.x in practice: only the latest `master` is supported. Fixes land
there first; there are no backport branches.

## In scope

- Authentication or authorization bypass on `/api/*` (including `ADMIN_TOKEN` cookie flow)
- Disclosure of provider keys, client (GAK) keys, or the local credential key
- SSRF through a provider `baseUrl` (see `server/services/url-guard.ts`)
- XSS / CSP bypass in the dashboard
- Request smuggling, path traversal, or unbounded resource use on `/v1/*`
- Anything that lets a client key reach a provider it was not scoped to

## Out of scope

- Missing rate limits on a deployment you exposed to the internet yourself
- Findings that require `ADMIN_TOKEN` to be empty **and** the server bound to `0.0.0.0`
  (the server refuses to start in that combination by design)
- Vulnerabilities in upstream providers or in a model's output
- Reports produced only by a scanner with no demonstrated impact

## Hardening checklist for operators

A default install binds to `127.0.0.1` with no `ADMIN_TOKEN`. Before exposing it:

| Setting | Why |
|---|---|
| `ADMIN_TOKEN` | Otherwise anyone who reaches the port can read and delete your providers |
| `HOST=127.0.0.1` (default) | Only set `0.0.0.0` behind a proxy you control |
| `TRUST_PROXY=1` | Otherwise rate limits key on the proxy IP and every client shares one bucket |
| `ALLOW_PRIVATE_HOSTS` | Leave empty in production; it is what permits localhost provider URLs |
| `data/` permissions | `data/gateway.db` and `data/.credkey` are the whole secret store — back them up, never commit them |

`data/`, `.env`, `*.db`, `*.key`, `*.pem` and the credential key are gitignored, and CI runs
`gitleaks` over the full history on every push.
