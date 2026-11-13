# Contributing to GAK

Thanks for taking the time to contribute. This project is a single-process Node/TypeScript
gateway plus a React dashboard — small enough that a clear, tested patch is worth more than
a large speculative one.

## Getting set up

```bash
npm install
cp .env.example .env      # optional; the gateway runs with defaults
npm run dev               # API on :3001, UI on :5173
```

Node 20 or newer (`engines` in `package.json`).

## Before you open a pull request

Run the same gate CI runs:

```bash
npm run lint      # tsc -b, no emit
npm test          # offline guards: security, crypto, modules, agents, routing, web
npm run build     # production build must succeed
```

If your change touches HTTP routes, the UI, or key handling, also run the relevant
integration suite — see the **Testing** section of the README. Suites that need a live
server expect one on `http://127.0.0.1:3001` (override with `GATEWAY_URL`).

A pull request that changes behaviour should:

- add or update a check in `tests/` that **fails before** the fix and passes after,
- add an entry under the unreleased heading in `CHANGELOG.md`,
- record any non-obvious architectural decision in `DECISIONS.md` — the format there is
  *what we decided, why, and which alternative we rejected*.

## Conventions

- **Never commit secrets.** Provider keys live in `data/gateway.db`, not in `.env`, not in
  `providers.yaml`, not in a test fixture. Use obviously fake values (`sk-test-…`).
  `gitleaks` runs over the full history in CI, so a key that lands in a commit is
  compromised even if you delete it in the next one.
- **Commit messages** use a conventional prefix, with the subject in Arabic or English —
  both are already in the history: `fix(gateway): …`, `docs: …`, `chore: …`.
- **Language.** `README.md` and `SECURITY.md` are English (public entry points).
  `DECISIONS.md`, `CHANGELOG.md`, `RUN-GUIDE.md` and the UI are Arabic. Match the file
  you are editing rather than translating it.
- **Fail closed.** When a check cannot decide (DNS lookup fails, database unreachable),
  deny the request. Several past bugs were "the guard opened on error" — see `DECISIONS.md`
  entries D-17 and D-19.
- **No new dependencies** without a reason in the pull request. The runtime surface is
  deliberately small (Express, ws, undici, libsql, yaml).

## Reporting bugs

Open an issue with the version/commit, the steps to reproduce, and what you expected.
Redact keys, tokens and anything from `data/`. Security issues go through
[SECURITY.md](SECURITY.md) instead — not the public tracker.
