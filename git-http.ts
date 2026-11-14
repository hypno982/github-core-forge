// git-http.ts: git smart HTTP, implemented from the wire up. No git binary exists in the trial
// container, so every byte of pkt-line framing, ref advertisement, packfile and report-status is
// produced here.
//
// Routes (the client in checks-git.ts drives exactly these):
//   GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /<owner>/<repo>.git/git-upload-pack      (protocol v2 ls-refs/fetch, and v0 want/have)
//   POST /<owner>/<repo>.git/git-receive-pack     (push: command list + packfile)
//
// Protocol v2 is chosen by the Git-Protocol: version=2 header; receive-pack is v0-only by design.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EMPTY_TREE_SHA, Store, objectSha, parseTree, type CommitInfo, type ObjKind, type TreeEntry } from './store.ts';

/** git's LARGE_PACKET_MAX. */
const PKT_MAX = 65520;
/** The all-zero object id: an unborn branch's old/new value. */
const ZERO = '0'.repeat(40);

/** `DEBUG=1` in the environment turns the trace lines on; off by default, since they cost on the
 *  benchmark's critical path (200 pushes, 2000 reads). */
const DEBUG = process.env.DEBUG === '1';

/** The side-band-64k channel that carries packfile bytes. */
const BAND_DATA = 1;
const BAND_PROGRESS = 2;
const BAND_ERROR = 3;

/** One pkt-line payload, framed with its 4 hex length bytes. */
function pkt(payload: string | Buffer): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** The flush packet. */
function flush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delim packet (v2 section separator). */
function delim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** The response-end packet (v2). */
function responseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Split a pkt-line stream into its pieces, keeping control packets as their own entries. */
type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode a pkt-line stream. Truncated tails are ignored, as git does. */
function decodePkts(body: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const header = body.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      at += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.length) break;
    out.push({ kind: 'data', payload: body.subarray(at + 4, at + length) });
    at += length;
  }
  return out;
}

/** Every data payload of a stream, as utf8 strings, in order. */
function pktText(body: Buffer): string[] {
  return decodePkts(body)
    .filter((piece): piece is { kind: 'data'; payload: Buffer } => piece.kind === 'data')
    .map((piece) => piece.payload.toString('utf8'));
}

/** The request context git-http needs from the router. */
export interface GitHttpRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: Map<string, string[]>;
  login: string;
  store: Store;
  body: Buffer;
}

/** The v0/v2 push capabilities the client requires. */
const RECEIVE_CAPS = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', 'agent=forge/1.0'].join(' ');
/** The v2 upload-pack capabilities the client requires (fetch and ls-refs at minimum). */
const UPLOAD_V2_CAPS = [
  'version 2',
  'agent=forge/1.0',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done',
  'object-format=sha1',
];

/** Answer a non-200 with a plain body: git expects text here, not JSON. */
function gitFail(res: ServerResponse, status: number, message: string): void {
  const text = `${message}\n`;
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}

/** Resolve a repo from the URL path, or answer 404. */
function repoOfPath(store: Store, path: string): { owner: string; name: string; repo: ReturnType<Store['repo']> } | null {
  const m = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (!m) return null;
  const owner = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  return { owner, name, repo: store.repo(owner, name) };
}

/** Route one git smart-HTTP request. */
export async function handleGitHttp(input: GitHttpRequest): Promise<void> {
  const { req, res, method, path, query, login, store, body } = input;
  const found = repoOfPath(store, path);
  if (found === null) {
    gitFail(res, 404, 'Not Found');
    return;
  }
  const { owner, name } = found;
  const repo = found.repo;

  // A repository the token does not own is a 404, exactly as the REST surface answers.
  if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) {
    gitFail(res, 404, 'Not Found');
    return;
  }

  const tail = path.replace(/^\/[^/]+\/[^/]+\.git/, '');

  // GET /info/refs?service=...
  if (tail === '/info/refs' && method === 'GET') {
    const service = query.get('service')?.[0] ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      gitFail(res, 403, 'Dumb HTTP transport is not supported');
      return;
    }
    const gitProtocol = String(req.headers['git-protocol'] ?? '');
    const wantsV2 = service === 'git-upload-pack' && /version=2/.test(gitProtocol);
    const preamble = pkt(`# service=${service}\n`);
    const bodyParts: Buffer[] = [preamble, flush()];
    if (wantsV2) {
      // v2: a capability advertisement, no refs at all.
      for (const line of UPLOAD_V2_CAPS) bodyParts.push(pkt(`${line}\n`));
      bodyParts.push(flush());
    } else {
      bodyParts.push(advertiseV0(store, repo, service));
    }
    const payload = Buffer.concat(bodyParts);
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'content-length': String(payload.length),
      'cache-control': 'no-cache',
    });
    res.end(payload);
    return;
  }

  // POST /git-upload-pack
  if (tail === '/git-upload-pack' && method === 'POST') {
    const gitProtocol = String(req.headers['git-protocol'] ?? '');
    const wantsV2 = /version=2/.test(gitProtocol);
    const accept = String(req.headers.accept ?? '');
    const out = wantsV2 ? serveUploadV2(store, repo, body) : serveUploadV0(store, repo, body, accept);
    res.writeHead(200, {
      'content-type': 'application/x-git-upload-pack-result',
      'content-length': String(out.length),
      'cache-control': 'no-cache',
    });
    res.end(out);
    return;
  }

  // POST /git-receive-pack
  if (tail === '/git-receive-pack' && method === 'POST') {
    const out = serveReceive(store, repo, body, login);
    res.writeHead(200, {
      'content-type': 'application/x-git-receive-pack-result',
      'content-length': String(out.length),
      'cache-control': 'no-cache',
    });
    res.end(out);
    return;
  }

  gitFail(res, 404, 'Not Found');
}

/** The v0 ref advertisement: first ref carries the capabilities, tags are peeled. */
function advertiseV0(store: Store, repo: NonNullable<ReturnType<Store['repo']>>, service: string): Buffer {
  const refs = [...repo.refs.entries()].filter(([refName]) => refName !== 'HEAD');
  const head = repo.refs.get('HEAD');
  const caps = service === 'git-receive-pack'
    ? RECEIVE_CAPS
    : 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/' + repo.default_branch + ' agent=forge/1.0';

  if (refs.length === 0) {
    // An empty repository: the capabilities^{} pseudo-ref, which every client understands.
    return Buffer.concat([pkt(`${ZERO} capabilities^{}\u0000${caps}\n`), flush()]);
  }

  const sorted = refs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts: Buffer[] = [];
  let first = true;
  for (const [refName, info] of sorted) {
    if (first) {
      parts.push(pkt(`${info.sha} ${refName}\u0000${caps}\n`));
      first = false;
    } else {
      parts.push(pkt(`${info.sha} ${refName}\n`));
    }
    // A tag peels to the commit it names, advertised as refs/tags/x^{} — transitively, so a tag of a
    // tag lands on the commit at the end of the chain.
    if (refName.startsWith('refs/tags/')) {
      const peeled = peelToCommit(store, info.sha);
      if (peeled !== null && peeled !== info.sha) parts.push(pkt(`${peeled} ${refName}^{}\n`));
    }
  }
  // HEAD is advertised as a ref line at its target's sha; the symref capability names the target.
  // A separate "@refs/..." line is invalid: no object id may begin with @.
  void head;
  parts.push(flush());
  return Buffer.concat(parts);
}

/** Serve a v2 upload-pack request: ls-refs or fetch, one command per request. */
function serveUploadV2(store: Store, repo: NonNullable<ReturnType<Store['repo']>>, body: Buffer): Buffer {
  const texts = pktText(body);
  // A v2 request names its command as `command=<name>`, not as a bare word.
  const rawCommand = (texts.find((line) => !line.startsWith('agent=') && !line.startsWith('object-format=') && line.trim() !== '') ?? '').trim();
  const command = rawCommand.startsWith('command=') ? rawCommand.slice('command='.length).trim() : rawCommand;
  // The first data line names the command; the rest are its arguments until a delim.
  const byCommand = splitCommand(texts);

  if (command === 'ls-refs') {
    return serveLsRefs(store, repo, byCommand.args);
  }
  if (command === 'fetch') {
    return serveFetchV2(store, repo, body);
  }
  // An unknown command is answered with an empty section list, as v2 allows.
  return Buffer.concat([delim(), responseEnd()]);
}

/** Split a v2 request into its command and the argument lines that follow (up to the delim). */
function splitCommand(texts: string[]): { command: string; args: string[]; haves: string[] } {
  const cleaned = texts.map((line) => line.replace(/\n$/, ''));
  const found = cleaned.find((line) => line !== '' && !line.startsWith('agent=') && !line.startsWith('object-format=')) ?? '';
  const command = found.startsWith('command=') ? found.slice('command='.length).trim() : found;
  const at = cleaned.indexOf(command);
  const args: string[] = [];
  const haves: string[] = [];
  for (let i = at + 1; i < cleaned.length; i += 1) {
    const line = cleaned[i];
    if (line.startsWith('want ') || line.startsWith('have ') || line.startsWith('done') || line.startsWith('deepen') || line.startsWith('ref-prefix') || line.startsWith('peel') || line.startsWith('symrefs') || line.startsWith('unborn') || line.startsWith('ofs-delta') || line.startsWith('no-progress') || line.startsWith('thin-pack') || line.startsWith('wait-for-done')) {
      if (line.startsWith('have ')) haves.push(line.slice(5));
      else args.push(line);
    }
  }
  return { command, args, haves };
}

/** v2 ls-refs: refs, HEAD symref, peeled tags, honouring ref-prefix filters. */
function serveLsRefs(store: Store, repo: NonNullable<ReturnType<Store['repo']>>, args: string[]): Buffer {
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length).trim());
  const wantSymrefs = args.some((line) => line.trim() === 'symrefs');
  const wantPeel = args.some((line) => line.trim() === 'peel');
  const wantUnborn = args.some((line) => line.trim() === 'unborn');

  const matches = (refName: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => refName.startsWith(prefix));
  const parts: Buffer[] = [];

  // HEAD first, with its symref when asked for.
  const head = repo.refs.get('HEAD');
  if (matches('HEAD')) {
    if (head?.symref) {
      const target = repo.refs.get(head.symref);
      if (target) {
        const symref = wantSymrefs ? ` symref-target:${head.symref}` : '';
        parts.push(pkt(`${target.sha} HEAD${symref}\n`));
      }
    } else if (wantUnborn && head === undefined) {
      // An unborn HEAD is reported by name only when the client asked for it.
      parts.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.default_branch}\n`));
    }
  }

  const refs = [...repo.refs.entries()]
    .filter(([refName]) => refName !== 'HEAD' && matches(refName))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [refName, info] of refs) {
    // v2 reports a peeled tag as a `peeled:<oid>` attribute on the same line, not as a `^{}` ref.
    let attrs = '';
    if (wantPeel && refName.startsWith('refs/tags/')) {
      const peeled = peelToCommit(store, info.sha);
      if (peeled !== null && peeled !== info.sha) attrs = ` peeled:${peeled}`;
    }
    parts.push(pkt(`${info.sha} ${refName}${attrs}\n`));
  }
  parts.push(flush());
  return Buffer.concat([...parts]);
}

/**
 * v2 fetch: sections separated by delim packets, and a section's own list ended by a flush.
 *
 * The client's parser (git-client.ts parseV2Fetch) treats delim as "this section ended" and flush as
 * the same; a data packet must carry a section header first. So the shape is:
 *   delim  "acknowledgments\n" ACK... [flush]  delim  "shallow-info\n" shallow... [flush]
 *   delim  "packfile\n" <sideband packets>  flush
 */
function serveFetchV2(store: Store, repo: NonNullable<ReturnType<Store['repo']>>, body: Buffer): Buffer {
  const texts = pktText(body).map((line) => line.replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let deepenRelative = false;
  let done = false;
  for (const line of texts) {
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen-relative')) deepenRelative = true;
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = Math.trunc(n);
    } else if (line.trim() === 'done') done = true;
  }
  // A shallow client's history stops at its own boundary: those commits are had, their parents are not.
  const shallowSet = new Set(clientShallow);

  const out: Buffer[] = [];

  // Section: acknowledgments. Only sent when the client sent haves (an initial clone has none).
  if (haves.length > 0) {
    out.push(delim(), pkt('acknowledgments\n'));
    const known = haves.filter((sha) => repo.commits.has(sha));
    for (const sha of known) out.push(pkt(`ACK ${sha}\n`));
    if (known.length > 0) out.push(pkt('ready\n'));
    else out.push(pkt('NAK\n'));
    out.push(flush());
  }

  if (wants.length === 0) {
    out.push(flush());
    return Buffer.concat(out);
  }

  // Everything the client already holds is not sent again. For a shallow client the walk stops at its
  // own boundary: the boundary commit is had, but its parents are not, so they must travel.
  const haveSet = new Set<string>();
  const addHave = (sha: string, stopAtShallow: boolean): void => {
    for (const at of store.ancestry(repo, sha)) {
      haveSet.add(at);
      const info = repo.commits.get(at);
      if (!info) continue;
      haveSet.add(info.tree);
      for (const entry of store.flatTree(info.tree)) haveSet.add(entry.sha);
      // A shallow boundary's parent is outside the client's history.
      if (stopAtShallow && shallowSet.has(at)) break;
    }
  };
  const shallowClient = shallowSet.size > 0;
  for (const sha of haves) {
    if (!repo.commits.has(sha)) continue;
    addHave(sha, shallowClient);
  }
  // A deepening fetch names its current boundary in `shallow` even without a matching have.
  for (const sha of clientShallow) {
    if (repo.commits.has(sha)) addHave(sha, true);
  }

  const selected = new Set<string>();
  const selectCommit = (sha: string): void => {
    selected.add(sha);
    const info = repo.commits.get(sha);
    if (!info) return;
    selected.add(info.tree);
    for (const entry of store.flatTree(info.tree)) selected.add(entry.sha);
  };
  for (const want of wants) {
    // A want may name a tag object rather than a commit; the tag travels and its target is walked.
    if (!repo.commits.has(want)) {
      const tagObject = store.get(want);
      if (tagObject?.kind === 'tag') {
        selected.add(want);
        const target = peelToCommit(store, want);
        if (target !== null && repo.commits.has(target)) {
          for (const at of store.ancestry(repo, target)) selectCommit(at);
        }
      }
      continue;
    }
    const walk = [...store.ancestry(repo, want)];
    let keep = walk.length;
    if (depth !== null) {
      // `deepen N` is absolute from the want; `deepen-relative` counts N generations further than the
      // client's existing boundary, so the target depth is its current depth plus N.
      if (deepenRelative && shallowClient) {
        const currentDepth = walk.findIndex((sha) => shallowSet.has(sha)) + 1;
        const target = (currentDepth > 0 ? currentDepth : 0) + depth;
        keep = Math.max(depth, target);
      } else {
        keep = depth;
      }
    }
    for (const at of walk.slice(0, keep)) selectCommit(at);
  }
  for (const sha of haveSet) selected.delete(sha);

  // Section: shallow-info. A deepening client learns its new boundary (and the ones it left behind).
  const boundaries: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const want of wants) {
      if (!repo.commits.has(want)) continue;
      const walk = [...store.ancestry(repo, want)];
      const keep = Math.min(walk.length, depth);
      const last = walk[keep - 1];
      if (last === undefined) continue;
      const info = repo.commits.get(last);
      if (info && info.parents.length > 0) boundaries.push(last);
    }
    for (const sha of clientShallow) if (!boundaries.includes(sha)) unshallow.push(sha);
  }
  if (depth !== null && (boundaries.length > 0 || unshallow.length > 0)) {
    out.push(delim(), pkt('shallow-info\n'));
    for (const sha of boundaries) out.push(pkt(`shallow ${sha}\n`));
    for (const sha of unshallow) out.push(pkt(`unshallow ${sha}\n`));
    out.push(flush());
  }

  // The packfile. Debug lines are behind an env flag: the benchmark times 200 pushes, and a write per
  // object is measurable on the critical path.
  if (DEBUG) {
    for (const want of wants) {
      const ci = repo.commits.get(want);
      process.stderr.write(`DEBUG want=${want.slice(0, 8)} commitKnown=${!!ci} tree=${ci?.tree?.slice(0, 8)}\n`);
      if (ci) {
        const tobj = store.get(ci.tree);
        process.stderr.write(`DEBUG   treeObj=${tobj ? tobj.kind : 'MISSING'} bytes=${tobj?.body.length ?? 0}\n`);
        for (const e of store.flatTree(ci.tree)) process.stderr.write(`DEBUG   file ${e.path} ${e.sha.slice(0, 8)}\n`);
      }
    }
  }
  // Every tree the selection names must itself be selected: a pack that carries a tree naming an
  // absent subtree leaves the client's graph incomplete. An object the client already holds stays out,
  // even when a selected tree names it: that is exactly the incremental fetch's contract.
  for (let pass = 0; pass < 8; pass += 1) {
    let added = false;
    for (const sha of [...selected]) {
      const object = store.get(sha);
      if (!object || object.kind !== 'tree') continue;
      for (const entry of parseTree(object.body)) {
        if (selected.has(entry.sha)) continue;
        if (haveSet.has(entry.sha)) continue;
        if (!store.objects.has(entry.sha)) continue;
        selected.add(entry.sha);
        added = true;
      }
    }
    if (!added) break;
  }
  const pack = buildPack(store, selected);
  if (DEBUG) process.stderr.write(`DEBUG fetch: wants=${wants.length} haves=${haves.length} selected=${selected.size} pack=${pack.length}\n`);
  out.push(delim(), pkt('packfile\n'));
  out.push(...sideband(BAND_DATA, pack));
  out.push(flush());
  return Buffer.concat(out);
}

/** Peel a tag chain to the commit at its end, or null when it names no commit this store holds. */
function peelToCommit(store: Store, sha: string): string | null {
  let at = sha;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(at);
    if (!object) return null;
    if (object.kind === 'commit') return at;
    if (object.kind !== 'tag') return null;
    const m = /^object ([0-9a-f]{40})$/m.exec(object.body.toString('utf8'));
    if (!m) return null;
    at = m[1];
  }
  return null;
}

/** Serve a v0 upload-pack: want/have/done, answered with a side-band packfile. */
function serveUploadV0(store: Store, repo: NonNullable<ReturnType<Store['repo']>>, body: Buffer, accept: string): Buffer {
  const texts = pktText(body).map((line) => line.replace(/\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const line of texts) {
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = Math.trunc(n);
    } else if (line.trim() === 'done') done = true;
  }
  if (wants.length === 0) return flush();

  const out: Buffer[] = [];
  // multi_ack_detailed: acknowledge what we have so an incremental fetch stops early.
  if (!done) {
    const known = haves.filter((sha) => repo.commits.has(sha));
    for (const sha of known) out.push(pkt(`ACK ${sha} common\n`));
    if (known.length > 0) out.push(pkt(`ACK ${known[known.length - 1]} ready\n`));
    out.push(flush());
  } else {
    for (const sha of haves.filter((h) => repo.commits.has(h))) out.push(pkt(`ACK ${sha}\n`));
  }

  // The object set: everything reachable from the wants, minus everything reachable from the haves.
  const haveSet = new Set<string>();
  for (const sha of haves) {
    if (!repo.commits.has(sha)) continue;
    for (const at of store.ancestry(repo, sha)) {
      haveSet.add(at);
      const info = repo.commits.get(at);
      if (!info) continue;
      haveSet.add(info.tree);
      for (const entry of store.flatTree(info.tree)) haveSet.add(entry.sha);
    }
  }

  const selected = new Set<string>();
  for (const want of wants) {
    // A want may name a tag object rather than a commit; the tag travels and its target is walked.
    if (!repo.commits.has(want)) {
      const tagObject = store.get(want);
      if (tagObject?.kind === 'tag') {
        selected.add(want);
        const target = peelToCommit(store, want);
        if (target !== null && repo.commits.has(target)) {
          for (const at of store.ancestry(repo, target)) {
            selected.add(at);
            const info = repo.commits.get(at);
            if (!info) continue;
            selected.add(info.tree);
            for (const entry of store.flatTree(info.tree)) selected.add(entry.sha);
          }
        }
      }
      continue;
    }
    const walk = [...store.ancestry(repo, want)];
    // A depth limit keeps only the newest `depth` generations.
    const limited = depth === null ? walk : walk.slice(0, depth);
    for (const at of limited) {
      selected.add(at);
      const info = repo.commits.get(at);
      if (!info) continue;
      selected.add(info.tree);
      for (const entry of store.flatTree(info.tree)) selected.add(entry.sha);
    }
  }
  for (const sha of haveSet) selected.delete(sha);

  // Shallow info: the boundary commits at the depth limit.
  if (depth !== null) {
    const boundary: string[] = [];
    for (const want of wants) {
      if (!repo.commits.has(want)) continue;
      const walk = [...store.ancestry(repo, want)].slice(0, depth);
      const last = walk[walk.length - 1];
      const info = repo.commits.get(last);
      if (info && info.parents.length > 0) boundary.push(last);
    }
    for (const sha of boundary) out.push(pkt(`shallow ${sha}\n`));
    if (boundary.length > 0) out.push(flush());
  }

  // The packfile, in side-band-64k when the client asked for it.
  const pack = buildPack(store, selected);
  const useSideband = /side-band/.test(accept) || texts.some((line) => line.includes('side-band'));
  if (useSideband) {
    out.push(pkt(`NAK\n`));
    out.push(...sideband(BAND_DATA, pack));
    out.push(pkt(''));
  } else {
    out.push(pkt('NAK\n'));
    out.push(pack);
  }
  return Buffer.concat(out);
}

/** Wrap bytes in side-band-64k packets of one channel. */
function sideband(channel: number, payload: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunk = 65515 - 5;
  for (let at = 0; at < payload.length; at += chunk) {
    const slice = payload.subarray(at, Math.min(payload.length, at + chunk));
    out.push(pkt(Buffer.concat([Buffer.from([channel]), slice])));
  }
  return out;
}

/** Build a version-2 packfile holding exactly these objects, header and trailer included. */
function buildPack(store: Store, shas: Iterable<string>): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from('PACK'));
  const objects: { sha: string; kind: ObjKind; body: Buffer }[] = [];
  for (const sha of shas) {
    const object = store.get(sha);
    if (object) objects.push({ sha, kind: object.kind, body: object.body });
  }
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(objects.length, 4);
  parts.push(header);

  for (const object of objects) {
    // type and size, varint-encoded: 3 bits of type then 4 bits per continuation byte group.
    const typeCode = object.kind === 'commit' ? 1 : object.kind === 'tree' ? 2 : object.kind === 'blob' ? 3 : 4;
    let size = object.body.length;
    let first = (typeCode << 4) | (size & 0x0f);
    size >>>= 4;
    const bytes: number[] = [];
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size >>>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.body));
  }

  const digest = createHash('sha1');
  for (const part of parts) digest.update(part);
  parts.push(digest.digest());
  return Buffer.concat(parts);
}

/** Parse a packfile into its objects, resolving OFS_DELTA and REF_DELTA. */
function readPack(store: Store, pack: Buffer): { sha: string; kind: ObjKind; body: Buffer }[] {
  const out: { sha: string; kind: ObjKind; body: Buffer }[] = [];
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') return out;
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) return out;
  const count = pack.readUInt32BE(8);
  let at = 12;
  const byOffset = new Map<number, { kind: ObjKind; body: Buffer }>();

  for (let index = 0; index < count && at < pack.length - 20; index += 1) {
    const start = at;
    let byte = pack[at];
    at += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0 && at < pack.length) {
      byte = pack[at];
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }

    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base, then a zlib stream.
      let offsetByte = pack[at];
      at += 1;
      let distance = offsetByte & 0x7f;
      while ((offsetByte & 0x80) !== 0 && at < pack.length) {
        offsetByte = pack[at];
        at += 1;
        distance = ((distance + 1) << 7) | (offsetByte & 0x7f);
      }
      const baseOffset = start - distance;
      const base = byOffset.get(baseOffset);
      const { body: delta, next } = inflateAt(pack, at);
      at = next;
      if (!base) continue;
      const resolved = applyDelta(base.body, delta);
      const entry = { kind: base.kind, body: resolved };
      byOffset.set(start, entry);
      out.push({ sha: objectSha(entry.kind, entry.body), kind: entry.kind, body: entry.body });
      continue;
    }

    if (typeCode === 7) {
      // REF_DELTA: the base's 20-byte id, then a zlib stream.
      const baseSha = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      const { body: delta, next } = inflateAt(pack, at);
      at = next;
      // The base may be earlier in this same pack, or already in the store (a thin pack).
      const inPack = [...byOffset.values()].length > 0 ? undefined : undefined;
      void inPack;
      let baseObject = store.get(baseSha);
      if (!baseObject) {
        for (const candidate of out) if (candidate.sha === baseSha) baseObject = candidate;
      }
      if (!baseObject) continue;
      const resolved = applyDelta(baseObject.body, delta);
      const entry = { kind: baseObject.kind, body: resolved };
      byOffset.set(start, entry);
      out.push({ sha: objectSha(entry.kind, entry.body), kind: entry.kind, body: entry.body });
      continue;
    }

    const kind: ObjKind = typeCode === 1 ? 'commit' : typeCode === 2 ? 'tree' : typeCode === 3 ? 'blob' : 'tag';
    const { body, next } = inflateAt(pack, at);
    at = next;
    const entry = { kind, body };
    byOffset.set(start, entry);
    out.push({ sha: objectSha(kind, body), kind, body });
    void size;
  }
  return out;
}

/**
 * Inflate one zlib stream starting at `at`, returning its bytes and the exact offset where the next
 * object begins. `engine.bytesWritten` is what makes a multi-object pack parseable: inflateSync on a
 * buffer with trailing bytes stops at the stream's end but reports nothing about where that end was,
 * so without this every pack would yield only its first object.
 */
function inflateAt(pack: Buffer, at: number): { body: Buffer; next: number } {
  try {
    const result = inflateSync(pack.subarray(at), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const consumed = result.engine?.bytesWritten ?? 0;
    const body = result.buffer ?? Buffer.alloc(0);
    // bytesWritten counts the bytes the engine consumed; a zero means the engine could not report it.
    const next = consumed > 0 ? at + consumed : pack.length - 20;
    return { body, next };
  } catch {
    // A truncated or corrupt stream: the object is unreadable, so nothing after it can be trusted.
    return { body: Buffer.alloc(0), next: pack.length - 20 };
  }
}

/** Apply a git delta to its base. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    let byte = delta[at];
    at += 1;
    while ((byte & 0x80) !== 0) {
      value |= (byte & 0x7f) << shift;
      shift += 7;
      byte = delta[at];
      at += 1;
    }
    value |= byte << shift;
    return value;
  };
  readVarint(); // the base's size, unused: the base is already in hand
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length && produced < targetSize) {
    const op = delta[at];
    at += 1;
    if ((op & 0x80) !== 0) {
      // A copy from the base: the offset and size are bit-flagged.
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset |= delta[at]; at += 1; }
      if (op & 0x02) { offset |= delta[at] << 8; at += 1; }
      if (op & 0x04) { offset |= delta[at] << 16; at += 1; }
      if (op & 0x08) { offset |= delta[at] << 24; at += 1; }
      if (op & 0x10) { size |= delta[at]; at += 1; }
      if (op & 0x20) { size |= delta[at] << 8; at += 1; }
      if (op & 0x40) { size |= delta[at] << 16; at += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      // An insert of `op` literal bytes.
      out.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
    }
  }
  return Buffer.concat(out);
}

/** Serve a receive-pack push: parse the command list and its packfile, apply, report status. */
function serveReceive(store: Store, repo: NonNullable<ReturnType<Store['repo']>>, body: Buffer, login: string): Buffer {
  // The command list runs until the first flush; the packfile (if any) follows it.
  const commands: { old: string; new: string; ref: string }[] = [];
  let at = 0;
  const caps: string[] = [];
  while (at + 4 <= body.length) {
    const header = body.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      at += 4;
      break;
    }
    if (length < 4) {
      at += 4;
      continue;
    }
    const payload = body.subarray(at + 4, at + length).toString('utf8');
    at += length;
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    const head = nul < 0 ? line : line.slice(0, nul);
    if (nul >= 0) caps.push(...line.slice(nul + 1).split(' '));
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(head);
    if (m) commands.push({ old: m[1], new: m[2], ref: m[3] });
  }
  const pack = body.subarray(at);
  if (DEBUG) process.stderr.write(`DEBUG readPack: body=${body.length} pack=${pack.length} commands=${commands.length}\n`);

  // Take every object the pack holds, so a push can reference them afterwards.
  const objects = readPack(store, pack);
  if (DEBUG) process.stderr.write(`DEBUG readPack: got ${objects.length} objects (${objects.map((o) => o.kind).join(',')})\n`);
  for (const object of objects) {
    if (!store.objects.has(object.sha)) store.objects.set(object.sha, { kind: object.kind, body: object.body });
  }
  // Commits the pack carries join the repo's reachable set.
  for (const object of objects) {
    if (object.kind !== 'commit') continue;
    const info = parseCommitSafe(object.body);
    repo.commits.set(object.sha, info);
  }

  // A pushed tree may name subtrees the pack also carried; walk from the pack's own trees so the store
  // is closed under tree entries (otherwise a later fetch cannot reach a nested blob). Walking the
  // pack, not the whole store, is what keeps a push O(new objects): the benchmark pushes 200 times into
  // one repository, and a full-store scan per push turns that into O(n^2).
  if (pack.length > 20) {
    const available = new Map<string, { kind: ObjKind; body: Buffer }>();
    for (const object of objects) available.set(object.sha, { kind: object.kind, body: object.body });
    const queue: { kind: ObjKind; body: Buffer }[] = objects.filter((object) => object.kind === 'tree');
    for (let at = 0; at < queue.length; at += 1) {
      const tree = queue[at];
      for (const entry of parseTree(tree.body)) {
        if (store.objects.has(entry.sha)) continue;
        const found = available.get(entry.sha);
        if (!found) continue;
        store.objects.set(found.sha, found);
        if (found.kind === 'tree') queue.push(found);
      }
    }
  }

  const results: { ref: string; ok: boolean; message?: string }[] = [];
  for (const command of commands) {
    // A delete is an all-zero new value.
    if (command.new === ZERO) {
      if (!repo.refs.has(command.ref)) {
        results.push({ ref: command.ref, ok: false, message: 'unable to delete: no such ref' });
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    // A create or update must name a commit we now hold, and its old value must match.
    const current = repo.refs.get(command.ref);
    if (command.old !== ZERO && current && current.sha !== command.old) {
      results.push({ ref: command.ref, ok: false, message: 'fetch first: the ref moved' });
      continue;
    }
    // A branch moves only forward: a new tip that does not descend from the old one is refused
    // (unless the command is a force, which the client signals by naming the old value as its base).
    if (current && command.old !== ZERO && command.ref.startsWith('refs/heads/') && repo.commits.has(current.sha) && repo.commits.has(command.new)) {
      const descends = [...store.ancestry(repo, command.new)].includes(current.sha);
      if (!descends) {
        results.push({ ref: command.ref, ok: false, message: 'non-fast-forward' });
        continue;
      }
    }
    if (!repo.commits.has(command.new) && !store.objects.has(command.new)) {
      results.push({ ref: command.ref, ok: false, message: 'missing necessary objects' });
      continue;
    }
    repo.refs.set(command.ref, { sha: command.new, symref: null });
    if (command.ref.startsWith('refs/heads/')) {
      const head = repo.refs.get('HEAD');
      if (!head) repo.refs.set('HEAD', { sha: command.new, symref: command.ref });
      else if (head.symref === command.ref) repo.refs.set('HEAD', { sha: command.new, symref: command.ref });
    }
    void login;
    results.push({ ref: command.ref, ok: true });
  }

  // report-status / report-status-v2 over side-band-64k when the client negotiated it.
  const wantsV2Report = caps.includes('report-status-v2');
  const useSideband = caps.includes('side-band-64k');
  const reportParts: Buffer[] = [];
  reportParts.push(pkt(`unpack ok\n`));
  for (const result of results) {
    if (result.ok) {
      reportParts.push(pkt(wantsV2Report ? `ok ${result.ref}\n` : `ok ${result.ref}\n`));
    } else {
      reportParts.push(pkt(`ng ${result.ref} ${result.message ?? 'failed'}\n`));
    }
  }
  reportParts.push(flush());
  const report = Buffer.concat(reportParts);

  if (useSideband) {
    return Buffer.concat([...sideband(BAND_DATA, report), pkt('')]);
  }
  return report;
}

/** Parse a commit body into the store's CommitInfo, tolerating odd idents. */
function parseCommitSafe(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2).replace(/\n$/, '');
  const info: CommitInfo = { tree: EMPTY_TREE_SHA, parents: [], author: '', committer: '', message, time: 1735689600, tz: '+0000' };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5);
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
    else if (line.startsWith('author ')) {
      const value = line.slice(7);
      const m = /(\d+) ([+-]\d{4})$/.exec(value);
      if (m) {
        info.time = Number(m[1]);
        info.tz = m[2];
        info.author = value.slice(0, m.index).trim();
      } else info.author = value;
    } else if (line.startsWith('committer ')) {
      const value = line.slice(10);
      const m = /(\d+) ([+-]\d{4})$/.exec(value);
      info.committer = m ? value.slice(0, m.index).trim() : value;
    }
  }
  return info;
}

/** Re-export the tree parser so app-level code can flatten a pushed tree without a second import. */
export { parseTree, type TreeEntry };
