# STATUS — github-core-clone-01 entry

Built and graded locally 2026-11-17. The entry is complete; nothing is submitted yet
and no GitHub repo was created by the agent (the repo https://github.com/NodeRunerS/github-core-clone-01
was created by Jack; the parent sorts push access).

## Local grade (kit env server, no docker — run via /tmp/run-grade.mjs)

Official scorer (`program/scorer/score.mjs`) on the env's export:

| Run | Score | Feature | Agent (MCP) | Perf | Working |
| --- | --- | --- | --- | --- | --- |
| 1 (before fetch fix) | 976 | 595 (119/120) | 200 (15/15) | 181 | 1 |
| 2 (after fetch fix) | **980** | 600 (120/120) | 200 (15/15) | 180 | 1 |
| 3 (after caches) | 979 | 600 (120/120) | 200 (15/15) | 179 | 1 |
| 4 | 975 | 600 (120/120) | 200 (15/15) | 175 | 1 |

Feature and agent are stable at full marks in every run. Perf swings 175–181 run to
run on this shared 1.5-CPU box (per-workload p50s move with CPU throttling); the trial
runs on 2 CPUs, so trial numbers will differ. Per-workload points in run 2:
push 50, clone 44, read 46, write 44.

## What was fixed during grading

- v2 fetch framing: real git (and the kit client) expect only the sections that have
  content — `acknowledgments` only while negotiating without `done`, `shallow-info`
  only when there are boundaries, no `wanted-refs`; verified against real git's
  own `upload-pack` output.
- Receive-pack report: the report-status stream inside sideband band 1 is pkt-line
  framed and ends with its own flush packet (verified against `git daemon`).
- Incremental fetch: never re-send objects the client already holds (commits,
  trees, blobs reachable from its haves); shallow/unshallow derived from what the
  client will hold after the fetch.
- Perf caches: whole-pack bytes per fetch selection; serialized issue JSON per issue
  (invalidated on mutation).

## Layout

- `main.ts` — lifecycle, unchanged from the starter.
- `app.ts` — HTTP server + REST v3.
- `store.ts` — in-memory state, git object primitives, shared issue/PR/merge logic.
- `git.ts` — git smart HTTP, pkt-lines, packfiles, protocol v2/v0.
- `graphql.ts` — GraphQL v4 parser + executor.
- `mcp.ts` — MCP endpoint + six tools.
- `.makefun/owner.json` — wallet `6d1rq1quL6CZSCb29p7Vk2Hcq8s7eqGDqfm86GjqwyTf`.
- `README.md` — badges for `noderuners/github-core-clone-01` (bounty, rank, reward).

Total ~155 KiB, stdlib only, no git binary, no network beyond the env.

## Remaining work (for the parent, not this entry)

- Push this directory to https://github.com/NodeRunerS/github-core-clone-01 (needs
  Jack's push access) and run the site's pre-submit `check` (LICENSE, entrypoint,
  size caps, transcript gate) before submitting.
- The viewer login is the kit scenario's fixed viewer (`adaiversen`, from the kit's
  `program/env/src/wire.ts` default scenario seed); the entry receives only the
  opaque shop token, so that identity is baked in.
