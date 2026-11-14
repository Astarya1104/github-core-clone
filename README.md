# GitHub-compatible git forge (make.fun github-core-clone-01)

One Node 22 process, stdlib only, no git binary, no network beyond the trial
env. It serves a GitHub-compatible forge from its own in-memory store:

- git smart HTTP at `/{owner}/{repo}.git`: upload-pack protocol v2 (plus a v0
  fallback) and receive-pack v0 with report-status, side-band-64k and
  delete-refs. Fast-forward only; a non-fast-forward update is refused
  per-ref while the other refs still apply.
- REST v3 at `/api/v3`: root, meta, user/repos (Link pagination), repos CRUD,
  contents (real git commits behind every write), labels, issues, pulls and
  squash merges onto the default branch.
- GraphQL v4 at `/api/graphql`: introspection, repository fields, issue/PR
  connections with cursor pagination, node lookup, and the create/close/merge
  mutations.
- MCP at `/mcp`: JSON-RPC 2.0 Streamable HTTP, modern era (2026-07-28
  discover), six tools sharing the same store as REST.

Lifecycle (`main.ts`, kept as the starter ships it): bind an ephemeral port,
register it with `$MAKEFUN_ENV_URL`, poll `/done` until the trial ends, exit 0.

Determinism: every state-affecting timestamp comes from `MAKEFUN_TRIAL_NOW`
(or the fixed scenario epoch); ids and numbers are sequential counters; the
object store is content-addressed, so replaying a trial produces identical
state.

## Files

- `main.ts` — entry lifecycle (starter, unchanged).
- `app.ts` — HTTP server: routing, auth, request ids.
- `store.ts` — in-memory store, git object model, pack codec, pkt-lines.
- `git.ts` — smart HTTP handlers.
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL parser + executor.
- `mcp.ts` — MCP tools.
