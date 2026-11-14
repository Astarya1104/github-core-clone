// MCP: JSON-RPC 2.0 Streamable HTTP, modern era (2026-07-28 discover).
// Tools act on the same store as REST. Pure function; app.ts does HTTP plumbing.
import { VIEWER_LOGIN, type Store, type Repo } from './store.ts';
import { mergePull, diffFiles } from './rest.ts';

export interface McpResult {
  status: number;
  body: unknown;
}

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
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(data: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function pickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: string }): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = String(pickArg(args, 'owner', 'owner_login', 'org') ?? '');
  const repoName = String(pickArg(args, 'repo', 'repository') ?? '');
  const getRepo = (): Repo | null => {
    if (owner !== VIEWER_LOGIN) return null;
    return store.get(owner, repoName) ?? null;
  };
  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(pickArg(args, 'name') ?? '');
      if (repoNameArg === '') return toolError('name is required');
      if (store.get(VIEWER_LOGIN, repoNameArg) !== undefined) {
        return toolResult(repoJson(store.get(VIEWER_LOGIN, repoNameArg) as Repo));
      }
      const repo = store.create(
        VIEWER_LOGIN,
        repoNameArg,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = getRepo();
      if (repo === null) return toolError('repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = getRepo();
      if (repo === null) return toolError('repository not found');
      const title = String(pickArg(args, 'title') ?? '');
      if (title === '') return toolError('title is required');
      const body = String(pickArg(args, 'body', 'description') ?? '');
      const issue = {
        number: repo.nextIssue,
        title,
        body,
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as Array<{ id: number; body: string }>,
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = getRepo();
      if (repo === null) return toolError('repository not found');
      const state = String(pickArg(args, 'state') ?? 'open');
      const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const items = list.map((issue) => issueJson(repo, issue));
      return {
        content: [{ type: 'text', text: JSON.stringify(items) }],
        structuredContent: { issues: items },
      };
    }
    case 'create_pull_request': {
      const repo = getRepo();
      if (repo === null) return toolError('repository not found');
      const title = String(pickArg(args, 'title') ?? '');
      const head = String(pickArg(args, 'head', 'head_ref') ?? '');
      const base = String(pickArg(args, 'base', 'base_ref') ?? '');
      if (title === '' || head === '' || base === '') return toolError('title, head and base are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return toolError('head or base branch does not exist');
      const pull = {
        number: repo.nextPull,
        title,
        body: String(pickArg(args, 'body', 'description') ?? ''),
        state: 'open' as const,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        files: diffFiles(repo, baseSha, headSha),
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      return toolResult({
        id: repo.id * 1000000 + pull.number,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        head: { ref: head, sha: headSha },
        base: { ref: base, sha: baseSha },
      });
    }
    case 'merge_pull_request': {
      const repo = getRepo();
      if (repo === null) return toolError('repository not found');
      const number = Number(pickArg(args, 'pull_number', 'number'));
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolError('pull request not found');
      const merged = mergePull(repo, pull);
      if (!merged.ok) return toolError(merged.message);
      return toolResult({ number: pull.number, merged: true, sha: merged.sha, state: 'closed' });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export function handleMcp(store: Store, body: unknown): McpResult {
  const request = (body ?? {}) as {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (id === undefined || id === null) {
    // Notification: no response body.
    return { status: 202, body: null };
  }
  const ok = (result: unknown): McpResult => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const fail = (code: number, message: string): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });
  if (method === 'server/discover') {
    const serverInfo = { name: 'forge', version: '1.0' };
    return ok({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    });
  }
  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => entry.name === toolName);
    if (tool === undefined) return fail(-32602, `unknown tool ${toolName}`);
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        return ok(toolError(`missing required argument ${required}`));
      }
    }
    return ok(callTool(store, toolName, args));
  }
  if (method === 'initialize') {
    const serverInfo = { name: 'forge', version: '1.0' };
    return ok({
      protocolVersion: '2026-07-28',
      capabilities: { tools: {} },
      serverInfo,
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  return fail(-32601, `method not found: ${method}`);
}

export function mcpParseError(): McpResult {
  return {
    status: 400,
    body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
  };
}
