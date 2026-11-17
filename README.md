# github-core-clone-01

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/noderuners/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/noderuners/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge, built for [the make.fun bounty](https://make.fun/bounty/github-core-clone-01):
a single in-memory server that speaks git smart HTTP, REST v3, GraphQL v4 and MCP — no git binary,
no dependencies, Node standard library only.

## What it does

| Surface | Routes |
| --- | --- |
| Git smart HTTP | `/{owner}/{repo}.git/info/refs`, `git-upload-pack` (protocol v2 with `ls-refs`/`fetch`, plus v0 fallback), `git-receive-pack` (report-status, fast-forward only) |
| REST v3 | `/api/v3/...`: repositories, branches, commits, contents, labels, issues, comments, pull requests, files, squash merges |
| GraphQL v4 | `POST /api/graphql`: `viewer`, `repository`, `node(id:)`, `__type` introspection, issue / pull-request mutations |
| MCP | `POST /mcp`: JSON-RPC 2.0 streamable HTTP, `server/discover` (2026-07-28) or `initialize`, six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) |

The object store is a from-scratch implementation of git objects (SHA-1 commit/tree/blob/tag),
packfile generation and parsing (plain objects, zlib, OFS/REF delta resolution on read), and
protocol v2/v0 negotiation including shallow fetches, deepen, and thin packs.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing to install: the
program imports `node:http`, `node:crypto`, `node:zlib` and its own modules only.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`.

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`.
3. **Wait for done.** Poll `GET $MAKEFUN_ENV_URL/done` until it answers `{"done":true}`.
4. **Exit 0** when it does.

## Layout

- `main.ts`: the entry <-> env lifecycle. Keep it as it is.
- `app.ts`: the HTTP server and the REST v3 surface.
- `store.ts`: the in-memory state (repos, refs, objects, issues, pull requests) and the git object primitives.
- `git.ts`: git smart HTTP — pkt-lines, packfiles, protocol v2/v0 upload-pack and receive-pack.
- `graphql.ts`: the GraphQL v4 parser and executor.
- `mcp.ts`: the MCP endpoint and its six tools.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

## Notes

- Auth is a single bearer token (`MAKEFUN_SHOP_TOKEN` in the entry's environment). The forge has
  one viewer, the scenario owner; a repository name under any other owner answers 404, never 403.
- Everything is in memory: a restart is a fresh forge. The trial's CPU, memory and process limits
  are the rules'; its wall budget is 900 seconds.
