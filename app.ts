// The forge's HTTP server: REST v3 under /api/v3, GraphQL v4 at /api/graphql, MCP at /mcp,
// and git smart HTTP under /{owner}/{repo}.git. Node stdlib only; one in-memory Store.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL, ZERO_OID, DEFAULT_BRANCH,
  Store, type Repo, type Issue, type Pull,
  gid, isoNow, storeObject, getCommit, parseTree, buildTree, fileMapOf,
  commitHistory, diffFiles, prMergeable, squashMerge, createCommit,
} from './store.ts';
import { infoRefsBody, handleUploadPack, handleLsRefs, handleReceivePack } from './git.ts';
import { runGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const store = new Store();

function requestId(): string {
  return `req_${randomBytes(8).toString('hex')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** Send an already-stringified JSON body (the trailing newline is added here). */
function sendJsonText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  const body = `${text}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(body),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(body);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function decodeSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '').map(decodeSegment);
}

/** Bearer auth: the shop token when the env sets one, else any non-empty bearer token. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return false;
  if (SHOP_TOKEN !== '') return m[1] === SHOP_TOKEN;
  return m[1].length > 0;
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

// --------------------------------------------------------------------------------------------
// REST shapes.
// --------------------------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  const openCount = repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: gid('R', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User', avatar_url: '' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openCount,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    license: null,
    topics: [],
    language: null,
    size: 0,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: gid('L', label?.id ?? 0),
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('I', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: issue.userLogin, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJsonText(repo: Repo, issue: Issue): string {
  if (issue.jsonCache !== null) return issue.jsonCache;
  const text = JSON.stringify(issueJson(repo, issue));
  issue.jsonCache = text;
  return text;
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: gid('C', comment.id),
    body: comment.body,
    user: { login: comment.userLogin, id: VIEWER_ID, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headRepo = repoJson(repo);
  const files = diffFiles(repo, pull.baseSha, pull.headSha);
  return {
    id: pull.id,
    node_id: gid('PR', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner, id: VIEWER_ID, type: 'User' }, repo: headRepo },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner, id: VIEWER_ID, type: 'User' }, repo: headRepo },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: prMergeable(repo, pull) === 'MERGEABLE',
    draft: false,
    additions: files.reduce((s, f) => s + f.additions, 0),
    deletions: files.reduce((s, f) => s + f.deletions, 0),
    changed_files: files.length,
    commits: 1,
    user: { login: pull.userLogin, id: VIEWER_ID, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const commit = getCommit(repo, oid);
  if (!commit) return null;
  const date = new Date((commit.committerTime || 0) * 1000).toISOString();
  return {
    sha: oid,
    node_id: Buffer.from(`C_${oid}`, 'utf8').toString('base64'),
    commit: {
      message: commit.message,
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date },
      tree: { sha: commit.tree },
      verification: { verified: false, reason: 'unsigned' },
    },
    parents: commit.parents.map((p) => ({ sha: p })),
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
  };
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
  };
}

function paginate<T>(items: T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(req: IncomingMessage, basePath: string, query: URLSearchParams, perPage: number, page: number, total: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const origin = originOf(req);
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${origin}${basePath}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  parts.push(`<${urlFor(totalPages)}>; rel="last"`);
  if (page > 1) parts.push(`<${urlFor(1)}>; rel="first"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  return parts.join(', ');
}

// --------------------------------------------------------------------------------------------
// Contents.
// --------------------------------------------------------------------------------------------

function branchTip(repo: Repo, branch: string | null): string | null {
  if (branch === null || branch === '') return store.headOf(repo);
  const ref = repo.refs.get(`refs/heads/${branch}`);
  if (ref) return ref;
  const tag = repo.refs.get(`refs/tags/${branch}`);
  if (tag) {
    const commit = getCommit(repo, tag);
    if (commit) return tag;
    // Annotated tag: resolve to its target commit.
    const obj = repo.objects.get(tag);
    if (obj && obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m) return m[1];
    }
    return tag;
  }
  if (repo.objects.has(branch)) return branch;
  return null;
}

async function handleContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  pathParts: string[],
  method: string,
): Promise<void> {
  const query = queryOf(req);
  const path = pathParts.join('/');
  if (method === 'GET') {
    const tip = branchTip(repo, query.get('ref'));
    if (!tip) return sendError(res, 404, 'Not Found');
    const files = fileMapOf(repo, tip);
    if (path === '') {
      const entries = dirListing(repo, tip, '');
      return sendJson(res, 200, entries);
    }
    const file = files.get(path);
    if (file) {
      const obj = repo.objects.get(file.oid);
      const content = obj ? obj.data.toString('base64') : '';
      return sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: obj ? obj.data.length : 0,
        name: path.split('/').pop(),
        path,
        content,
        sha: file.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`,
        download_url: null,
      });
    }
    // Directory?
    const prefix = `${path}/`;
    let isDir = false;
    for (const p of files.keys()) if (p.startsWith(prefix)) { isDir = true; break; }
    if (isDir) return sendJson(res, 200, dirListing(repo, tip, path));
    return sendError(res, 404, 'Not Found');
  }
  if (method === 'PUT') {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    if (!isRecord(parsed.value)) return sendError(res, 400, 'Problems parsing JSON');
    const body = parsed.value;
    if (typeof body.content !== 'string') return sendError(res, 422, 'Validation Failed: content is required');
    const message = typeof body.message === 'string' ? body.message : 'Update';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const content = Buffer.from(body.content, 'base64');
    let tip = repo.refs.get(`refs/heads/${branch}`);
    let baseFiles = new Map<string, { oid: string; mode: string }>();
    let parents: string[] = [];
    if (tip) {
      baseFiles = fileMapOf(repo, tip);
      parents = [tip];
    } else {
      // A new branch starts from the default tip when the repo has commits.
      const head = store.headOf(repo);
      if (head) {
        baseFiles = fileMapOf(repo, head);
        parents = [head];
      }
    }
    const existing = baseFiles.get(path);
    const isCreate = !existing;
    if (existing) {
      if (typeof body.sha !== 'string') return sendError(res, 422, 'Validation Failed: sha is required to update a file');
      if (body.sha !== existing.oid) return sendError(res, 409, 'Conflict: sha does not match the current file');
    } else if (typeof body.sha === 'string') {
      return sendError(res, 422, 'Validation Failed: sha does not match a file that does not exist');
    }
    const blobOid = storeObject(repo, 'blob', content);
    const nextFiles = new Map(baseFiles);
    nextFiles.set(path, { oid: blobOid, mode: '100644' });
    const treeOid = buildTree(repo, nextFiles);
    const commitOid = createCommit(repo, treeOid, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = isoNow();
    return sendJson(res, isCreate ? 201 : 200, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: blobOid,
        size: content.length,
        encoding: 'base64',
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
        download_url: null,
      },
      commit: { sha: commitOid, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
    });
  }
  if (method === 'DELETE') {
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const body = isRecord(parsed.value) ? parsed.value : {};
    const message = typeof body.message === 'string' ? body.message : 'Delete';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return sendError(res, 404, 'Not Found');
    const baseFiles = fileMapOf(repo, tip);
    const existing = baseFiles.get(path);
    if (!existing) return sendError(res, 404, 'Not Found');
    if (typeof body.sha === 'string' && body.sha !== existing.oid) return sendError(res, 409, 'Conflict: sha does not match the current file');
    const nextFiles = new Map(baseFiles);
    nextFiles.delete(path);
    const treeOid = buildTree(repo, nextFiles);
    const commitOid = createCommit(repo, treeOid, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    repo.updatedAt = isoNow();
    return sendJson(res, 200, {
      commit: { sha: commitOid, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
    });
  }
  return sendError(res, 404, 'Not Found');
}

function dirListing(repo: Repo, tip: string, dir: string): Record<string, unknown>[] {
  const files = fileMapOf(repo, tip);
  const prefix = dir === '' ? '' : `${dir}/`;
  const seen = new Map<string, { type: string; oid: string }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      seen.set(rest, { type: 'file', oid: entry.oid });
    } else {
      const name = rest.slice(0, slash);
      if (!seen.has(name)) {
        seen.set(name, { type: 'dir', oid: dirTreeOid(repo, tip, dir === '' ? name : `${dir}/${name}`) });
      }
    }
  }
  return [...seen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, info]) => {
      const path = prefix + name;
      const obj = repo.objects.get(info.oid);
      return {
        type: info.type,
        size: info.type === 'file' && obj ? obj.data.length : 0,
        name,
        path,
        sha: info.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${info.type === 'file' ? 'blobs' : 'trees'}/${info.oid}`,
        download_url: info.type === 'file' ? null : null,
      };
    });
}

function dirTreeOid(repo: Repo, tip: string, dir: string): string {
  const commit = getCommit(repo, tip);
  if (!commit) return ZERO_OID;
  const parts = dir.split('/');
  let treeOid = commit.tree;
  for (const part of parts) {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return ZERO_OID;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (!entry) return ZERO_OID;
    treeOid = entry.oid;
  }
  return treeOid;
}

// --------------------------------------------------------------------------------------------
// The server.
// --------------------------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        await route(req, res);
      } catch (err) {
        if (!res.writableEnded) {
          sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
      }
    })();
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const path = pathOf(req);
  const query = queryOf(req);
  const parts = segments(path);

  // Health probe: no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (parts.length >= 2 && parts[1].endsWith('.git')) {
    const owner = parts[0];
    const repoName = parts[1].slice(0, -4);
    const repo = store.getRepo(owner, repoName);
    const service = parts[2] ?? '';
    if (service === 'info' && parts[3] === 'refs' && method === 'GET') {
      const serviceParam = query.get('service') ?? '';
      if (!repo) return sendError(res, 404, 'Not Found');
      if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') return sendError(res, 404, 'Not Found');
      const gitProtocol = (req.headers['git-protocol'] ?? '') as string;
      const body = infoRefsBody(repo, serviceParam, gitProtocol);
      if (body === null) return sendError(res, 404, 'Not Found');
      return sendBytes(res, 200, body, `application/x-${serviceParam}-advertisement`);
    }
    if (service === 'git-upload-pack' && method === 'POST') {
      if (!repo) return sendError(res, 404, 'Not Found');
      const raw = await readBody(req);
      const gitProtocol = (req.headers['git-protocol'] ?? '') as string;
      // ls-refs is a v2 command sent to git-upload-pack; fetch is the other.
      if (gitProtocol === 'version=2' && raw.toString('utf8').includes('command=ls-refs')) {
        const out = handleLsRefs(repo, raw);
        if (out === null) return sendBytes(res, 400, Buffer.alloc(0), 'application/x-git-upload-pack-result');
        return sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
      }
      let out: Buffer | null;
      try {
        out = handleUploadPack(repo, raw, gitProtocol);
      } catch {
        return sendBytes(res, 400, Buffer.alloc(0), 'application/x-git-upload-pack-result');
      }
      if (out === null) return sendBytes(res, 400, Buffer.alloc(0), 'application/x-git-upload-pack-result');
      return sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
    }
    if (service === 'git-receive-pack' && method === 'POST') {
      if (!repo) return sendError(res, 404, 'Not Found');
      const raw = await readBody(req);
      let out: Buffer;
      try {
        out = await handleReceivePack(repo, raw);
      } catch {
        return sendBytes(res, 400, Buffer.alloc(0), 'application/x-git-receive-pack-result');
      }
      return sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
    }
    return sendError(res, 404, 'Not Found');
  }

  // GraphQL and MCP.
  if (path === '/api/graphql') {
    if (method !== 'POST') return sendError(res, 404, 'Not Found');
    if (!authorized(req)) return sendError(res, 401, 'Bad credentials');
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
    const result = runGraphQL(store, parsed.value);
    return sendJson(res, 200, result);
  }
  if (path === '/api/mcp' || path === '/mcp') {
    if (method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
    if (!authorized(req)) return sendError(res, 401, 'Bad credentials');
    const raw = await readBody(req);
    const outcome = handleMcp(store, raw.toString('utf8'));
    if (outcome.body === null) {
      res.writeHead(outcome.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    return sendJson(res, outcome.status, JSON.parse(outcome.body));
  }

  // REST v3.
  if (parts[0] === 'api' && parts[1] === 'v3') {
    // API root: no auth (as the starter ships it), but with scopes and a request id.
    if ((path === '/api/v3' || path === '/api/v3/') && method === 'GET') {
      return sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    if (!authorized(req)) return sendError(res, 401, 'Bad credentials');
    await routeRest(req, res, parts.slice(2), method, query);
    return;
  }

  return sendError(res, 404, 'Not Found');
}

async function routeRest(req: IncomingMessage, res: ServerResponse, parts: string[], method: string, query: URLSearchParams): Promise<void> {
  // GET /api/v3/meta
  if (parts.length === 1 && parts[0] === 'meta' && method === 'GET') {
    return sendJson(res, 200, {
      installed_version: '1.0.0',
      verifiable_password_authentication: true,
      github_services_sha: '0000000000000000000000000000000000000000',
      hooks: [],
      git: [],
      pages: [],
    });
  }
  // GET /api/v3/rate_limit
  if (parts.length === 1 && parts[0] === 'rate_limit' && method === 'GET') {
    return sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } }, rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 } });
  }
  // GET /api/v3/user
  if (parts.length === 1 && parts[0] === 'user' && method === 'GET') {
    return sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: gid('U', VIEWER_ID),
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: 'User',
      avatar_url: '',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      url: '/api/v3/users/' + VIEWER_LOGIN,
    });
  }
  // /api/v3/user/repos
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = pageParams(query);
      const pageItems = paginate(store.repoList, perPage, page);
      const link = linkHeader(req, '/api/v3/user/repos', query, perPage, page, store.repoList.length);
      return sendJson(res, 200, pageItems.map((r) => repoJson(r)), link ? { link } : {});
    }
    if (method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return sendError(res, 422, 'Validation Failed: name is required');
      const repo = store.createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      if (!repo) return sendError(res, 422, 'Validation Failed: name already exists on this account');
      return sendJson(res, 201, repoJson(repo));
    }
    return sendError(res, 404, 'Not Found');
  }
  // GET /api/v3/users/{login}
  if (parts.length === 2 && parts[0] === 'users' && method === 'GET') {
    if (parts[1] === VIEWER_LOGIN) {
      return sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: gid('U', VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User', html_url: `https://github.com/${VIEWER_LOGIN}` });
    }
    return sendError(res, 404, 'Not Found');
  }
  // /api/v3/repos/{owner}/{repo}/...
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = parts[1];
    const repoName = parts[2];
    const repo = store.getRepo(owner, repoName);
    if (!repo) return sendError(res, 404, 'Not Found');
    const rest = parts.slice(3);

    // Repo itself.
    if (rest.length === 0) {
      if (method === 'GET') return sendJson(res, 200, repoJson(repo));
      if (method === 'PATCH') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch}`)) repo.defaultBranch = body.default_branch;
        repo.updatedAt = isoNow();
        return sendJson(res, 200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(repo);
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return;
      }
      return sendError(res, 404, 'Not Found');
    }

    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .map((r) => r.slice('refs/heads/'.length))
          .sort()
          .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`) as string }, protected: false }));
        return sendJson(res, 200, branches);
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!sha) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, { name: rest[1], commit: { sha }, protected: false });
      }
      return sendError(res, 404, 'Not Found');
    }

    // Commits.
    if (rest[0] === 'commits') {
      if (rest.length === 1 && method === 'GET') {
        const shaParam = query.get('sha');
        const tip = shaParam ? repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : null) : store.headOf(repo);
        if (!tip) return sendJson(res, 200, []);
        const { perPage, page } = pageParams(query);
        const history = paginate(commitHistory(repo, tip), perPage, page);
        const out: Record<string, unknown>[] = [];
        for (const oid of history) {
          const entry = commitJson(repo, oid);
          if (entry) out.push(entry);
        }
        return sendJson(res, 200, out);
      }
      if (rest.length === 2 && method === 'GET') {
        const entry = commitJson(repo, rest[1]);
        if (!entry) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, entry);
      }
      return sendError(res, 404, 'Not Found');
    }

    // git/refs, git/trees, git/blobs, git/commits.
    if (rest[0] === 'git') {
      if (rest[1] === 'refs' && method === 'POST' && rest.length === 2) {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const body = isRecord(parsed.value) ? parsed.value : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return sendError(res, 422, 'Validation Failed: ref or sha is invalid');
        if (repo.refs.has(ref)) return sendError(res, 422, 'Validation Failed: ref already exists');
        repo.refs.set(ref, sha);
        return sendJson(res, 201, { ref, node_id: gid('REF', 0), object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      }
      if (rest[1] === 'refs' && method === 'GET') {
        if (rest.length === 2) {
          const refs = [...repo.refs.keys()].sort().map((name) => ({ ref: name, node_id: gid('REF', 0), object: { sha: repo.refs.get(name), type: repo.objects.get(repo.refs.get(name) as string)?.type ?? 'commit' } }));
          return sendJson(res, 200, refs);
        }
        const refName = `refs/${rest.slice(2).join('/')}`;
        const sha = repo.refs.get(refName);
        if (!sha) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, { ref: refName, node_id: gid('REF', 0), object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      }
      if (rest[1] === 'trees' && rest.length === 3 && method === 'GET') {
        const obj = repo.objects.get(rest[2]);
        if (!obj || obj.type !== 'tree') return sendError(res, 404, 'Not Found');
        const tree = parseTree(obj.data).map((e) => ({ path: e.name, mode: e.mode, type: e.mode === '40000' ? 'tree' : 'blob', sha: e.oid, size: e.mode === '40000' ? undefined : repo.objects.get(e.oid)?.data.length, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${e.mode === '40000' ? 'trees' : 'blobs'}/${e.oid}` }));
        return sendJson(res, 200, { sha: rest[2], tree });
      }
      if (rest[1] === 'blobs' && rest.length === 3 && method === 'GET') {
        const obj = repo.objects.get(rest[2]);
        if (!obj || obj.type !== 'blob') return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, { sha: rest[2], size: obj.data.length, encoding: 'base64', content: obj.data.toString('base64') });
      }
      if (rest[1] === 'commits' && rest.length === 3 && method === 'GET') {
        const entry = commitJson(repo, rest[2]);
        if (!entry) return sendError(res, 404, 'Not Found');
        return sendJson(res, 200, entry);
      }
      return sendError(res, 404, 'Not Found');
    }

    // Contents.
    if (rest[0] === 'contents') {
      return handleContents(req, res, repo, rest.slice(1), method);
    }

    // Labels.
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        return sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: l.id, node_id: gid('L', l.id), name: l.name, color: l.color, default: false, description: '', url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(l.name)}` })));
      }
      if (rest.length === 1 && method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
        const body = isRecord(parsed.value) ? parsed.value : {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name) return sendError(res, 422, 'Validation Failed: name is required');
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        let label = repo.labels.get(name);
        if (!label) {
          label = { id: repo.nextLabelId, name, color };
          repo.nextLabelId += 1;
          repo.labels.set(name, label);
        } else {
          label.color = color;
        }
        return sendJson(res, 201, { id: label.id, node_id: gid('L', label.id), name: label.name, color: label.color, default: false, description: '', url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}` });
      }
      return sendError(res, 404, 'Not Found');
    }

    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          const sort = query.get('sort') ?? 'created';
          const direction = (query.get('direction') ?? 'desc').toLowerCase();
          let list = [...repo.issues];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          if (sort === 'created') list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { perPage, page } = pageParams(query);
          return sendJson(res, 200, paginate(list, perPage, page).map((i) => issueJson(repo, i)));
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
          const body = isRecord(parsed.value) ? parsed.value : {};
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          if (!title) return sendError(res, 422, 'Validation Failed: title is required');
          const labelsRaw = Array.isArray(body.labels) ? body.labels : [];
          const labels: string[] = [];
          for (const entry of labelsRaw) {
            const name = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.name ?? '') : '';
            if (!name) continue;
            if (!repo.labels.has(name)) return sendError(res, 422, `Validation Failed: label "${name}" does not exist`);
            labels.push(name);
          }
          const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
          return sendJsonText(res, 201, issueJsonText(repo, issue));
        }
        return sendError(res, 404, 'Not Found');
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return sendError(res, 404, 'Not Found');
      const issue = repo.issueByNumber.get(num);
      if (!issue) return sendError(res, 404, 'Not Found');
      if (rest.length === 2) {
        if (method === 'GET') return sendJsonText(res, 200, issueJsonText(repo, issue));
        if (method === 'PATCH') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
          const body = isRecord(parsed.value) ? parsed.value : {};
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'closed' || body.state === 'open') {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? isoNow() : null;
          }
          if (Array.isArray(body.labels)) {
            const labels: string[] = [];
            for (const entry of body.labels) {
              const name = typeof entry === 'string' ? entry : isRecord(entry) ? String(entry.name ?? '') : '';
              if (!name) continue;
              if (!repo.labels.has(name)) return sendError(res, 422, `Validation Failed: label "${name}" does not exist`);
              labels.push(name);
            }
            issue.labels = labels;
          }
          issue.updatedAt = isoNow();
          issue.jsonCache = null;
          return sendJson(res, 200, issueJson(repo, issue));
        }
        return sendError(res, 404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          return sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
          const body = isRecord(parsed.value) ? parsed.value : {};
          const commentBody = typeof body.body === 'string' ? body.body : '';
          const comment = store.addComment(repo, issue, commentBody);
          return sendJson(res, 201, commentJson(repo, issue, comment));
        }
        return sendError(res, 404, 'Not Found');
      }
      return sendError(res, 404, 'Not Found');
    }

    // Pulls.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls];
          if (state !== 'all') list = list.filter((p) => (state === 'closed' ? p.state === 'closed' : p.state === 'open'));
          const { perPage, page } = pageParams(query);
          return sendJson(res, 200, paginate(list, perPage, page).map((p) => pullJson(repo, p)));
        }
        if (method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) return sendError(res, 400, 'Problems parsing JSON');
          const body = isRecord(parsed.value) ? parsed.value : {};
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (!title || !head) return sendError(res, 422, 'Validation Failed: title and head are required');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha) return sendError(res, 422, `Validation Failed: head branch ${head} not found`);
          if (!baseSha) return sendError(res, 422, `Validation Failed: base branch ${base} not found`);
          const existing = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
          if (existing) return sendError(res, 422, 'Validation Failed: a pull request from this head already exists');
          const pull = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base, headSha, baseSha);
          return sendJson(res, 201, pullJson(repo, pull));
        }
        return sendError(res, 404, 'Not Found');
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return sendError(res, 404, 'Not Found');
      const pull = repo.pullByNumber.get(num);
      if (!pull) return sendError(res, 404, 'Not Found');
      if (rest.length === 2 && method === 'GET') {
        return sendJson(res, 200, pullJson(repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const files = diffFiles(repo, pull.baseSha, pull.headSha).map((f) => ({
          sha: '',
          filename: f.path,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        }));
        return sendJson(res, 200, files);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.merged) return sendError(res, 405, 'Method Not Allowed: pull request is already merged');
        if (prMergeable(repo, pull) !== 'MERGEABLE') return sendError(res, 405, 'Method Not Allowed: pull request is not mergeable');
        const sha = squashMerge(repo, pull);
        if (sha === null) return sendError(res, 405, 'Method Not Allowed: pull request is not mergeable');
        return sendJson(res, 200, { sha, merged: true, message: `Pull request #${pull.number} merged` });
      }
      return sendError(res, 404, 'Not Found');
    }

    return sendError(res, 404, 'Not Found');
  }

  return sendError(res, 404, 'Not Found');
}
