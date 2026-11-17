// Model Context Protocol over streamable HTTP (POST /mcp): JSON-RPC 2.0, modern
// `server/discover` (revision 2026-07-28) with the legacy `initialize` handshake as fallback,
// and the six forge tools sharing the same store as REST and GraphQL.

import {
  VIEWER_LOGIN,
  type Store,
  gid, squashMerge, prMergeable,
} from './store.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_SERVER_NAME = 'forge';
export const MCP_SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the head branch.' },
        base: { type: 'string', description: 'The name of the base branch.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function toolResult(result: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
    structuredContent: result,
    isError,
  };
}

function errorResult(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

/** Accept the suite's argument synonyms as well as the canonical names. */
function pick(args: Record<string, unknown>, canonical: string, synonyms: string[]): unknown {
  if (args[canonical] !== undefined) return args[canonical];
  for (const s of synonyms) if (args[s] !== undefined) return args[s];
  return undefined;
}

function repoJson(repo: { id: number; name: string; owner: string; description: string; private: boolean; defaultBranch: string }): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`Unknown tool: ${name}`);
  const missing = tool.inputSchema.required.filter((r) => pick(args, r, []) === undefined);
  if (missing.length > 0) {
    return errorResult(`Missing required argument(s): ${missing.join(', ')}`);
  }
  const owner = String(pick(args, 'owner', ['owner_login', 'login']) ?? '');
  const repoName = String(pick(args, 'repo', ['repository']) ?? '');

  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(args.name ?? '');
      if (!repoNameArg) return errorResult('Missing required argument: name');
      const repo = store.createRepo(repoNameArg, String(args.description ?? ''), args.private === true);
      if (!repo) return errorResult(`Repository ${VIEWER_LOGIN}/${repoNameArg} already exists`);
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const title = String(pick(args, 'title', ['issue_title', 'pr_title']) ?? '');
      const body = String(pick(args, 'body', ['description']) ?? '');
      const issue = store.createIssue(repo, title, body, []);
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((l) => ({ name: l })),
        user: { login: VIEWER_LOGIN },
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
      });
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const state = String(args.state ?? 'open').toLowerCase();
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((l) => ({ name: l })),
          user: { login: VIEWER_LOGIN },
          created_at: issue.createdAt,
          updated_at: issue.updatedAt,
        }));
      return toolResult({ issues });
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const title = String(pick(args, 'title', ['pr_title', 'issue_title']) ?? '');
      const body = String(pick(args, 'body', ['description']) ?? '');
      const head = String(pick(args, 'head', ['head_branch']) ?? '');
      const base = String(pick(args, 'base', ['base_branch']) ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha) return errorResult(`Head branch ${head} not found`);
      if (!baseSha) return errorResult(`Base branch ${base} not found`);
      const existing = repo.pulls.find((p) => p.headRef === head && p.baseRef === base && p.state === 'open');
      if (existing) return errorResult(`A pull request from ${head} to ${base} is already open (#${existing.number})`);
      const pull = store.createPull(repo, title, body, head, base, headSha, baseSha);
      return toolResult({
        id: pull.id,
        number: pull.number,
        pull_number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
        merged: false,
        created_at: pull.createdAt,
        updated_at: pull.updatedAt,
      });
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const num = Number(pick(args, 'pull_number', ['number', 'pr_number']));
      const pull = repo.pullByNumber.get(num);
      if (!pull) return errorResult(`Pull request #${num} not found`);
      if (pull.merged) {
        return toolResult({ number: pull.number, pull_number: pull.number, merged: true, sha: pull.mergeCommitSha, state: 'closed' });
      }
      if (prMergeable(repo, pull) !== 'MERGEABLE') {
        return errorResult(`Pull request #${num} is not mergeable (conflicting)`);
      }
      const sha = squashMerge(repo, pull);
      if (sha === null) return errorResult(`Pull request #${num} could not be merged`);
      return toolResult({
        number: pull.number,
        pull_number: pull.number,
        merged: true,
        sha,
        merge_commit_sha: sha,
        state: 'closed',
        message: `Pull request #${pull.number} merged`,
      });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

export interface McpOutcome {
  status: number;
  body: string | null;
}

function rpcError(id: unknown, code: number, message: string): McpOutcome {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function rpcResult(id: unknown, result: unknown): McpOutcome {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function extractId(raw: string): unknown {
  const m = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/.exec(raw);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Handle one POST /mcp body (already auth-checked by the caller). */
export function handleMcp(store: Store, rawBody: string): McpOutcome {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: extractId(rawBody), error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (Array.isArray(body)) {
    const results: unknown[] = [];
    for (const item of body) {
      const outcome = handleOne(store, item);
      if (outcome.body !== null) results.push(JSON.parse(outcome.body));
    }
    return { status: 200, body: JSON.stringify(results) };
  }
  return handleOne(store, body);
}

function handleOne(store: Store, body: unknown): McpOutcome {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) };
  }
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = req.id ?? null;
  const isNotification = req.id === undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (isNotification) {
    return { status: 202, body: null };
  }
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      // Deterministic: the same array, in the same order, every call.
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!name) return rpcError(id, -32602, 'tools/call requires a tool name');
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const result = callTool(store, name, args);
      return rpcResult(id, result);
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export { gid };
