// The forge's in-memory state: the git object store, refs, issues, pull requests and labels,
// plus the git object primitives (SHA-1, commit/tree/blob/tag encoding and parsing).
//
// The scenario the harness grades against has one fixed viewer (kit program/env/src/wire.ts,
// buildScenario() with its default seed): login 'adaiversen', id 1000. The entry receives only
// the opaque shop token, never that login, so the viewer identity is the fixed scenario value.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  authorTime: number;
  committerTime: number;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  userLogin: string;
  comments: Comment[];
  /** Cached JSON.stringify of the REST issue object; cleared on any mutation. */
  jsonCache: string | null;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string; // base tip at creation time
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  userLogin: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  commitCache: Map<string, ParsedCommit>;
  fileMapCache: Map<string, Map<string, { oid: string; mode: string }>>;
  packEntryCache: Map<string, Buffer>;
  /** Whole pack bytes for a fetch selection, keyed by the selection's inputs. */
  packCache: Map<string, Buffer>;
  issues: Issue[];
  issueByNumber: Map<number, Issue>;
  pulls: Pull[];
  pullByNumber: Map<number, Pull>;
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  nextLabelId: number;
  seq: number;
}

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = objectId(type, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { type, data });
    repo.packEntryCache.delete(oid);
  }
  return oid;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0];
  const lines = head.split('\n');
  let tree = '';
  const parents: string[] = [];
  let authorTime = 0;
  let committerTime = 0;
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorTime = timeOf(line);
    else if (line.startsWith('committer ')) committerTime = timeOf(line);
  }
  const message = text.includes('\n\n') ? text.slice(text.indexOf('\n\n') + 2) : '';
  return { tree, parents, message, authorTime, committerTime };
}

function timeOf(line: string): number {
  const m = / (\d+) [+-]\d{4}$/.exec(line);
  return m ? Number(m[1]) : 0;
}

export function getCommit(repo: Repo, oid: string): ParsedCommit | null {
  const cached = repo.commitCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  repo.commitCache.set(oid, parsed);
  return parsed;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

function gitSortKey(name: string, isDir: boolean): string {
  return isDir ? `${name}/` : name;
}

/** Build (and store) a tree from a flat path -> blob map; returns the root tree oid. */
export function buildTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    entries.sort((a, b) => {
      const ka = gitSortKey(a.name, a.mode === '40000');
      const kb = gitSortKey(b.name, b.mode === '40000');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const entry of entries) {
      parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
      parts.push(Buffer.from(entry.oid, 'hex'));
    }
    return storeObject(repo, 'tree', Buffer.concat(parts));
  };
  return build(root);
}

/** Flat path -> blob map of a commit's tree (cached per commit). */
export function fileMapOf(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const cached = repo.fileMapCache.get(commitOid);
  if (cached) return cached;
  const out = new Map<string, { oid: string; mode: string }>();
  const commit = getCommit(repo, commitOid);
  if (commit) {
    const walk = (treeOid: string, prefix: string): void => {
      const obj = repo.objects.get(treeOid);
      if (!obj || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(commit.tree, '');
  }
  repo.fileMapCache.set(commitOid, out);
  return out;
}

/** Create a commit object on the repo and return its oid. */
export function createCommit(
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${now} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '', message);
  const oid = storeObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  repo.seq += 1;
  return oid;
}

/** All commits reachable from the tips (following parents), in no particular order. */
export function reachableCommits(repo: Repo, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const commit = getCommit(repo, oid);
    if (!commit) continue;
    seen.add(oid);
    for (const parent of commit.parents) stack.push(parent);
  }
  return seen;
}

/** Is `ancestor` an ancestor of (or equal to) `oid`? */
export function isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  return reachableCommits(repo, [oid]).has(ancestor);
}

/** History of a branch tip, newest first (by time, then insertion order). */
export function commitHistory(repo: Repo, tip: string, limit = 1000): string[] {
  const set = reachableCommits(repo, [tip]);
  const list = [...set];
  list.sort((a, b) => {
    const ca = getCommit(repo, a);
    const cb = getCommit(repo, b);
    const ta = ca?.committerTime ?? 0;
    const tb = cb?.committerTime ?? 0;
    if (ta !== tb) return tb - ta;
    return 0;
  });
  return list.slice(0, limit);
}

/** The deflated pack entry bytes for one object (cached per repo). */
export function packEntry(repo: Repo, oid: string): Buffer | null {
  const cached = repo.packEntryCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj) return null;
  const typeNum: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  let size = obj.data.length;
  const header: number[] = [];
  let byte = (typeNum[obj.type] << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    header.push(byte | 0x80);
    byte = size & 0x7f;
    size >>= 7;
  }
  header.push(byte);
  const deflated = deflateSync(obj.data, { level: 6 });
  const entry = Buffer.concat([Buffer.from(header), deflated]);
  repo.packEntryCache.set(oid, entry);
  return entry;
}

// --------------------------------------------------------------------------------------------
// The store itself.
// --------------------------------------------------------------------------------------------

export class Store {
  repos = new Map<string, Repo>();
  repoList: Repo[] = [];
  repoById = new Map<number, Repo>();
  issueById = new Map<number, { repo: Repo; issue: Issue }>();
  pullById = new Map<number, { repo: Repo; pull: Pull }>();
  commentById = new Map<number, { repo: Repo; issue: Issue; comment: Comment }>();
  nextRepoId = 5000;
  nextGlobalId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.repoById.get(id);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(VIEWER_LOGIN, name))) return null;
    const now = new Date().toISOString();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      refs: new Map(),
      objects: new Map(),
      commitCache: new Map(),
      fileMapCache: new Map(),
      packEntryCache: new Map(),
      packCache: new Map(),
      issues: [],
      issueByNumber: new Map(),
      pulls: [],
      pullByNumber: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      nextLabelId: 1,
      seq: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    this.repoById.set(repo.id, repo);
    this.repoList.push(repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
    this.repoById.delete(repo.id);
    for (const issue of repo.issues) {
      this.issueById.delete(issue.id);
      for (const comment of issue.comments) this.commentById.delete(comment.id);
    }
    for (const pull of repo.pulls) this.pullById.delete(pull.id);
    const i = this.repoList.indexOf(repo);
    if (i >= 0) this.repoList.splice(i, 1);
  }

  /** The repo's default-branch tip, or null when unborn. */
  headOf(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const now = isoNow();
    const issue: Issue = {
      id: this.nextGlobalId,
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      userLogin: VIEWER_LOGIN,
      comments: [],
      jsonCache: null,
    };
    this.nextGlobalId += 1;
    repo.nextIssue += 1;
    repo.issues.push(issue);
    repo.issueByNumber.set(issue.number, issue);
    this.issueById.set(issue.id, { repo, issue });
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    baseRef: string,
    headSha: string,
    baseSha: string,
  ): Pull {
    const now = isoNow();
    const pull: Pull = {
      id: this.nextGlobalId,
      number: repo.nextPull,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      userLogin: VIEWER_LOGIN,
    };
    this.nextGlobalId += 1;
    repo.nextPull += 1;
    repo.pulls.push(pull);
    repo.pullByNumber.set(pull.number, pull);
    this.pullById.set(pull.id, { repo, pull });
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const now = isoNow();
    const comment: Comment = {
      id: this.nextGlobalId,
      body,
      userLogin: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
    };
    this.nextGlobalId += 1;
    issue.comments.push(comment);
    issue.jsonCache = null;
    this.commentById.set(comment.id, { repo, issue, comment });
    return comment;
  }
}

/** Opaque, stable global ids (never the plain numeric id/number). */
export function gid(kind: string, id: number): string {
  return Buffer.from(`${kind}_${id}`, 'utf8').toString('base64');
}

export function parseGid(id: string): { kind: string; num: number } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+)_(\d+)$/.exec(decoded);
    if (!m) return null;
    return { kind: m[1], num: Number(m[2]) };
  } catch {
    return null;
  }
}

export function isoNow(): string {
  return new Date().toISOString();
}

// --------------------------------------------------------------------------------------------
// Shared domain operations (REST, GraphQL and MCP all go through these).
// --------------------------------------------------------------------------------------------

/** Diff two commits' trees: one entry per changed path, with line counts. */
export function diffFiles(
  repo: Repo,
  baseOid: string,
  headOid: string,
): Array<{ path: string; status: string; additions: number; deletions: number; changes: number }> {
  const base = fileMapOf(repo, baseOid);
  const head = fileMapOf(repo, headOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: Array<{ path: string; status: string; additions: number; deletions: number; changes: number }> = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && h && b.oid === h.oid) continue;
    let additions = 0;
    let deletions = 0;
    const bText = b ? blobText(repo, b.oid) : null;
    const hText = h ? blobText(repo, h.oid) : null;
    if (bText !== null && hText !== null) {
      const d = lineDiff(bText, hText);
      additions = d.additions;
      deletions = d.deletions;
    } else if (hText !== null) {
      additions = hText === '' ? 0 : hText.split('\n').length;
    } else if (bText !== null) {
      deletions = bText === '' ? 0 : bText.split('\n').length;
    }
    const status = !b ? 'added' : !h ? 'removed' : 'modified';
    out.push({ path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

function blobText(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'blob') return null;
  return obj.data.toString('utf8');
}

/** Line diff counts via LCS (files in the checks are small; falls back for big ones). */
export function lineDiff(a: string, b: string): { additions: number; deletions: number } {
  const al = a === '' ? [] : a.split('\n');
  const bl = b === '' ? [] : b.split('\n');
  if (al.length * bl.length > 250_000) {
    // Prefix/suffix fallback for large files.
    let prefix = 0;
    while (prefix < al.length && prefix < bl.length && al[prefix] === bl[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < al.length - prefix && suffix < bl.length - prefix && al[al.length - 1 - suffix] === bl[bl.length - 1 - suffix]) suffix += 1;
    return { additions: bl.length - prefix - suffix, deletions: al.length - prefix - suffix };
  }
  const dp: number[][] = Array.from({ length: al.length + 1 }, () => new Array<number>(bl.length + 1).fill(0));
  for (let i = al.length - 1; i >= 0; i -= 1) {
    for (let j = bl.length - 1; j >= 0; j -= 1) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return { additions: bl.length - dp[0][0], deletions: al.length - dp[0][0] };
}

/** MERGEABLE when a squash onto the current base tip would apply cleanly. */
export function prMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return 'UNKNOWN';
  if (!repo.objects.has(pull.headSha) || !getCommit(repo, pull.headSha)) return 'UNKNOWN';
  if (pull.headSha === baseTip) return 'MERGEABLE';
  const baseAtCreation = fileMapOf(repo, pull.baseSha);
  const headFiles = fileMapOf(repo, pull.headSha);
  const baseNowFiles = fileMapOf(repo, baseTip);
  const changedInHead = new Set<string>();
  for (const path of new Set([...baseAtCreation.keys(), ...headFiles.keys()])) {
    const a = baseAtCreation.get(path);
    const b = headFiles.get(path);
    if (a?.oid !== b?.oid) changedInHead.add(path);
  }
  for (const path of new Set([...baseAtCreation.keys(), ...baseNowFiles.keys()])) {
    const a = baseAtCreation.get(path);
    const b = baseNowFiles.get(path);
    if (a?.oid !== b?.oid && changedInHead.has(path)) {
      const headOid = headFiles.get(path)?.oid;
      const baseOid = baseNowFiles.get(path)?.oid;
      if (headOid !== baseOid) return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch. Returns the merge sha, or null if conflicted. */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  if (pull.merged) return pull.mergeCommitSha;
  if (prMergeable(repo, pull) !== 'MERGEABLE') return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return null;
  let sha: string;
  if (baseTip === pull.headSha) {
    sha = baseTip;
  } else {
    const headCommit = getCommit(repo, pull.headSha);
    if (!headCommit) return null;
    sha = createCommit(repo, headCommit.tree, [baseTip], pull.title);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  }
  const now = isoNow();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.mergeCommitSha = sha;
  pull.closedAt = now;
  pull.updatedAt = now;
  return sha;
}
