# Depwise

Depwise (npm Alert Triage) takes a `package-lock.json` and optional source code to help developers assess which npm vulnerability alerts are exploitable in their usage, with cited evidence. It is an LLM-assisted pipeline, not an autonomous agent. The scanner, retrieval, and LLM judge in Phases 5–7 are not built yet.

## Status

Phases 0–3 are done. Latest `npm test`: **7 files passed, 39 tests passed**.

| Phase | Work | Status |
| --- | --- | --- |
| 0 | Brief | Done |
| 1 | Scaffold + DB | Done |
| 2 | Lockfile + graph | Done |
| 3 | OSV ingestion + matching | Done |
| 4 | Dev/prod classification | Next |
| 5 | AST scanner | Planned; not built |
| 6 | Hybrid retrieval | Planned; not built |
| 7 | LLM judge | Planned; not built |
| 8 | Queue + cache | Planned |
| 9 | API + auth + dashboard | Planned |
| 10 | Security hardening | Planned |
| 11 | Evaluation harness | Planned |
| 12 | Load test + cost | Planned |

## Quickstart

The project requires Node 20 (`.nvmrc`). Docker Compose runs PostgreSQL 16 with pgvector on `127.0.0.1:5433`.

**Windows (PowerShell)**

```powershell
copy .env.example .env
docker compose up -d
docker compose ps
npm ci
npm test
```

**Linux**

```sh
cp .env.example .env
docker compose up -d
docker compose ps
npm ci
npm test
```

Confirm `docker compose ps` reports the Postgres service as healthy. `npm test` runs typecheck, migrations, then Vitest. The node-pg-migrate “Can't determine timestamp” warnings are harmless.

## Repository layout

```text
apps/api/             Fastify HTTP API
packages/core/        Lockfile parsing and shared types
packages/storage/     PostgreSQL client, migrations, and SQL
packages/advisory/    OSV parsing, ingestion, and matching
fixtures/             Lockfile, advisory, and labeled-alert fixtures
```

## Safety principles

- Use `needs_review` when evidence is thin.
- LLM output is untrusted and must pass Zod validation; it cannot trigger actions.
- Treat external input—including lockfiles, advisory text, and code comments—as hostile.

## Fixtures

- `fixtures/lockfiles/phase-2/` contains small synthetic graph lockfiles and `public-deconf.json`. The latter is a trimmed, minimized copy of the upstream `digitalinteraction/deconf` lockfile; its README describes its source and intended invariant-test use.
- `fixtures/advisories/` contains synthetic OSV-format cases and two public GHSA records. Its README lists the GitHub Advisory Database source URLs and notes that tests use local files without network calls.
- `fixtures/labeled-alerts/` is reserved for labeled alert fixtures.

## Known limitations

- npm only; intended code analysis is limited to direct imports and call-site matching, with no deep dataflow analysis. The scanner is not built yet.
- Runtime dependencies are clean (`npm audit --omit=dev` reports 0 findings); 10 dev-only audit findings are documented in `docs/audit-triage.md` and tracked for Phase 10.
