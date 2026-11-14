// GraphQL v4 surface: a small parser + executor for exactly the documents the
// suite sends (viewer, repository fields, introspection, issues/PRs, node,
// mutations). Unknown fields answer 200 with an errors array naming them.
import {
  VIEWER_LOGIN,
  flattenTree,
  parseCommit,
  type Repo,
  type Store,
  type FlatEntry,
  type Pull,
} from './store.ts';
import { mergePull, diffFiles } from './rest.ts';

// ---------------------------------------------------------------- lexer/parser

type ValueNode =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<[string, ValueNode]> };

interface FieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selection: Selection[];
}
interface InlineSel {
  kind: 'inline';
  typeCondition: string | null;
  selection: Selection[];
}
type Selection = FieldSel | InlineSel;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  selection: Selection[];
}

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      while (j < input.length && /[0-9.eE+-]/.test(input[j] as string)) {
        if (input[j] === '.' || input[j] === 'e' || input[j] === 'E') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.value}`);
    }
  }
  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        operations.push(this.parseOperation(token.value as 'query' | 'mutation'));
      } else if (token.kind === 'punct' && token.value === '{') {
        this.pos -= 1;
        operations.push({ kind: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        // Named fragments are skipped: the suite uses inline fragments only.
        // Consume the fragment definition so parsing stays in sync.
        this.parseFragmentDefinition();
      } else {
        throw new Error(`unexpected token ${token.value}`);
      }
    }
    return operations;
  }
  parseFragmentDefinition(): void {
    this.next(); // fragment name
    const on = this.next();
    if (on.value !== 'on') throw new Error('expected on in fragment');
    this.next(); // type name
    this.parseSelectionSet();
  }
  parseOperation(kind: 'query' | 'mutation'): Operation {
    let name: string | null = null;
    const token = this.peek();
    if (token !== undefined && token.kind === 'name') {
      name = this.next().value;
    }
    const paren = this.peek();
    if (paren !== undefined && paren.kind === 'punct' && paren.value === '(') {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const t = this.next();
        if (t.kind === 'punct' && t.value === '(') depth += 1;
        if (t.kind === 'punct' && t.value === ')') depth -= 1;
      }
    }
    const selection = this.parseSelectionSet();
    return { kind, name, selection };
  }
  parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        break;
      }
      if (token.kind === 'spread') {
        this.next();
        const next = this.peek();
        let typeCondition: string | null = null;
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          typeCondition = this.next().value;
        }
        const selection = this.parseSelectionSet();
        selections.push({ kind: 'inline', typeCondition, selection });
        continue;
      }
      selections.push(this.parseField());
    }
    return selections;
  }
  parseField(): FieldSel {
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected field name');
    let alias: string | null = null;
    let name = first.value;
    const colon = this.peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, ValueNode> = {};
    const paren = this.peek();
    if (paren !== undefined && paren.kind === 'punct' && paren.value === '(') {
      this.next();
      for (;;) {
        const token = this.peek();
        if (token === undefined) throw new Error('unterminated arguments');
        if (token.kind === 'punct' && token.value === ')') {
          this.next();
          break;
        }
        const argName = this.next().value;
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    let selection: Selection[] = [];
    const brace = this.peek();
    if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }
  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'var', name: this.next().value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === ']') {
          this.next();
          break;
        }
        values.push(this.parseValue());
      }
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<[string, ValueNode]> = [];
      for (;;) {
        const next = this.peek();
        if (next !== undefined && next.kind === 'punct' && next.value === '}') {
          this.next();
          break;
        }
        const fieldName = this.next().value;
        this.expectPunct(':');
        fields.push([fieldName, this.parseValue()]);
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- execution

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, value] of node.fields) out[name] = resolveValue(value, variables);
      return out;
    }
  }
}

function gid(kind: string, parts: string[]): string {
  return Buffer.from(`${kind}:${parts.join('/')}`, 'utf8').toString('base64');
}
function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { kind: decoded.slice(0, colon), parts: decoded.slice(colon + 1).split('/') };
  } catch {
    return null;
  }
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequest',
    'pullRequests',
  ],
  SearchType: [],
};

function typeFieldNames(typeName: string): string[] {
  switch (typeName) {
    case 'Issue':
      return ['id', 'number', 'title', 'state', 'body'];
    case 'PullRequest':
      return ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
    case 'Repository':
      return ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests'];
    case 'SearchType':
      return [];
    default:
      return [];
  }
}

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type Obj = Record<string, unknown> & { __typename: string };

function issueState(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}
function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function repoObj(repo: Repo): Obj {
  return { __typename: 'Repository', __repo: repo };
}
function issueObj(repo: Repo, issue: { number: number; title: string; body: string; state: string }): Obj {
  return { __typename: 'Issue', __repo: repo, __issue: issue };
}
function pullObj(repo: Repo, pull: Pull): Obj {
  return { __typename: 'PullRequest', __repo: repo, __pull: pull };
}

function mergeableOf(repo: Repo, pull: Pull): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const baseAtCreateFlat: FlatEntry[] = [];
  const baseNowFlat: FlatEntry[] = [];
  const headFlat: FlatEntry[] = [];
  const atCreate = repo.objects.get(pull.baseSha);
  const now = repo.objects.get(baseTip);
  const head = repo.objects.get(headTip);
  if (atCreate !== undefined && atCreate.type === 'commit') flattenTree(repo, parseCommit(atCreate.data).tree, '', baseAtCreateFlat);
  if (now !== undefined && now.type === 'commit') flattenTree(repo, parseCommit(now.data).tree, '', baseNowFlat);
  if (head !== undefined && head.type === 'commit') flattenTree(repo, parseCommit(head.data).tree, '', headFlat);
  const before = new Map(baseAtCreateFlat.map((entry) => [entry.path, entry.oid]));
  const current = new Map(baseNowFlat.map((entry) => [entry.path, entry.oid]));
  const wanted = new Map(headFlat.map((entry) => [entry.path, entry.oid]));
  for (const file of pull.files) {
    const b = before.get(file.filename);
    const c = current.get(file.filename);
    const w = wanted.get(file.filename);
    if (b !== c && b !== w && c !== w) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function executeSelection(obj: Obj, selection: Selection[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== obj.__typename) continue;
      Object.assign(out, executeSelection(obj, sel.selection, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name;
    out[key] = resolveField(obj, sel, ctx);
  }
  return out;
}

function unknownField(ctx: Ctx, typeName: string, field: string): null {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
  return null;
}

function resolveField(obj: Obj, field: FieldSel, ctx: Ctx): unknown {
  const typeName = obj.__typename;
  const args: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(field.args)) args[name] = resolveValue(node, ctx.variables);
  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      if (field.selection.length === 0) return { login: VIEWER_LOGIN };
      return executeSelection({ __typename: 'Viewer', login: VIEWER_LOGIN }, field.selection, ctx);
    }
    if (field.name === 'repository') {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER_LOGIN) return null;
      const repo = ctx.store.get(owner, name);
      if (repo === undefined) return null;
      if (field.selection.length === 0) return repoObj(repo);
      return executeSelection(repoObj(repo), field.selection, ctx);
    }
    if (field.name === 'node') {
      const parsed = parseGid(String(args.id ?? ''));
      if (parsed === null) return null;
      if (parsed.kind === 'repo' && parsed.parts.length === 2) {
        const repo = ctx.store.get(parsed.parts[0] as string, parsed.parts[1] as string);
        if (repo === undefined) return null;
        return executeSelection(repoObj(repo), field.selection, ctx);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      return resolveIntrospection(name, field.selection, ctx);
    }
    if (field.name === '__schema') {
      return executeSelection({ __typename: '__Schema', types: [] }, field.selection, ctx);
    }
    return unknownField(ctx, 'Query', field.name);
  }
  if (typeName === 'Viewer') {
    if (field.name === 'login') return VIEWER_LOGIN;
    return unknownField(ctx, 'Viewer', field.name);
  }
  if (typeName === 'Repository') {
    const repo = obj.__repo as Repo;
    switch (field.name) {
      case 'id':
        return gid('repo', [repo.owner, repo.name]);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return executeSelection({ __typename: 'User', login: repo.owner }, field.selection, ctx);
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return executeSelection({ __typename: 'Ref', name: repo.defaultBranch }, field.selection, ctx);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = Number(args.number);
        const issue = repo.issues.find((entry) => entry.number === number);
        if (issue === undefined) return null;
        return executeSelection(issueObj(repo, issue), field.selection, ctx);
      }
      case 'issues': {
        return resolveIssueConnection(repo, args, field.selection, ctx);
      }
      case 'pullRequest': {
        const number = Number(args.number);
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (pull === undefined) return null;
        return executeSelection(pullObj(repo, pull), field.selection, ctx);
      }
      case 'pullRequests': {
        return resolvePullConnection(repo, args, field.selection, ctx);
      }
      default:
        return unknownField(ctx, 'Repository', field.name);
    }
  }
  if (typeName === 'User') {
    if (field.name === 'login') return obj.login as string;
    return unknownField(ctx, 'User', field.name);
  }
  if (typeName === 'Ref') {
    if (field.name === 'name') return obj.name as string;
    return unknownField(ctx, 'Ref', field.name);
  }
  if (typeName === 'Issue') {
    const issue = obj.__issue as { number: number; title: string; body: string; state: string };
    const repo = obj.__repo as Repo;
    switch (field.name) {
      case 'id':
        return gid('issue', [repo.owner, repo.name, String(issue.number)]);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return issueState(issue.state);
      case 'body':
        return issue.body;
      default:
        return unknownField(ctx, 'Issue', field.name);
    }
  }
  if (typeName === 'PullRequest') {
    const pull = obj.__pull as Pull;
    const repo = obj.__repo as Repo;
    switch (field.name) {
      case 'id':
        return gid('pr', [repo.owner, repo.name, String(pull.number)]);
      case 'number':
        return pull.number;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return mergeableOf(repo, pull);
      case 'state':
        return pullState(pull);
      case 'merged':
        return pull.merged;
      case 'files': {
        const first = typeof args.first === 'number' ? args.first : 10;
        const nodes: Obj[] = pull.files.slice(0, first).map((file) => ({ __typename: 'PullRequestFile', path: file.filename }));
        const conn: Obj = { __typename: 'FileConnection', __nodes: nodes };
        if (field.selection.length === 0) return { nodes };
        return executeSelection(conn, field.selection, ctx);
      }
      default:
        return unknownField(ctx, 'PullRequest', field.name);
    }
  }
  if (typeName === 'PullRequestFile') {
    if (field.name === 'path') return obj.path as string;
    return unknownField(ctx, 'PullRequestFile', field.name);
  }
  if (typeName === 'FileConnection') {
    if (field.name === 'nodes') {
      const nodes = obj.__nodes as Obj[];
      return nodes.map((node) => (field.selection.length > 0 ? executeSelection(node, field.selection, ctx) : node));
    }
    if (field.name === 'totalCount') return (obj.__nodes as unknown[]).length;
    return unknownField(ctx, 'FileConnection', field.name);
  }
  if (typeName === 'IssueConnection' || typeName === 'PullConnection') {
    if (field.name === 'nodes') return obj.__nodes as unknown[];
    if (field.name === 'pageInfo') {
      const pageInfo = obj.__pageInfo as Record<string, unknown>;
      return field.selection.length > 0
        ? executeSelection({ __typename: 'PageInfo', ...pageInfo }, field.selection, ctx)
        : pageInfo;
    }
    if (field.name === 'totalCount') return (obj.__nodes as unknown[]).length;
    return unknownField(ctx, typeName, field.name);
  }
  if (typeName === 'PageInfo') {
    if (field.name === 'hasNextPage') return obj.hasNextPage as boolean;
    if (field.name === 'hasPreviousPage') return obj.hasPreviousPage as boolean;
    if (field.name === 'endCursor') return (obj.endCursor as string | null) ?? null;
    if (field.name === 'startCursor') return (obj.startCursor as string | null) ?? null;
    return unknownField(ctx, 'PageInfo', field.name);
  }
  if (typeName === 'Mutation') {
    return resolveMutation(obj, field, ctx);
  }
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field.name === 'issue') {
      const issueValue = issueObj(obj.__repo as Repo, obj.__issue as { number: number; title: string; body: string; state: string });
      return field.selection.length > 0 ? executeSelection(issueValue, field.selection, ctx) : issueValue;
    }
    return unknownField(ctx, typeName, field.name);
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') {
      const pullValue = pullObj(obj.__repo as Repo, obj.__pull as Pull);
      return field.selection.length > 0 ? executeSelection(pullValue, field.selection, ctx) : pullValue;
    }
    return unknownField(ctx, typeName, field.name);
  }
  if (typeName === 'IssueCommentEdge') {
    if (field.name === 'node') {
      const nodeValue = obj.__node as Obj;
      return field.selection.length > 0 ? executeSelection(nodeValue, field.selection, ctx) : nodeValue;
    }
    return unknownField(ctx, typeName, field.name);
  }
  if (typeName === 'Comment') {
    if (field.name === 'id') return obj.id as string;
    if (field.name === 'body') return obj.body as string;
    return unknownField(ctx, typeName, field.name);
  }
  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field.name === 'name') return obj.name as string;
    return unknownField(ctx, typeName, field.name);
  }
  if (typeName === '__Type') {
    return resolveTypeField(obj, field, ctx);
  }
  if (typeName === '__Schema') {
    if (field.name === 'types') return [];
    return unknownField(ctx, '__Schema', field.name);
  }
  return unknownField(ctx, typeName, field.name);
}

function resolveIntrospection(name: string, selection: Selection[], ctx: Ctx): unknown {
  const known = ['Issue', 'PullRequest', 'Repository', 'SearchType'];
  if (!known.includes(name)) return null;
  const isEnum = name === 'SearchType';
  const typeObj: Obj = {
    __typename: '__Type',
    __typeName: name,
    __kind: isEnum ? 'ENUM' : 'OBJECT',
    __fields: typeFieldNames(name).map((fieldName) => ({ name: fieldName })),
    __enumValues: isEnum ? [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }] : [],
  };
  if (selection.length === 0) return typeObj;
  return executeSelection(typeObj, selection, ctx);
}

function resolveTypeField(obj: Obj, field: FieldSel, ctx: Ctx): unknown {
  switch (field.name) {
    case 'name':
      return obj.__typeName as string;
    case 'kind':
      return obj.__kind as string;
    case 'fields': {
      const fields = obj.__fields as Array<{ name: string }>;
      return fields.map((entry) => {
        const fieldObj: Obj = { __typename: '__Field', name: entry.name };
        return field.selection.length > 0 ? executeSelection(fieldObj, field.selection, ctx) : { name: entry.name };
      });
    }
    case 'enumValues': {
      const values = obj.__enumValues as Array<{ name: string }>;
      return values.map((entry) => {
        const valueObj: Obj = { __typename: '__EnumValue', name: entry.name };
        return field.selection.length > 0 ? executeSelection(valueObj, field.selection, ctx) : { name: entry.name };
      });
    }
    default:
      if (field.name === 'description') return null;
      return unknownField(ctx, '__Type', field.name);
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    if (!decoded.startsWith('cursor:')) return null;
    const number = Number(decoded.slice('cursor:'.length));
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

function resolveIssueConnection(repo: Repo, args: Record<string, unknown>, selection: Selection[], ctx: Ctx): unknown {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  let list = [...repo.issues];
  if (states !== null) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state)));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.number - b.number) * direction);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  let start = 0;
  if (after !== null) {
    const index = list.findIndex((issue) => issue.number === after);
    start = index < 0 ? list.length : index + 1;
  }
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null;
  const nodes = page.map((issue) => issueObj(repo, issue));
  const conn: Obj = {
    __typename: 'IssueConnection',
    __nodes: nodes,
    __pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      endCursor,
      startCursor: page.length > 0 ? cursorFor(page[0]?.number as number) : null,
    },
  };
  if (selection.length === 0) return { nodes, pageInfo: conn.__pageInfo };
  // Resolve nodes with their own selections.
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'inline') continue;
    if (sel.name === 'nodes') {
      out[sel.alias ?? 'nodes'] = nodes.map((node) =>
        sel.selection.length > 0 ? executeSelection(node, sel.selection, ctx) : node,
      );
    } else if (sel.name === 'pageInfo') {
      out[sel.alias ?? 'pageInfo'] = executeSelection(
        { __typename: 'PageInfo', ...(conn.__pageInfo as Record<string, unknown>) },
        sel.selection,
        ctx,
      );
    } else if (sel.name === 'totalCount') {
      out[sel.alias ?? 'totalCount'] = list.length;
    } else {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "IssueConnection".` });
      out[sel.alias ?? sel.name] = null;
    }
  }
  return out;
}

function resolvePullConnection(repo: Repo, args: Record<string, unknown>, selection: Selection[], ctx: Ctx): unknown {
  const first = typeof args.first === 'number' ? args.first : repo.pulls.length;
  const after = typeof args.after === 'string' ? numberFromCursor(args.after) : null;
  let list = [...repo.pulls];
  let start = 0;
  if (after !== null) {
    const index = list.findIndex((pull) => pull.number === after);
    start = index < 0 ? list.length : index + 1;
  }
  const page = list.slice(start, start + first);
  const hasNextPage = start + page.length < list.length;
  const nodes = page.map((pull) => pullObj(repo, pull));
  const conn: Obj = {
    __typename: 'PullConnection',
    __nodes: nodes,
    __pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null,
      startCursor: page.length > 0 ? cursorFor(page[0]?.number as number) : null,
    },
  };
  if (selection.length === 0) return { nodes, pageInfo: conn.__pageInfo };
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'inline') continue;
    if (sel.name === 'nodes') {
      out[sel.alias ?? 'nodes'] = nodes.map((node) =>
        sel.selection.length > 0 ? executeSelection(node, sel.selection, ctx) : node,
      );
    } else if (sel.name === 'pageInfo') {
      out[sel.alias ?? 'pageInfo'] = executeSelection(
        { __typename: 'PageInfo', ...(conn.__pageInfo as Record<string, unknown>) },
        sel.selection,
        ctx,
      );
    } else if (sel.name === 'totalCount') {
      out[sel.alias ?? 'totalCount'] = list.length;
    } else {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "PullRequestConnection".` });
      out[sel.alias ?? sel.name] = null;
    }
  }
  return out;
}

function resolveMutation(obj: Obj, field: FieldSel, ctx: Ctx): unknown {
  const args: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(field.args)) args[name] = resolveValue(node, ctx.variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  if (field.name === 'createIssue') {
    const parsed = parseGid(String(input.repositoryId ?? ''));
    if (parsed === null || parsed.kind !== 'repo' || parsed.parts.length !== 2) return null;
    const repo = ctx.store.get(parsed.parts[0] as string, parsed.parts[1] as string);
    if (repo === undefined) return null;
    const title = String(input.title ?? '');
    const issue = {
      number: repo.nextIssue,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open' as const,
      labels: [] as string[],
      comments: [] as Array<{ id: number; body: string }>,
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    const result: Obj = { __typename: 'CreateIssuePayload', __issue: issue, __repo: repo };
    return field.selection.length > 0 ? executeSelection(result, field.selection, ctx) : result;
  }
  if (field.name === 'closeIssue') {
    const parsed = parseGid(String(input.issueId ?? ''));
    if (parsed === null || parsed.kind !== 'issue' || parsed.parts.length !== 3) return null;
    const repo = ctx.store.get(parsed.parts[0] as string, parsed.parts[1] as string);
    if (repo === undefined) return null;
    const issue = repo.issues.find((entry) => entry.number === Number(parsed.parts[2]));
    if (issue === undefined) return null;
    issue.state = 'closed';
    const result: Obj = { __typename: 'CloseIssuePayload', __issue: issue, __repo: repo };
    return field.selection.length > 0 ? executeSelection(result, field.selection, ctx) : result;
  }
  if (field.name === 'createPullRequest') {
    const parsed = parseGid(String(input.repositoryId ?? ''));
    if (parsed === null || parsed.kind !== 'repo' || parsed.parts.length !== 2) return null;
    const repo = ctx.store.get(parsed.parts[0] as string, parsed.parts[1] as string);
    if (repo === undefined) return null;
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const pull: Pull = {
      number: repo.nextPull,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      files: diffFiles(repo, baseSha, headSha),
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    const result: Obj = { __typename: 'CreatePullRequestPayload', __pull: pull, __repo: repo };
    return field.selection.length > 0 ? executeSelection(result, field.selection, ctx) : result;
  }
  if (field.name === 'mergePullRequest') {
    const parsed = parseGid(String(input.pullRequestId ?? ''));
    if (parsed === null || parsed.kind !== 'pr' || parsed.parts.length !== 3) return null;
    const repo = ctx.store.get(parsed.parts[0] as string, parsed.parts[1] as string);
    if (repo === undefined) return null;
    const pull = repo.pulls.find((entry) => entry.number === Number(parsed.parts[2]));
    if (pull === undefined) return null;
    const merged = mergePull(repo, pull);
    if (!merged.ok) return null;
    const result: Obj = { __typename: 'MergePullRequestPayload', __pull: pull, __repo: repo };
    return field.selection.length > 0 ? executeSelection(result, field.selection, ctx) : result;
  }
  if (field.name === 'addComment') {
    const parsed = parseGid(String(input.subjectId ?? ''));
    if (parsed === null || parsed.kind !== 'issue' || parsed.parts.length !== 3) return null;
    const repo = ctx.store.get(parsed.parts[0] as string, parsed.parts[1] as string);
    if (repo === undefined) return null;
    const issue = repo.issues.find((entry) => entry.number === Number(parsed.parts[2]));
    if (issue === undefined) return null;
    const comment = { id: repo.nextCommentId, body: String(input.body ?? '') };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    const result: Obj = {
      __typename: 'AddCommentPayload',
      __comment: comment,
      __repo: repo,
    };
    if (field.selection.length === 0) return result;
    // commentEdge { node { id body } }
    const out: Record<string, unknown> = {};
    for (const sel of field.selection) {
      if (sel.kind === 'inline') continue;
      if (sel.name === 'commentEdge') {
        const nodeObj: Obj = {
          __typename: 'Comment',
          id: gid('comment', [repo.owner, repo.name, String(issue.number), String(comment.id)]),
          body: comment.body,
        };
        const edgeObj: Obj = { __typename: 'IssueCommentEdge', __node: nodeObj };
        out[sel.alias ?? 'commentEdge'] = executeSelection(edgeObj, sel.selection, ctx);
      } else if (sel.name === 'comment') {
        const nodeObj: Obj = {
          __typename: 'Comment',
          id: gid('comment', [repo.owner, repo.name, String(issue.number), String(comment.id)]),
          body: comment.body,
        };
        out[sel.alias ?? 'comment'] = executeSelection(nodeObj, sel.selection, ctx);
      } else {
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "AddCommentPayload".` });
        out[sel.alias ?? sel.name] = null;
      }
    }
    return out;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

export function handleGraphql(store: Store, body: unknown): { status: number; body: unknown } {
  const docs = Array.isArray(body) ? body : [body];
  const results: unknown[] = [];
  for (const doc of docs) {
    const item = (doc ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
    const query = typeof item.query === 'string' ? item.query : '';
    const variables = (item.variables ?? {}) as Record<string, unknown>;
    const ctx: Ctx = { store, variables, errors: [] };
    try {
      const operations = new Parser(lex(query)).parseDocument();
      if (operations.length === 0) throw new Error('empty document');
      const operation = operations[0] as Operation;
      let data: Record<string, unknown>;
      if (operation.kind === 'mutation') {
        data = executeSelection({ __typename: 'Mutation' }, operation.selection, ctx);
      } else {
        data = executeSelection({ __typename: 'Query' }, operation.selection, ctx);
      }
      const result: Record<string, unknown> = { data };
      if (ctx.errors.length > 0) result.errors = ctx.errors;
      results.push(result);
    } catch (err) {
      results.push({
        data: null,
        errors: [{ message: err instanceof Error ? err.message : 'parse error' }],
      });
    }
  }
  return { status: 200, body: Array.isArray(body) ? results : results[0] };
}
