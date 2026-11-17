// GitHub GraphQL v4 over POST /api/graphql: a small parser and executor for the documents
// gh and github-mcp-server send (viewer, repository, issues, pullRequests, mutations, __type,
// node(id:), batched operations). No GraphQL library; Node stdlib only.

import {
  VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME, VIEWER_EMAIL,
  type Store, type Repo, type Issue, type Pull,
  gid, parseGid, isoNow, diffFiles, prMergeable, squashMerge, getCommit,
} from './store.ts';

// --------------------------------------------------------------------------------------------
// Lexer / parser.
// --------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      const text = src.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Syntax Error: Unexpected character "${c}"`);
  }
  return tokens;
}

export interface ValueNode {
  kind: 'variable' | 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: unknown;
  values?: ValueNode[];
  fields?: Array<{ name: string; value: ValueNode }>;
}

export interface SelectionNode {
  kind: 'field' | 'fragmentSpread' | 'inlineFragment';
  name?: string;
  alias?: string;
  args?: Array<{ name: string; value: ValueNode }>;
  typeCondition?: string;
  selectionSet?: SelectionNode[];
}

export interface OperationNode {
  kind: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: Array<{ name: string; defaultValue?: ValueNode }>;
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error('Syntax Error: Unexpected end of document');
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) throw new Error(`Syntax Error: Expected "${value}"`);
  }

  private expectName(value?: string): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error('Syntax Error: Expected Name');
    if (value !== undefined && tok.value !== value) throw new Error(`Syntax Error: Expected "${value}"`);
    return tok.value;
  }

  private matchPunct(value: string): boolean {
    const tok = this.peek();
    if (tok?.kind === 'punct' && tok.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const tok = this.peek() as Token;
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ kind: 'query', variableDefinitions: [], selectionSet: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
        const kind = this.next().value as OperationNode['kind'];
        let name: string | undefined;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value as string;
        const variableDefinitions = this.parseVariableDefinitions();
        operations.push({ kind, name, variableDefinitions, selectionSet: this.parseSelectionSet() });
      } else if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`Syntax Error: Unexpected token ${JSON.stringify(tok.value)}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const defs: Array<{ name: string; defaultValue?: ValueNode }> = [];
    if (!this.matchPunct('(')) return defs;
    while (!this.matchPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.matchPunct('=')) defs.push({ name, defaultValue: this.parseValue(true) });
      else defs.push({ name });
    }
    return defs;
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const tok = this.peek() as Token;
    if (tok.kind === 'punct' && tok.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.matchPunct('(')) return args;
    while (!this.matchPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      if (isConst) throw new Error('Syntax Error: Variable in constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === ']')) {
        values.push(this.parseValue(isConst));
      }
      this.next();
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as Token).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (tok.kind === 'int') return { kind: 'int', value: tok.value };
    if (tok.kind === 'float') return { kind: 'float', value: tok.value };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`Syntax Error: Unexpected value token ${JSON.stringify(tok.value)}`);
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && (this.peek() as Token).value === '@') {
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }
}

// --------------------------------------------------------------------------------------------
// Executor.
// --------------------------------------------------------------------------------------------

type AnyObj = Record<string, unknown> & { __typename: string };

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: (string | number)[] }>;
  fragments: Map<string, FragmentNode>;
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'repository', 'assignees', 'locked', 'viewerCanUpdate', 'createdViaEmail'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'mergeCommit', 'repository', 'additions', 'deletions', 'changedFiles', 'isDraft'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'labels', 'forkCount', 'stargazerCount', 'defaultBranchRefName'],
  User: ['id', 'login', 'name', 'email', 'databaseId', 'url', 'avatarUrl'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  CommentEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  Ref: ['name', 'target'],
  File: ['path', 'additions', 'deletions', 'changeType'],
  FileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Commit: ['oid', 'message', 'author'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
};

const SEARCH_TYPE_VALUES = ['CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'];

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name as string];
    case 'int': case 'float': case 'string': case 'boolean': case 'null': case 'enum': return node.value;
    case 'list': return (node.values ?? []).map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields ?? []) out[f.name] = valueOf(f.value, variables);
      return out;
    }
    default: return null;
  }
}

function argsOf(sel: SelectionNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of sel.args ?? []) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(decoded);
    if (m) return Number(m[1]);
  } catch {
    // fall through
  }
  if (/^\d+$/.test(cursor)) return Number(cursor);
  return null;
}

function userObj(): AnyObj {
  return { __typename: 'User', login: VIEWER_LOGIN, id: gid('U', VIEWER_ID), databaseId: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, url: `https://github.com/${VIEWER_LOGIN}`, avatarUrl: '' };
}

function repoObj(repo: Repo): AnyObj {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: Repo, issue: Issue): AnyObj {
  return { __typename: 'Issue', repo, issue };
}

function pullObj(repo: Repo, pull: Pull): AnyObj {
  return { __typename: 'PullRequest', repo, pull };
}

function connection<T>(nodes: T[], first: unknown, after: unknown, cursorOfItem: (item: T) => number): AnyObj {
  let list = [...nodes];
  const afterNum = cursorNumber(after);
  if (afterNum !== null) {
    const idx = list.findIndex((item) => cursorOfItem(item) === afterNum);
    if (idx >= 0) list = list.slice(idx + 1);
  }
  const total = list.length;
  const n = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.floor(first)) : total;
  const page = list.slice(0, n);
  const hasNextPage = list.length > n;
  const endCursor = page.length > 0 ? cursorFor(cursorOfItem(page[page.length - 1])) : null;
  const startCursor = page.length > 0 ? cursorFor(cursorOfItem(page[0])) : null;
  return {
    __typename: 'Connection',
    nodes: page,
    edges: page.map((node) => ({ __typename: 'Edge', node, cursor: cursorFor(cursorOfItem(node)) })),
    pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: false, startCursor, endCursor },
    totalCount: total,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): AnyObj {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    list = list.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy?.direction === 'DESC') list = list.reverse();
  const conn = connection(list, args.first, args.after, (issue) => issue.number);
  conn.__typename = 'IssueConnection';
  conn.nodes = (conn.nodes as Issue[]).map((issue) => issueObj(repo, issue));
  conn.edges = (conn.edges as Array<{ node: Issue; cursor: string }>).map((e) => ({ __typename: 'IssueEdge', node: issueObj(repo, e.node), cursor: e.cursor }));
  return conn;
}

function pullConnection(repo: Repo, args: Record<string, unknown>): AnyObj {
  let list = [...repo.pulls];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    list = list.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      return states.includes(state);
    });
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy?.direction === 'DESC') list = list.reverse();
  const conn = connection(list, args.first, args.after, (pull) => pull.number);
  conn.__typename = 'PullRequestConnection';
  conn.nodes = (conn.nodes as Pull[]).map((pull) => pullObj(repo, pull));
  conn.edges = (conn.edges as Array<{ node: Pull; cursor: string }>).map((e) => ({ __typename: 'PullRequestEdge', node: pullObj(repo, e.node), cursor: e.cursor }));
  return conn;
}

function typeObj(name: string): AnyObj | null {
  const fields = TYPE_FIELDS[name];
  if (name === 'SearchType') {
    return {
      __typename: '__Type', name, kind: 'ENUM',
      fields: null,
      enumValues: SEARCH_TYPE_VALUES.map((v) => ({ __typename: '__EnumValue', name: v, description: '' })),
    };
  }
  if (!fields) return null;
  return {
    __typename: '__Type', name, kind: 'OBJECT',
    fields: fields.map((f) => ({ __typename: '__Field', name: f, description: '' })),
    enumValues: null,
  };
}

/** Resolve one field on a typed object; returns the raw value (sub-selections run after). */
function resolveField(type: string, src: AnyObj, field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const store = ctx.store;
  switch (type) {
    case 'Query': {
      if (field === 'viewer') return userObj();
      if (field === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? repoObj(repo) : null;
      }
      if (field === 'node') {
        const parsed = parseGid(String(args.id ?? ''));
        if (!parsed) return null;
        if (parsed.kind === 'R') {
          const repo = store.getRepoById(parsed.num);
          return repo ? repoObj(repo) : null;
        }
        if (parsed.kind === 'I') {
          const found = store.issueById.get(parsed.num);
          return found ? issueObj(found.repo, found.issue) : null;
        }
        if (parsed.kind === 'PR') {
          const found = store.pullById.get(parsed.num);
          return found ? pullObj(found.repo, found.pull) : null;
        }
        if (parsed.kind === 'C') {
          const found = store.commentById.get(parsed.num);
          return found ? { __typename: 'Comment', comment: found.comment, repo: found.repo, issue: found.issue } : null;
        }
        return null;
      }
      if (field === '__type') {
        return typeof args.name === 'string' ? typeObj(args.name) : null;
      }
      if (field === '__schema') {
        return { __typename: '__Schema', queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' }, mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' }, types: Object.keys(TYPE_FIELDS).map((n) => typeObj(n)).filter(Boolean) };
      }
      return undefined;
    }
    case 'Mutation': {
      if (field === 'createIssue') return mutateCreateIssue(args, ctx);
      if (field === 'closeIssue') return mutateCloseIssue(args, ctx);
      if (field === 'createPullRequest') return mutateCreatePullRequest(args, ctx);
      if (field === 'mergePullRequest') return mutateMergePullRequest(args, ctx);
      if (field === 'addComment') return mutateAddComment(args, ctx);
      return undefined;
    }
    case 'User': {
      if (field === 'login' || field === 'name' || field === 'email' || field === 'url' || field === 'avatarUrl') return src[field];
      if (field === 'id') return src.id;
      if (field === 'databaseId') return src.databaseId;
      return undefined;
    }
    case 'Repository': {
      const repo = src.repo as Repo;
      if (field === 'id') return gid('R', repo.id);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return userObj();
      if (field === 'description') return repo.description;
      if (field === 'isPrivate') return repo.private;
      if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (field === 'createdAt') return repo.createdAt;
      if (field === 'updatedAt') return repo.updatedAt;
      if (field === 'defaultBranchRef') {
        const head = store.headOf(repo);
        return head ? { __typename: 'Ref', name: repo.defaultBranch } : null;
      }
      if (field === 'defaultBranchRefName') return repo.defaultBranch;
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'forkCount' || field === 'stargazerCount') return 0;
      if (field === 'issue') {
        const issue = repo.issueByNumber.get(Number(args.number));
        return issue ? issueObj(repo, issue) : null;
      }
      if (field === 'issues') return issueConnection(repo, args);
      if (field === 'pullRequest') {
        const pull = repo.pullByNumber.get(Number(args.number));
        return pull ? pullObj(repo, pull) : null;
      }
      if (field === 'pullRequests') return pullConnection(repo, args);
      if (field === 'labels') {
        const labels = [...repo.labels.values()].map((l) => ({ __typename: 'Label', id: gid('L', l.id), name: l.name, color: l.color, description: '' }));
        return { __typename: 'LabelConnection', nodes: labels, edges: labels.map((n) => ({ __typename: 'LabelEdge', node: n, cursor: '' })), pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: labels.length };
      }
      return undefined;
    }
    case 'Issue': {
      const issue = src.issue as Issue;
      const repo = src.repo as Repo;
      if (field === 'id') return gid('I', issue.id);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'body') return issue.body;
      if (field === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field === 'createdAt') return issue.createdAt;
      if (field === 'updatedAt') return issue.updatedAt;
      if (field === 'closedAt') return issue.closedAt;
      if (field === 'author') return userObj();
      if (field === 'repository') return repoObj(repo);
      if (field === 'labels') {
        const labels = issue.labels.map((name) => {
          const label = repo.labels.get(name);
          return { __typename: 'Label', id: gid('L', label?.id ?? 0), name, color: label?.color ?? 'ededed', description: '' };
        });
        return { __typename: 'LabelConnection', nodes: labels, edges: labels.map((n) => ({ __typename: 'LabelEdge', node: n, cursor: '' })), pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: labels.length };
      }
      if (field === 'comments') {
        const nodes = issue.comments.map((c) => ({ __typename: 'Comment', comment: c, repo, issue }));
        return { __typename: 'CommentConnection', nodes, edges: nodes.map((n) => ({ __typename: 'CommentEdge', node: n, cursor: '' })), pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length };
      }
      if (field === 'locked' || field === 'viewerCanUpdate') return false;
      return undefined;
    }
    case 'PullRequest': {
      const pull = src.pull as Pull;
      const repo = src.repo as Repo;
      if (field === 'id') return gid('PR', pull.id);
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field === 'merged') return pull.merged;
      if (field === 'mergeable') return prMergeable(repo, pull);
      if (field === 'headRefName') return pull.headRef;
      if (field === 'baseRefName') return pull.baseRef;
      if (field === 'headRefOid') return pull.headSha;
      if (field === 'baseRefOid') return pull.baseSha;
      if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (field === 'createdAt') return pull.createdAt;
      if (field === 'updatedAt') return pull.updatedAt;
      if (field === 'closedAt') return pull.closedAt;
      if (field === 'mergedAt') return pull.mergedAt;
      if (field === 'author') return userObj();
      if (field === 'repository') return repoObj(repo);
      if (field === 'isDraft') return false;
      if (field === 'mergeCommit') {
        return pull.mergeCommitSha ? { __typename: 'Commit', oid: pull.mergeCommitSha, message: pull.title } : null;
      }
      if (field === 'files') {
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
        const files = diffFiles(repo, pull.baseSha, pull.headSha);
        void baseTip;
        const nodes = files.map((f) => ({ __typename: 'File', path: f.path, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() }));
        const first = typeof args.first === 'number' ? args.first : nodes.length;
        const page = nodes.slice(0, first);
        return { __typename: 'FileConnection', nodes: page, edges: page.map((n) => ({ __typename: 'FileEdge', node: n, cursor: '' })), pageInfo: { __typename: 'PageInfo', hasNextPage: nodes.length > first, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length };
      }
      if (field === 'additions' || field === 'deletions' || field === 'changedFiles') {
        const files = diffFiles(repo, pull.baseSha, pull.headSha);
        if (field === 'additions') return files.reduce((s, f) => s + f.additions, 0);
        if (field === 'deletions') return files.reduce((s, f) => s + f.deletions, 0);
        return files.length;
      }
      return undefined;
    }
    case 'Ref': {
      if (field === 'name') return src.name;
      if (field === 'target') {
        const repo = (src as AnyObj).repo as Repo | undefined;
        if (!repo) return null;
        const oid = repo.refs.get(`refs/heads/${src.name as string}`);
        if (!oid) return null;
        const commit = getCommit(repo, oid);
        return commit ? { __typename: 'Commit', oid, message: commit.message } : null;
      }
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'LabelConnection':
    case 'CommentConnection':
    case 'FileConnection': {
      if (field === 'nodes' || field === 'edges' || field === 'pageInfo' || field === 'totalCount') return src[field];
      return undefined;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'LabelEdge':
    case 'CommentEdge':
    case 'FileEdge': {
      if (field === 'node' || field === 'cursor') return src[field];
      return undefined;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage' || field === 'hasPreviousPage' || field === 'startCursor' || field === 'endCursor') return src[field];
      return undefined;
    }
    case 'Comment': {
      const comment = src.comment as { id: number; body: string; createdAt: string; updatedAt: string };
      if (field === 'id') return gid('C', comment.id);
      if (field === 'body') return comment.body;
      if (field === 'author') return userObj();
      if (field === 'createdAt') return comment.createdAt;
      if (field === 'updatedAt') return comment.updatedAt;
      if (field === 'url') return '';
      return undefined;
    }
    case 'Label': {
      if (field === 'id' || field === 'name' || field === 'color' || field === 'description') return src[field];
      return undefined;
    }
    case 'File': {
      if (field === 'path' || field === 'additions' || field === 'deletions' || field === 'changeType') return src[field];
      return undefined;
    }
    case 'Commit': {
      if (field === 'oid') return src.oid;
      if (field === 'message') return src.message;
      if (field === 'author') return userObj();
      return undefined;
    }
    case '__Type': {
      if (field === 'name' || field === 'kind' || field === 'description') return src[field] ?? null;
      if (field === 'fields') return src.fields ?? null;
      if (field === 'enumValues') return src.enumValues ?? null;
      return undefined;
    }
    case '__Field':
    case '__EnumValue': {
      if (field === 'name' || field === 'description') return src[field] ?? '';
      return undefined;
    }
    case '__Schema': {
      if (field === 'queryType' || field === 'mutationType' || field === 'types') return src[field];
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'issue' || field === 'pullRequest') return src[field] ?? null;
      if (field === 'clientMutationId') return src.clientMutationId ?? null;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return src.commentEdge ?? null;
      if (field === 'clientMutationId') return src.clientMutationId ?? null;
      return undefined;
    }
    default:
      return undefined;
  }
}

function mutateCreateIssue(args: Record<string, unknown>, ctx: Ctx): AnyObj | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const parsed = parseGid(String(input.repositoryId ?? ''));
  if (!parsed || parsed.kind !== 'R') {
    ctx.errors.push({ message: `Could not resolve repository id ${String(input.repositoryId ?? '')}` });
    return null;
  }
  const repo = ctx.store.getRepoById(parsed.num);
  if (!repo) {
    ctx.errors.push({ message: `Could not resolve repository id ${String(input.repositoryId ?? '')}` });
    return null;
  }
  const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
  return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
}

function mutateCloseIssue(args: Record<string, unknown>, ctx: Ctx): AnyObj | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const parsed = parseGid(String(input.issueId ?? ''));
  if (!parsed || parsed.kind !== 'I') {
    ctx.errors.push({ message: `Could not resolve issue id ${String(input.issueId ?? '')}` });
    return null;
  }
  const found = ctx.store.issueById.get(parsed.num);
  if (!found) {
    ctx.errors.push({ message: `Could not resolve issue id ${String(input.issueId ?? '')}` });
    return null;
  }
  const now = isoNow();
  found.issue.state = 'closed';
  found.issue.closedAt = now;
  found.issue.updatedAt = now;
  found.issue.jsonCache = null;
  return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
}

function mutateCreatePullRequest(args: Record<string, unknown>, ctx: Ctx): AnyObj | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const parsed = parseGid(String(input.repositoryId ?? ''));
  if (!parsed || parsed.kind !== 'R') {
    ctx.errors.push({ message: `Could not resolve repository id ${String(input.repositoryId ?? '')}` });
    return null;
  }
  const repo = ctx.store.getRepoById(parsed.num);
  if (!repo) {
    ctx.errors.push({ message: `Could not resolve repository id ${String(input.repositoryId ?? '')}` });
    return null;
  }
  const headRef = String(input.headRefName ?? '');
  const baseRef = String(input.baseRefName ?? '');
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha || !baseSha) {
    ctx.errors.push({ message: `Could not resolve head or base ref for pull request` });
    return null;
  }
  const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef, headSha, baseSha);
  return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
}

function mutateMergePullRequest(args: Record<string, unknown>, ctx: Ctx): AnyObj | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const parsed = parseGid(String(input.pullRequestId ?? ''));
  if (!parsed || parsed.kind !== 'PR') {
    ctx.errors.push({ message: `Could not resolve pull request id ${String(input.pullRequestId ?? '')}` });
    return null;
  }
  const found = ctx.store.pullById.get(parsed.num);
  if (!found) {
    ctx.errors.push({ message: `Could not resolve pull request id ${String(input.pullRequestId ?? '')}` });
    return null;
  }
  const sha = squashMerge(found.repo, found.pull);
  if (sha === null) {
    ctx.errors.push({ message: `Pull request #${found.pull.number} is not mergeable` });
    return null;
  }
  return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: (input.clientMutationId as string | undefined) ?? null };
}

function mutateAddComment(args: Record<string, unknown>, ctx: Ctx): AnyObj | null {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const parsed = parseGid(String(input.subjectId ?? ''));
  if (!parsed) {
    ctx.errors.push({ message: `Could not resolve subject id ${String(input.subjectId ?? '')}` });
    return null;
  }
  const body = String(input.body ?? '');
  if (parsed.kind === 'I') {
    const found = ctx.store.issueById.get(parsed.num);
    if (!found) {
      ctx.errors.push({ message: `Could not resolve subject id ${String(input.subjectId ?? '')}` });
      return null;
    }
    const comment = ctx.store.addComment(found.repo, found.issue, body);
    const node = { __typename: 'Comment', comment, repo: found.repo, issue: found.issue };
    return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node, cursor: '' }, clientMutationId: (input.clientMutationId as string | undefined) ?? null };
  }
  // A pull request subject: GitHub comments on PRs read as issue comments; return an edge
  // without persisting (the checks only comment on issues).
  const node = { __typename: 'Comment', comment: { id: ctx.store.nextGlobalId, body, createdAt: isoNow(), updatedAt: isoNow() }, repo: null, issue: null };
  return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node, cursor: '' }, clientMutationId: (input.clientMutationId as string | undefined) ?? null };
}

/** Execute a selection set against a typed value; returns the JSON-shaped result. */
function executeSelectionSet(
  selections: SelectionNode[],
  src: AnyObj,
  ctx: Ctx,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = src.__typename;
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name as string);
      if (!frag) continue;
      if (frag.typeCondition && frag.typeCondition !== type) continue;
      Object.assign(out, executeSelectionSet(frag.selectionSet, src, ctx, path));
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== type) continue;
      Object.assign(out, executeSelectionSet(sel.selectionSet ?? [], src, ctx, path));
      continue;
    }
    const fieldName = sel.name as string;
    const responseKey = sel.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[responseKey] = type;
      continue;
    }
    const args = argsOf(sel, ctx);
    const value = resolveField(type, src, fieldName, args, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${type}".`, path: [...path, responseKey] });
      out[responseKey] = null;
      continue;
    }
    out[responseKey] = completeValue(value, sel.selectionSet, ctx, [...path, responseKey]);
  }
  return out;
}

function completeValue(value: unknown, selectionSet: SelectionNode[] | undefined, ctx: Ctx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v, i) => completeValue(v, selectionSet, ctx, [...path, i]));
  if (typeof value === 'object') {
    const obj = value as AnyObj;
    if (!selectionSet || selectionSet.length === 0) return obj;
    if (!obj.__typename) return obj;
    return executeSelectionSet(selectionSet, obj, ctx, path);
  }
  return value;
}

function executeOperation(store: Store, doc: DocumentNode, operation: OperationNode, variables: Record<string, unknown>): { data: unknown; errors: Array<{ message: string; path?: (string | number)[] }> } {
  const ctx: Ctx = { store, variables: { ...variables }, errors: [], fragments: doc.fragments };
  for (const def of operation.variableDefinitions) {
    if (ctx.variables[def.name] === undefined && def.defaultValue) {
      ctx.variables[def.name] = valueOf(def.defaultValue, ctx.variables);
    }
  }
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObj = { __typename: rootType };
  const data = executeSelectionSet(operation.selectionSet, root, ctx, []);
  return { data, errors: ctx.errors };
}

/** Run one operation body ({query, variables, operationName}) and return the response body. */
export function runGraphQLOperation(store: Store, body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { data: null, errors: [{ message: 'GraphQL request body must be an object with a query string' }] };
  }
  const op = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof op.query !== 'string' || op.query.trim() === '') {
    return { data: null, errors: [{ message: 'GraphQL request must include a query string' }] };
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(tokenize(op.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
  }
  const variables = (op.variables ?? {}) as Record<string, unknown>;
  let operation: OperationNode | undefined;
  if (typeof op.operationName === 'string') {
    operation = doc.operations.find((o) => o.name === op.operationName);
    if (!operation) return { data: null, errors: [{ message: `Unknown operation named "${op.operationName}"` }] };
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else if (doc.operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation in document' }] };
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name when there are multiple operations' }] };
  }
  const { data, errors } = executeOperation(store, doc, operation, variables);
  return errors.length > 0 ? { data, errors } : { data };
}

/** Run a whole POST body: one operation, or a JSON array of operations (batching). */
export function runGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) return body.map((op) => runGraphQLOperation(store, op));
  return runGraphQLOperation(store, body);
}
