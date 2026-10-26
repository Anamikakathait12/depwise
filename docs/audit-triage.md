# Dependency audit triage

Audit date: 2026-10-26. The baseline `npm audit` reported 12 vulnerable package entries: 2 runtime and 10 development-only. Fastify and Zod were upgraded in this change. The post-upgrade `npm audit --omit=dev` reports zero findings; the post-upgrade full audit reports 10 dev-only findings.

“Reachable” describes exposure at the baseline vulnerable versions, before the two runtime fixes in this pass. It refers to whether the affected behavior appears to be exercised by this repository's current application or development commands. `Unknown` means the dependency is used, but the specific vulnerable path has not been established.

| Package (baseline version) | Severity | Runtime or dev-only | Reachable in our usage | Action |
| --- | --- | --- | --- | --- |
| `fastify` (5.2.0) | High | Runtime | Yes — the API uses Fastify to serve HTTP routes. | Fixed: pin 5.12.7. |
| `zod` (3.24.1) | High | Runtime | Yes — lockfile and OSV input schemas call Zod validation. | Fixed: pin 4.6.7 in core and advisory. |
| `@eslint/plugin-kit` | Low | Dev-only | Unknown — ESLint runs over source comments, but the affected regex path has not been reproduced with this repository's input. | Track for Phase 10; leave dev tools unchanged in this pass. |
| `eslint` (9.17.0) | Low | Dev-only | Unknown — `npm run lint` runs ESLint; its reported vulnerable path is through `@eslint/plugin-kit`. | Track for Phase 10; leave dev tools unchanged in this pass. |
| `@vitest/mocker` | Moderate | Dev-only | No — tests use `vi.spyOn`, not redirect mocks or unauthenticated mock registration. | Track for Phase 10; leave dev tools unchanged in this pass. |
| `esbuild` | Moderate | Dev-only | No — the audit finding concerns its `serve` development server, which this repository does not start. | Track for Phase 10; leave dev tools unchanged in this pass. |
| `glob` | High | Dev-only | No — the finding is in the `glob -c/--cmd` CLI option; the migration script does not invoke that option. | Track for Phase 10; leave dev tools unchanged in this pass. |
| `node-pg-migrate` (7.9.0) | High | Dev-only | No — migrations use the runner, while the transitive `glob` finding concerns its separate command-execution CLI option. | Track for Phase 10; leave dev tools unchanged in this pass. |
| `tinypool` | Critical | Dev-only | Unknown — Vitest uses its worker pool, but the reported prototype-polluted worker options are not user-controlled in the current test command. | Track for Phase 10; leave dev tools unchanged in this pass. |
| `vite` | High | Dev-only | Unknown — it is part of the Vitest toolchain; the reported findings include server behavior not explicitly enabled by this repository. | Track for Phase 10; leave dev tools unchanged in this pass. |
| `vite-node` | Moderate | Dev-only | Unknown — Vitest uses it to run tests, but the affected Vite server paths have not been established as reachable here. | Track for Phase 10; leave dev tools unchanged in this pass. |
| `vitest` (2.1.8) | Critical | Dev-only | Unknown — `vitest run` is used; UI/browser server advisories are not enabled, while its worker dependency needs separate review. | Track for Phase 10; do not downgrade or upgrade Vitest in this pass. |

The baseline had these reported severities: 2 low, 3 moderate, 5 high, and 2 critical. All ten remaining entries are development dependencies and are tracked for Phase 10.
