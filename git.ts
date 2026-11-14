// git smart HTTP: upload-pack (protocol v2 + v0 fallback) and receive-pack (v0).
// Pure functions over the store; app.ts does the HTTP plumbing.
import {
  ZERO_OID,
  DEFAULT_BRANCH,
  decodePktLines,
  parseCommit,
  parseTag,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  putObject,
  readPack,
  selectFetchObjects,
  writePack,
  isDescendant,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}
function fail(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

interface ListedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function listRefs(repo: Repo): ListedRef[] {
  const out: ListedRef[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (mainTip !== undefined) {
    out.push({ oid: mainTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  } else {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}`, unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const obj = repo.objects.get(oid);
    let peeled: string | undefined;
    if (obj !== undefined && obj.type === 'tag') {
      const tag = parseTag(obj.data);
      peeled = tag.object;
    }
    out.push({ oid, name, peeled });
  }
  return out;
}

function v0Capabilities(service: string): string {
  if (service === 'git-receive-pack') return 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  return 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow agent=forge/1.0';
}

function advertisementV0(repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  const refs = listRefs(repo);
  const caps = v0Capabilities(service);
  if (repo.refs.size === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      let line = `${ref.oid} ${ref.name}`;
      if (first) {
        line += `\0${caps}`;
        first = false;
      }
      parts.push(pktLine(`${line}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertisementV2(service: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  parts.push(pktLine('version 2\n'));
  parts.push(pktLine('ls-refs=unborn\n'));
  parts.push(pktLine('fetch=shallow wait-for-done\n'));
  parts.push(pktLine('object-format=sha1\n'));
  parts.push(pktLine(`agent=${AGENT}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function infoRefs(store: Store, owner: string, repoName: string, service: string, gitProtocol: string | undefined): GitResponse {
  const repo = store.get(owner, repoName);
  if (repo === undefined) return fail(404, 'repository not found');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return fail(400, 'unknown service');
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && gitProtocol === 'version=2') {
    return ok(contentType, advertisementV2(service));
  }
  return ok(contentType, advertisementV0(repo, service));
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunkSize = 65515;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

export function uploadPack(store: Store, owner: string, repoName: string, gitProtocol: string | undefined, body: Buffer): GitResponse {
  const repo = store.get(owner, repoName);
  if (repo === undefined) return fail(404, 'repository not found');
  try {
    if (gitProtocol === 'version=2') return uploadPackV2(repo, body);
    return uploadPackV0(repo, body);
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : 'bad request');
  }
}

function parsePktLines(body: Buffer): Array<{ kind: string; line: string }> {
  return decodePktLines(body).map((packet) => ({
    kind: packet.kind,
    line: packet.kind === 'data' ? packet.payload.toString('utf8') : '',
  }));
}

function uploadPackV2(repo: Repo, body: Buffer): GitResponse {
  const packets = parsePktLines(body);
  let command = '';
  const args: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.line.replace(/\n$/, '');
    if (!seenDelim && line.startsWith('command=')) command = line.slice('command='.length);
    else if (seenDelim) args.push(line);
  }
  if (command === 'ls-refs') return lsRefsV2(repo, args);
  if (command === 'fetch') return fetchV2(repo, args);
  return fail(400, `unknown v2 command ${command}`);
}

function lsRefsV2(repo: Repo, args: string[]): GitResponse {
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const refs = listRefs(repo);
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn === true) {
      parts.push(pktLine(`unborn ${ref.name} symref-target:${ref.symrefTarget ?? ''}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

function fetchV2(repo: Repo, args: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
  }
  const selection = selectFetchObjects(repo, wants, depth, haves, shallow);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (selection.ack !== null) {
    parts.push(pktLine(`ACK ${selection.ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(pktDelim());
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

function uploadPackV0(repo: Repo, body: Buffer): GitResponse {
  const packets = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.line.replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  const selection = selectFetchObjects(repo, wants, depth, haves, shallow);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  if (selection.ack !== null) parts.push(pktLine(`ACK ${selection.ack}\n`));
  else parts.push(pktLine('NAK\n'));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

export function receivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.get(owner, repoName);
  if (repo === undefined) return fail(404, 'repository not found');
  try {
    return receivePackInner(repo, body);
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : 'bad request');
  }
}

function receivePackInner(repo: Repo, body: Buffer): GitResponse {
  // Commands are pkt-lines up to the first flush; the rest is the raw pack.
  let offset = 0;
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  let packStart = body.length;
  while (offset + 4 <= body.length) {
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('bad pkt-line length');
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = payload.indexOf('\0');
    const first = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
    const parts = first.split(' ');
    if (parts.length >= 3) {
      commands.push({
        oldOid: parts[0] as string,
        newOid: parts[1] as string,
        ref: parts.slice(2).join(' '),
      });
    }
    offset += length;
  }
  if (commands.length === 0) throw new Error('no push commands');
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const incoming = new Map<string, GitObject>();
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes);
      for (const [oid, obj] of read.objects) incoming.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const [oid, obj] of incoming) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  const lines: string[] = [];
  lines.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`);
  for (const command of commands) {
    if (!unpackOk) {
      lines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    let problem: string | null = null;
    if (command.newOid === ZERO_OID) {
      if (current === undefined) problem = 'non-fast-forward';
      else if (current !== command.oldOid) problem = 'non-fast-forward';
    } else {
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) problem = 'non-fast-forward';
      } else {
        if (current === undefined || current !== command.oldOid) problem = 'non-fast-forward';
        else if (!isDescendant(repo, command.newOid, command.oldOid)) problem = 'non-fast-forward';
      }
      if (problem === null && !repo.objects.has(command.newOid)) problem = 'non-fast-forward';
    }
    if (problem !== null) {
      lines.push(`ng ${command.ref} ${problem}`);
      continue;
    }
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  const parts: Buffer[] = [];
  // The advertisement offers side-band-64k, so the report-status stream is
  // pkt-lined inside band-1 sideband packets (the client strips the band byte
  // and then parses the inner pkt-lines).
  for (const line of lines) {
    const inner = pktLine(`${line}\n`);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner])));
  }
  parts.push(pktFlush());
  return ok('application/x-git-receive-pack-result', Buffer.concat(parts));
}
