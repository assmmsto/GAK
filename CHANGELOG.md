# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-11-13

### Added

- **Unified API surface** — OpenAI-compatible endpoints (`/v1/chat/completions`,
  `/v1/models`, `/v1/embeddings`) and an Anthropic-compatible endpoint (`/v1/messages`)
  so existing SDKs and coding agents work without changes.
- **Multi-key providers** — any number of keys per provider, each with its own quota
  window and state; a rate-limited or invalid key is parked on its own while the next
  key is tried immediately.
- **Automatic failover** at two levels (key → provider) with a per-request deadline,
  per-provider concurrency ceiling and exponential backoff.
- **Probe engine** — every model is verified with a real chat call; unsupported or dead
  models are classified, hidden from routing and re-tested automatically.
- **Provider catalog** — 38 ready presets with one-click setup, bulk key import by
  key-prefix detection, and a per-provider model allow-list.
- **Key supervision agents** — hierarchical secret synchronisation
  (HashiCorp Vault · Doppler · 1Password Connect · local file · environment), circuit
  breakers, and a full audit trail of every key change.
- **Token-saving controls** — response cache, old tool-output trimming, context window
  and a hard `max_tokens` ceiling, all persisted per deployment.
- **Dashboard** — live health, provider and key management, model sorting, usage
  statistics, event log and a streaming chat playground (React + Vite + Tailwind).
- **Runtime guardrails** — SSRF-safe provider URLs (with DNS pinning), request and probe
  rate limiting, JSON error contract, graceful shutdown and startup refusal when the
  server would be exposed without an admin token.

### Security

- Provider credentials are encrypted at rest with AES-256-GCM in SQLite; client
  (gateway) keys are stored only as SHA-256 hashes and shown once at creation.
- Admin access uses a timing-safe token comparison and an `HttpOnly`, `SameSite=Strict`
  cookie; no secret is kept in page-readable storage.
- A strict Content-Security-Policy, `X-Frame-Options`, `nosniff` and `no-referrer` are
  sent on every response.
- CI runs full-history secret scanning (gitleaks) in addition to type-checking, the
  regression guard suite and the production build.

[1.0.1]: https://github.com/assmmsto/GAK/releases/tag/v1.0.1