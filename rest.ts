// REST v3 surface. Pure functions over the store; app.ts does HTTP plumbing.
import {
  VIEWER_LOGIN,
  VIEWER_NAME,
  VIEWER_EMAIL,
  DEFAULT_BRANCH,
  trialNowSec,
  trialNowIso,
  buildCommit,
  flattenTree,
  parseCommit,
  putObject,
  readFileAt,
  treeFromFlat,
  type FlatEntry,
  type Issue,
  type Pull,
  type PullFile,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}
function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    html_url: `https://github.example/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN },
    comments: issue.comments.length,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    html_url: `https://github.example/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: repo.id * 1000000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN },
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    html_url: `https://github.example/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function requireRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.get(owner, name) ?? null;
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function commitChain(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

function countLines(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

export function diffFiles(repo: Repo, baseTip: string, headTip: string): PullFile[] {
  const baseFlat: FlatEntry[] = [];
  const headFlat: FlatEntry[] = [];
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(headTip);
  if (baseObj !== undefined && baseObj.type === 'commit') {
    flattenTree(repo, parseCommit(baseObj.data).tree, '', baseFlat);
  }
  if (headObj !== undefined && headObj.type === 'commit') {
    flattenTree(repo, parseCommit(headObj.data).tree, '', headFlat);
  }
  const baseMap = new Map(baseFlat.map((entry) => [entry.path, entry]));
  const headMap = new Map(headFlat.map((entry) => [entry.path, entry]));
  const files: PullFile[] = [];
  for (const [path, headEntry] of headMap) {
    const baseEntry = baseMap.get(path);
    if (baseEntry === undefined) {
      const blob = repo.objects.get(headEntry.oid);
      const additions = blob !== undefined ? countLines(blob.data.toString('utf8')) : 1;
      files.push({ filename: path, status: 'added', additions: Math.max(1, additions), deletions: 0, changes: Math.max(1, additions) });
    } else if (baseEntry.oid !== headEntry.oid) {
      const baseBlob = repo.objects.get(baseEntry.oid);
      const headBlob = repo.objects.get(headEntry.oid);
      const baseText = baseBlob !== undefined ? baseBlob.data.toString('utf8') : '';
      const headText = headBlob !== undefined ? headBlob.data.toString('utf8') : '';
      const baseLines = new Set(baseText.split('\n'));
      const headLines = new Set(headText.split('\n'));
      let additions = 0;
      let deletions = 0;
      for (const line of headLines) if (!baseLines.has(line)) additions += 1;
      for (const line of baseLines) if (!headLines.has(line)) deletions += 1;
      if (additions === 0 && deletions === 0) {
        additions = 1;
      }
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  for (const [path] of baseMap) {
    if (!headMap.has(path)) {
      files.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    }
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  return files;
}

function commitForContents(
  repo: Repo,
  branch: string,
  message: string,
  mutate: (entries: FlatEntry[]) => void,
): { commitOid: string; isNew: boolean } | { error: string } {
  const tip = branchTip(repo, branch);
  const flat: FlatEntry[] = [];
  let isNew = true;
  if (tip !== undefined) {
    const obj = repo.objects.get(tip);
    if (obj !== undefined && obj.type === 'commit') {
      flattenTree(repo, parseCommit(obj.data).tree, '', flat);
      isNew = false;
    }
  }
  mutate(flat);
  const treeOid = treeFromFlat(repo, flat);
  const commitData = buildCommit({
    tree: treeOid,
    parents: tip !== undefined ? [tip] : [],
    authorName: VIEWER_NAME,
    authorEmail: VIEWER_EMAIL,
    timestamp: trialNowSec(),
    message,
  });
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  return { commitOid, isNew };
}

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  baseUrl: string,
): RestResult {
  const jsonBody = (body ?? {}) as Record<string, unknown>;
  // Root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'not found');
    return ok(200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return err(404, 'not found');
    return ok(200, { installed_version: 'forge-1.0' });
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return err(404, 'not found');
    return ok(200, { login: VIEWER_LOGIN, id: 1000, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const all = store.listByOwner(VIEWER_LOGIN);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        const next = `${baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers.Link = `<${next}>; rel="next"`;
      }
      return ok(200, slice.map((repo) => repoJson(repo)), headers);
    }
    if (method === 'POST') {
      const name = typeof jsonBody.name === 'string' ? jsonBody.name : '';
      if (name === '') return err(422, 'name is required');
      if (store.get(VIEWER_LOGIN, name) !== undefined) return err(422, 'name already exists on this account');
      const repo = store.create(
        VIEWER_LOGIN,
        name,
        typeof jsonBody.description === 'string' ? jsonBody.description : '',
        jsonBody.private === true,
      );
      return ok(201, repoJson(repo));
    }
    return err(404, 'not found');
  }
  if (segments.length >= 2 && segments[0] === 'repos') {
    return handleRepoRest(store, method, segments.slice(1), query, jsonBody, baseUrl);
  }
  return err(404, 'not found');
}

function handleRepoRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  jsonBody: Record<string, unknown>,
  baseUrl: string,
): RestResult {
  const owner = decodeURIComponent(segments[0] ?? '');
  const repoName = decodeURIComponent(segments[1] ?? '');
  const repo = requireRepo(store, owner, repoName);
  if (repo === null) return err(404, 'repository not found');
  const rest = segments.slice(2);
  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof jsonBody.description === 'string') repo.description = jsonBody.description;
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.delete(owner, repoName);
      return { status: 204, body: null };
    }
    return err(404, 'not found');
  }
  // /repos/{o}/{r}/git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof jsonBody.ref === 'string' ? jsonBody.ref : '';
      const sha = typeof jsonBody.sha === 'string' ? jsonBody.sha : '';
      if (!ref.startsWith('refs/') || sha === '' || !repo.objects.has(sha)) {
        return err(422, 'invalid ref or sha');
      }
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha } });
    }
    if (method === 'GET' && rest.length >= 3) {
      const refName = `refs/${rest.slice(2).map((part) => decodeURIComponent(part)).join('/')}`;
      const sha = repo.refs.get(refName);
      if (sha === undefined) return err(404, 'reference not found');
      return ok(200, { ref: refName, object: { sha } });
    }
    return err(404, 'not found');
  }
  // /repos/{o}/{r}/branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const list = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) } }));
      return ok(200, list);
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = decodeURIComponent(rest[1] as string);
      const sha = branchTip(repo, branch);
      if (sha === undefined) return err(404, 'branch not found');
      return ok(200, { name: branch, commit: { sha } });
    }
    return err(404, 'not found');
  }
  // /repos/{o}/{r}/commits
  if (rest[0] === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const shaParam = query.get('sha');
      const branch = shaParam !== null ? shaParam : repo.defaultBranch;
      let tip = branchTip(repo, branch);
      if (tip === undefined && repo.objects.has(branch)) tip = branch;
      if (tip === undefined) return ok(200, []);
      const chain = commitChain(repo, tip);
      const list = chain.map((oid) => {
        const obj = repo.objects.get(oid) as { data: Buffer };
        const commit = parseCommit(obj.data);
        // GitHub returns the message without the trailing newline the raw
        // object carries.
        const message = commit.message.replace(/\n$/, '');
        return { sha: oid, commit: { message, author: { name: VIEWER_NAME }, committer: { name: VIEWER_NAME } } };
      });
      return ok(200, list);
    }
    return err(404, 'not found');
  }
  // /repos/{o}/{r}/contents/{path...}
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
    return handleContents(repo, method, path, query, jsonBody);
  }
  // /repos/{o}/{r}/labels
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return ok(200, [...repo.labels.values()]);
    }
    if (method === 'POST' && rest.length === 1) {
      const name = typeof jsonBody.name === 'string' ? jsonBody.name : '';
      if (name === '') return err(422, 'name is required');
      const color = typeof jsonBody.color === 'string' ? jsonBody.color : 'ededed';
      repo.labels.set(name, { name, color });
      return ok(201, { name, color });
    }
    return err(404, 'not found');
  }
  // /repos/{o}/{r}/issues
  if (rest[0] === 'issues') {
    return handleIssues(repo, method, rest.slice(1), query, jsonBody);
  }
  // /repos/{o}/{r}/pulls
  if (rest[0] === 'pulls') {
    return handlePulls(repo, method, rest.slice(1), query, jsonBody);
  }
  return err(404, 'not found');
}

function handleContents(
  repo: Repo,
  method: string,
  path: string,
  query: URLSearchParams,
  jsonBody: Record<string, unknown>,
): RestResult {
  const branch = typeof jsonBody.branch === 'string' ? jsonBody.branch : repo.defaultBranch;
  if (method === 'GET') {
    const refParam = query.get('ref');
    let tip = refParam !== null ? branchTip(repo, refParam) : branchTip(repo, repo.defaultBranch);
    if (tip === undefined && refParam !== null && repo.objects.has(refParam)) tip = refParam;
    if (tip === undefined) return err(404, 'not found');
    const obj = repo.objects.get(tip);
    if (obj === undefined || obj.type !== 'commit') return err(404, 'not found');
    const flat: FlatEntry[] = [];
    flattenTree(repo, parseCommit(obj.data).tree, '', flat);
    const dirPrefix = path === '' ? '' : `${path}/`;
    const children = flat.filter((entry) => entry.path.startsWith(dirPrefix) && entry.path.slice(dirPrefix.length).indexOf('/') < 0);
    const exact = flat.find((entry) => entry.path === path);
    if (exact !== undefined) {
      const blob = repo.objects.get(exact.oid);
      if (blob === undefined) return err(404, 'not found');
      return ok(200, {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: exact.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      });
    }
    if (children.length > 0) {
      const listing = children.map((entry) => {
        const name = entry.path.slice(dirPrefix.length);
        return { type: 'file', name, path: entry.path, sha: entry.oid, size: (repo.objects.get(entry.oid)?.data.length ?? 0) };
      });
      const dirNames = new Set<string>();
      for (const entry of flat) {
        if (!entry.path.startsWith(dirPrefix)) continue;
        const restPath = entry.path.slice(dirPrefix.length);
        const slash = restPath.indexOf('/');
        if (slash > 0) dirNames.add(restPath.slice(0, slash));
      }
      for (const dirName of [...dirNames].sort()) {
        listing.push({ type: 'dir', name: dirName, path: `${dirPrefix}${dirName}`, sha: '' });
      }
      return ok(200, listing);
    }
    return err(404, 'not found');
  }
  if (method === 'PUT') {
    const message = typeof jsonBody.message === 'string' ? jsonBody.message : 'update file';
    const contentB64 = typeof jsonBody.content === 'string' ? jsonBody.content : '';
    if (contentB64 === '') return err(422, 'content is required');
    const data = Buffer.from(contentB64, 'base64');
    const tip = branchTip(repo, branch);
    let existingSha: string | undefined;
    if (tip !== undefined) {
      const existing = readFileAt(repo, tip, path);
      if (existing !== null) {
        const flat: FlatEntry[] = [];
        const obj = repo.objects.get(tip);
        if (obj !== undefined && obj.type === 'commit') flattenTree(repo, parseCommit(obj.data).tree, '', flat);
        existingSha = flat.find((entry) => entry.path === path)?.oid;
      }
    }
    const givenSha = typeof jsonBody.sha === 'string' ? jsonBody.sha : undefined;
    if (givenSha !== undefined && existingSha !== undefined && givenSha !== existingSha) {
      return err(409, 'sha does not match the current file');
    }
    if (givenSha !== undefined && existingSha === undefined) {
      return err(409, 'file does not exist at the given sha');
    }
    const blobOid = putObject(repo, 'blob', data);
    const existed = existingSha !== undefined;
    const result = commitForContents(repo, branch, message, (entries) => {
      const index = entries.findIndex((entry) => entry.path === path);
      if (index >= 0) entries[index] = { path, mode: '100644', oid: blobOid };
      else entries.push({ path, mode: '100644', oid: blobOid });
    });
    if ('error' in result) return err(500, result.error);
    return ok(existed ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, encoding: 'base64', type: 'file' },
      commit: { sha: result.commitOid, message },
    });
  }
  if (method === 'DELETE') {
    const message = typeof jsonBody.message === 'string' ? jsonBody.message : 'delete file';
    const tip = branchTip(repo, branch);
    if (tip === undefined) return err(404, 'not found');
    const flat: FlatEntry[] = [];
    const obj = repo.objects.get(tip);
    if (obj !== undefined && obj.type === 'commit') flattenTree(repo, parseCommit(obj.data).tree, '', flat);
    const existing = flat.find((entry) => entry.path === path);
    if (existing === undefined) return err(404, 'not found');
    const givenSha = typeof jsonBody.sha === 'string' ? jsonBody.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) return err(409, 'sha does not match the current file');
    const result = commitForContents(repo, branch, message, (entries) => {
      const index = entries.findIndex((entry) => entry.path === path);
      if (index >= 0) entries.splice(index, 1);
    });
    if ('error' in result) return err(500, result.error);
    return ok(200, { commit: { sha: result.commitOid, message } });
  }
  return err(404, 'not found');
}

function handleIssues(
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  jsonBody: Record<string, unknown>,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'asc';
      let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      if (sort === 'created' && direction === 'desc') list = [...list].reverse();
      return ok(200, list.map((issue) => issueJson(repo, issue)));
    }
    if (method === 'POST') {
      const title = typeof jsonBody.title === 'string' ? jsonBody.title : '';
      if (title === '') return err(422, 'title is required');
      const labels = Array.isArray(jsonBody.labels) ? (jsonBody.labels as unknown[]).map((label) => String(label)) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `label does not exist: ${label}`);
      }
      const issue: Issue = {
        number: repo.nextIssue,
        title,
        body: typeof jsonBody.body === 'string' ? jsonBody.body : '',
        state: 'open',
        labels,
        comments: [],
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return ok(201, issueJson(repo, issue));
    }
    return err(404, 'not found');
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return err(404, 'not found');
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return err(404, 'issue not found');
  if (rest.length === 1) {
    if (method === 'GET') return ok(200, issueJson(repo, issue));
    if (method === 'PATCH') {
      if (typeof jsonBody.state === 'string' && (jsonBody.state === 'open' || jsonBody.state === 'closed')) {
        issue.state = jsonBody.state;
      }
      if (typeof jsonBody.title === 'string') issue.title = jsonBody.title;
      if (typeof jsonBody.body === 'string') issue.body = jsonBody.body;
      return ok(200, issueJson(repo, issue));
    }
    return err(404, 'not found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      return ok(200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN } })));
    }
    if (method === 'POST') {
      const bodyText = typeof jsonBody.body === 'string' ? jsonBody.body : '';
      if (bodyText === '') return err(422, 'body is required');
      const comment = { id: repo.nextCommentId, body: bodyText };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      return ok(201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN } });
    }
    return err(404, 'not found');
  }
  return err(404, 'not found');
}

export function mergePull(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'pull request is not open' };
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return { ok: false, status: 404, message: 'branch not found' };
  // Three-way conflict check: a file the PR changes must not have changed on
  // base since the PR was opened to a different version than the PR's head.
  const baseAtCreateFlat: FlatEntry[] = [];
  const baseNowFlat: FlatEntry[] = [];
  const headFlat: FlatEntry[] = [];
  const baseAtCreateObj = repo.objects.get(pull.baseSha);
  const baseNowObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(headTip);
  if (baseAtCreateObj !== undefined && baseAtCreateObj.type === 'commit') {
    flattenTree(repo, parseCommit(baseAtCreateObj.data).tree, '', baseAtCreateFlat);
  }
  if (baseNowObj !== undefined && baseNowObj.type === 'commit') {
    flattenTree(repo, parseCommit(baseNowObj.data).tree, '', baseNowFlat);
  }
  if (headObj !== undefined && headObj.type === 'commit') {
    flattenTree(repo, parseCommit(headObj.data).tree, '', headFlat);
  }
  const atCreate = new Map(baseAtCreateFlat.map((entry) => [entry.path, entry.oid]));
  const now = new Map(baseNowFlat.map((entry) => [entry.path, entry.oid]));
  const head = new Map(headFlat.map((entry) => [entry.path, entry.oid]));
  for (const file of pull.files) {
    const before = atCreate.get(file.filename);
    const current = now.get(file.filename);
    const wanted = head.get(file.filename);
    if (before !== current && before !== wanted && current !== wanted) {
      return { ok: false, status: 405, message: 'merge conflict' };
    }
  }
  // Squash: apply the head's changed files onto the base tip.
  const mergedFlat = [...baseNowFlat];
  for (const file of pull.files) {
    const index = mergedFlat.findIndex((entry) => entry.path === file.filename);
    const headEntry = headFlat.find((entry) => entry.path === file.filename);
    if (file.status === 'removed') {
      if (index >= 0) mergedFlat.splice(index, 1);
    } else if (headEntry !== undefined) {
      if (index >= 0) mergedFlat[index] = { path: file.filename, mode: headEntry.mode, oid: headEntry.oid };
      else mergedFlat.push({ path: file.filename, mode: headEntry.mode, oid: headEntry.oid });
    }
  }
  const treeOid = treeFromFlat(repo, mergedFlat);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    authorName: VIEWER_NAME,
    authorEmail: VIEWER_EMAIL,
    timestamp: trialNowSec(),
    message,
  });
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = trialNowIso();
  pull.mergeCommitSha = mergeSha;
  return { ok: true, sha: mergeSha };
}

function handlePulls(
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  jsonBody: Record<string, unknown>,
): RestResult {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
      return ok(200, list.map((pull) => pullJson(repo, pull)));
    }
    if (method === 'POST') {
      const head = typeof jsonBody.head === 'string' ? jsonBody.head : '';
      const base = typeof jsonBody.base === 'string' ? jsonBody.base : '';
      const title = typeof jsonBody.title === 'string' ? jsonBody.title : '';
      if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch does not exist');
      const pull: Pull = {
        number: repo.nextPull,
        title,
        body: typeof jsonBody.body === 'string' ? jsonBody.body : '',
        state: 'open',
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
      return ok(201, pullJson(repo, pull));
    }
    return err(404, 'not found');
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number <= 0) return err(404, 'not found');
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return err(404, 'pull request not found');
  if (rest.length === 1) {
    if (method === 'GET') return ok(200, pullJson(repo, pull));
    return err(404, 'not found');
  }
  if (rest.length === 2 && rest[1] === 'files') {
    if (method === 'GET') {
      return ok(200, pull.files);
    }
    return err(404, 'not found');
  }
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return err(404, 'not found');
    const merged = mergePull(repo, pull);
    if (!merged.ok) return err(merged.status, merged.message);
    return ok(200, { sha: merged.sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n` });
  }
  return err(404, 'not found');
}
