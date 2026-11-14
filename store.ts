// In-memory forge store plus the git object model (objects, trees, commits,
// packs, pkt-lines). Everything is deterministic: no wall clock or unseeded
// randomness touches stored state. Only Node stdlib is used.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
// The trial clock (seconds) when the env sets it, else the fixed scenario epoch.
export function trialNowSec(): number {
  const raw = Number(process.env.MAKEFUN_TRIAL_NOW);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1735689600;
}
export function trialNowIso(): string {
  return new Date(trialNowSec() * 1000).toISOString();
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}
export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}
export interface FlatEntry {
  path: string;
  mode: string;
  oid: string;
}
export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
}
export interface Comment {
  id: number;
  body: string;
}
export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}
export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  files: PullFile[];
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
export function oidOf(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export class Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();
  issues: Issue[] = [];
  pulls: Pull[] = [];
  labels = new Map<string, { name: string; color: string }>();
  nextIssue = 1;
  nextPull = 1;
  nextCommentId = 1;
  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = DEFAULT_BRANCH;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }
  get(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }
  create(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextRepoId, owner, name, description, isPrivate);
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }
  delete(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }
  listByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }
}

export function putObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- commits/trees

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function buildCommit(opts: {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  timestamp: number;
  message: string;
}): Buffer {
  const stamp = `${opts.timestamp} +0000`;
  const ident = `${opts.authorName} <${opts.authorEmail}> ${stamp}`;
  let out = `tree ${opts.tree}\n`;
  for (const parent of opts.parents) out += `parent ${parent}\n`;
  out += `author ${ident}\ncommitter ${ident}\n\n${opts.message}`;
  if (!out.endsWith('\n')) out += '\n';
  return Buffer.from(out, 'utf8');
}

// Flatten a tree (recursively) into path entries for files only.
export function flattenTree(repo: Repo, treeOid: string, prefix: string, out: FlatEntry[]): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.push({ path, mode: entry.mode, oid: entry.oid });
  }
}

// Build a tree (and its subtrees) from a flat file list; returns the root tree oid.
export function treeFromFlat(repo: Repo, entries: FlatEntry[]): string {
  const groups = new Map<string, FlatEntry[]>();
  const singles: TreeEntry[] = [];
  for (const entry of entries) {
    const slash = entry.path.indexOf('/');
    if (slash < 0) {
      singles.push({ mode: entry.mode, name: entry.path, oid: entry.oid });
    } else {
      const dir = entry.path.slice(0, slash);
      const rest = entry.path.slice(slash + 1);
      const list = groups.get(dir) ?? [];
      list.push({ path: rest, mode: entry.mode, oid: entry.oid });
      groups.set(dir, list);
    }
  }
  for (const [dir, list] of groups) {
    const subOid = treeFromFlat(repo, list);
    singles.push({ mode: '40000', name: dir, oid: subOid });
  }
  const data = buildTree(singles);
  return putObject(repo, 'tree', data);
}

// Read a file's bytes at a commit's tree, or null when absent.
export function readFileAt(repo: Repo, commitOid: string, path: string): Buffer | null {
  const commitObj = repo.objects.get(commitOid);
  if (commitObj === undefined || commitObj.type !== 'commit') return null;
  const commit = parseCommit(commitObj.data);
  const flat: FlatEntry[] = [];
  flattenTree(repo, commit.tree, '', flat);
  const found = flat.find((entry) => entry.path === path);
  if (found === undefined) return null;
  const blob = repo.objects.get(found.oid);
  if (blob === undefined || blob.type !== 'blob') return null;
  return blob.data;
}

// Is `descendant` equal to `ancestor`, or does it have `ancestor` in its history?
export function isDescendant(repo: Repo, descendant: string, ancestor: string): boolean {
  if (descendant === ancestor) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------- packs

function encodeVarintHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: Map<string, GitObject>): Buffer {
  const oids = [...objects.keys()].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  const typeCodes: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const oid of oids) {
    const obj = objects.get(oid) as GitObject;
    parts.push(encodeVarintHeader(typeCodes[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

export function readPack(pack: Buffer): ReadPackResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack does not start with PACK');
  }
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  let offset = 12;
  const typeNames: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let i = 0; i < count; i += 1) {
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6 || typeCode === 7) {
      // The suite client never sends deltas (its writer emits full objects only).
      throw new Error('delta packs are not accepted');
    }
    const type = typeNames[typeCode];
    if (type === undefined) throw new Error(`unknown pack type ${typeCode}`);
    const { data, bytesRead } = inflateWithLength(pack.subarray(offset));
    offset += bytesRead;
    if (data.length !== size) throw new Error('pack object size mismatch');
    const oid = oidOf(type, data);
    objects.set(oid, { type, data });
  }
  return { objects, deltaCount: 0 };
}

// Inflate a zlib stream and report how many input bytes it consumed. The deflate
// stream is self-delimiting, so the shortest prefix that inflates cleanly (to
// the expected size, checked by the caller) is exactly one object.
function inflateWithLength(input: Buffer): { data: Buffer; bytesRead: number } {
  let low = 1;
  let high = input.length;
  let best: Buffer | null = null;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      const data = inflateSync(input.subarray(0, mid));
      best = data;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (best === null) throw new Error('could not inflate pack object');
  return { data: best, bytesRead: low };
}

// ---------------------------------------------------------------- pkt-lines

export interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function decodePktLines(buffer: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('bad pkt-line length');
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line');
      out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return out;
}

// ---------------------------------------------------------------- fetch closure

export interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

function collectTreeObjects(repo: Repo, treeOid: string, into: Map<string, GitObject>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || into.has(treeOid)) return;
  into.set(treeOid, obj);
  if (obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const child = repo.objects.get(entry.oid);
    if (child === undefined) continue;
    if (entry.mode === '40000') collectTreeObjects(repo, entry.oid, into);
    else if (!into.has(entry.oid)) into.set(entry.oid, child);
  }
}

function commitClosure(repo: Repo, tip: string, maxDepth: number | null): Set<string> {
  const included = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = [{ oid: tip, depth: 1 }];
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (included.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    included.add(oid);
    if (maxDepth !== null && depth >= maxDepth) continue;
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return included;
}

export function selectFetchObjects(
  repo: Repo,
  wants: string[],
  depth: number | null,
  haves: string[],
  shallowHaves: string[],
): FetchSelection {
  const includedCommits = new Set<string>();
  const extraObjects = new Map<string, GitObject>();
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) throw new Error(`unknown want ${want}`);
    if (obj.type === 'commit') {
      for (const oid of commitClosure(repo, want, depth)) includedCommits.add(oid);
    } else if (obj.type === 'tag') {
      extraObjects.set(want, obj);
      const tag = parseTag(obj.data);
      const target = repo.objects.get(tag.object);
      if (target === undefined) throw new Error(`unknown tag target ${tag.object}`);
      if (target.type === 'commit') {
        for (const oid of commitClosure(repo, tag.object, depth)) includedCommits.add(oid);
      } else {
        extraObjects.set(tag.object, target);
      }
    } else {
      extraObjects.set(want, obj);
    }
  }
  const objects = new Map<string, GitObject>(extraObjects);
  for (const oid of includedCommits) {
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    objects.set(oid, obj);
    const commit = parseCommit(obj.data);
    collectTreeObjects(repo, commit.tree, objects);
  }
  // Subtract what the client already has. A have listed as shallow is held at
  // depth 1 only, so it is excluded at depth 1; other haves are fully held.
  const exclude = new Map<string, GitObject>();
  const shallowSet = new Set(shallowHaves);
  for (const have of haves) {
    if (shallowSet.has(have)) continue;
    for (const oid of commitClosure(repo, have, null)) {
      const commitObj = repo.objects.get(oid);
      if (commitObj === undefined) continue;
      exclude.set(oid, commitObj);
      const commit = parseCommit(commitObj.data);
      collectTreeObjects(repo, commit.tree, exclude);
    }
  }
  for (const have of shallowHaves) {
    const obj = repo.objects.get(have);
    if (obj === undefined || obj.type !== 'commit') continue;
    exclude.set(have, obj);
    const commit = parseCommit(obj.data);
    collectTreeObjects(repo, commit.tree, exclude);
  }
  for (const oid of exclude.keys()) objects.delete(oid);
  // Shallow boundaries: commits in the pack whose parent is not in the pack's
  // ancestry (depth cut). A commit the client already holds is not a boundary.
  const shallow: string[] = [];
  for (const oid of includedCommits) {
    if (!objects.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit.parents.some((parent) => !includedCommits.has(parent))) shallow.push(oid);
  }
  // Unshallow: old shallow boundaries now fully included.
  const unshallow: string[] = [];
  for (const old of shallowHaves) {
    if (!includedCommits.has(old)) continue;
    const obj = repo.objects.get(old);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit.parents.every((parent) => includedCommits.has(parent))) unshallow.push(old);
  }
  // ACK: first have that is a common base of a want.
  let ack: string | null = null;
  for (const have of haves) {
    if (includedCommits.has(have)) {
      ack = have;
      break;
    }
  }
  return { objects, shallow, unshallow, ack };
}
