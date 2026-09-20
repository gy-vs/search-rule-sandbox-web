# Search Rule Workbench

Local workbench for editing search rules — query rewrites, pinned results and
demotions — and dry-running them against sample queries before saving. Rules
only apply to experiment traffic; production search is never affected.

Run `npm install`, then `npm run dev` (client on :4173, API on :4174).
`npm test` runs the rule-engine and API tests; `npm run build` type-checks
everything.

## Rule model

Each experiment holds `rules` and `samples` behind a `revision` used for
optimistic concurrency on save.

- **rewrite** — `exact` / `prefix` / `regex` matcher, `replacement` supports
  `$1..$9` for regex groups. After every rewrite, matching restarts from the
  top of the compiled order (a rewrite can enable higher-priority rules).
- **pin** — lifts doc ids to the top of the result list, in rule order.
- **demote** — multiplies matching docs' scores by `demoteFactor`.

Rules carry a `priority` and a `/`-separated `scope` (`all` matches
everything; `web` covers `web/mobile`). Evaluation order: priority desc,
narrower scope first, then exact > prefix > regex, then rule id.

## Compile-time diagnostics

`POST /api/experiments/:id/simulate` compiles the posted draft and reports:

- `invalid_regex` — rule excluded from simulation
- `unreachable` — shadowed by an identical matcher evaluated earlier
- `override_conflict` — equal priority + identical matcher, different rewrite
- `rewrite_loop` — exact rewrites forming a cycle (also capped at runtime:
  the sample fails with `rewrite_loop_exceeded` after 8 iterations)
- `duplicate_effect` — redundant pin/demote

Every sample is simulated independently and returns its final query, the
ranked docs, and a decision chain of rule events — a failing sample never
aborts the rest of the batch.

## Draft binding

The client hashes the draft (`src/shared/drafthash.ts`, FNV-1a over canonical
JSON) and sends it as `draftHash`. The server recomputes the hash over the
received rules/samples and answers `409 draft_hash_mismatch` on divergence,
so results from an older draft can never be attached to a newer one. The UI
additionally greys out results whose hash no longer matches the editor.
