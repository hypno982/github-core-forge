// store.ts: the forge's own store. Everything the API and git surface read lives here.
//
// Determinism matters: the scorer runs the same suite twice and compares the state export byte
// for byte, so nothing here reads the clock, Math.random, or the process. Every id is a counter,
// every sha is derived from content, and every timestamp comes from the fixed epoch the scenario
// names (FIXED_EPOCH_SEC) unless the caller passes one.

import { createHash } from 'node:crypto';

/** The seeded scenario's fixed epoch: every created object dates from here (2025-01-01T00:00:00Z). */
export const FIXED_EPOCH_SEC = 1735689600;

/** The empty tree's sha: git hashes an empty tree object this way, always. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type ObjKind = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  kind: ObjKind;
  /** The object's raw bytes. A sha is sha1("<kind> <len>\0" + bytes). */
  body: Buffer;
}

export interface TreeEntry {
  /** '100644' file, '100755' executable, '40000' directory, '120000' symlink. */
  mode: string;
  name: string;
  sha: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Seconds since the epoch. */
  time: number;
  /** The fixed zone every seeded commit carries. */
  tz: string;
}

export interface RefInfo {
  sha: string;
  /** A symbolic ref's target (HEAD -> refs/heads/main), else null. */
  symref: string | null;
}

export interface FileEntry {
  path: string;
  /** The blob's sha. */
  sha: string;
  mode: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  created_at: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  comments: IssueComment[];
  /** The next comment id is per repo (one counter), so a comment's id is stable. */
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  sha: string;
  previous_filename?: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  user: string;
  created_at: string;
  updated_at: string;
  merged: boolean;
  mergeable: boolean;
  merge_commit_sha: string | null;
  merged_at: string | null;
  closed_at: string | null;
  files: PullFile[];
}

export interface Repo {
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  created_at: string;
  updated_at: string;
  /** Every ref this repo holds, by full name ('refs/heads/main'). */
  refs: Map<string, RefInfo>;
  /** Every commit this repo can reach, by sha; blobs and trees are in the shared object store. */
  commits: Map<string, CommitInfo>;
  issues: Map<number, Issue>;
  labels: Map<string, Label>;
  pulls: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  fork: boolean;
}

/** Canonical seconds -> the ISO string every API field uses. */
export function isoOf(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const textEncoder = new TextEncoder();

/** sha1 over "<kind> <len>\0" + body: git's own object id. */
export function objectSha(kind: ObjKind, body: Buffer): string {
  const hash = createHash('sha1');
  hash.update(textEncoder.encode(`${kind} ${body.length}\u0000`));
  hash.update(body);
  return hash.digest('hex');
}

/** Serialize a tree's entries the git way: sorted, mode and name, then the raw 20-byte sha. */
export function treeBody(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const head = Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8');
    const sha = Buffer.from(entry.sha, 'hex');
    parts.push(head, sha);
  }
  return Buffer.concat(parts);
}

/** Serialize a commit the git way. */
export function commitBody(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author} ${info.time} ${info.tz}`);
  lines.push(`committer ${info.committer} ${info.time} ${info.tz}`);
  lines.push('');
  lines.push(info.message);
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/** Serialize an annotated tag. */
export function tagBody(object: string, kind: string, name: string, tagger: string, time: number, tz: string, message: string): Buffer {
  const lines = [`object ${object}`, `type ${kind}`, `tag ${name}`, `tagger ${tagger} ${time} ${tz}`, '', message];
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/** Parse a serialized tree back into its entries. */
export function parseTree(body: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let at = 0;
  while (at < body.length) {
    const nul = body.indexOf(0, at);
    if (nul < 0) break;
    const head = body.subarray(at, nul).toString('utf8');
    const space = head.indexOf(' ');
    const mode = head.slice(0, space);
    const name = head.slice(space + 1);
    const sha = body.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, sha });
    at = nul + 21;
  }
  return out;
}

/** Parse a serialized commit. */
export function parseCommit(body: Buffer): CommitInfo {
  const text = body.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2).replace(/\n$/, '');
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message, time: FIXED_EPOCH_SEC, tz: '+0000' };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5);
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7));
    else if (line.startsWith('author ')) {
      info.author = line.slice(7);
      const m = /(\d+) ([+-]\d{4})$/.exec(info.author);
      if (m) {
        info.time = Number(m[1]);
        info.tz = m[2];
        info.author = info.author.slice(0, m.index).trim();
      }
    } else if (line.startsWith('committer ')) {
      info.committer = line.slice(10);
      const m = /(\d+) ([+-]\d{4})$/.exec(info.committer);
      if (m) info.committer = info.committer.slice(0, m.index).trim();
    }
  }
  return info;
}

/** The whole forge: one owner's repositories plus the object store they share. */
export class Store {
  readonly repos = new Map<string, Repo>();
  readonly objects = new Map<string, GitObject>();
  /** The login the bearer token owns; every repository created through the API belongs to it. */
  readonly viewer: string;
  /** Another seeded login with no rights on the viewer's repositories. */
  readonly stranger: string;

  constructor(viewer: string, stranger: string) {
    this.viewer = viewer;
    this.stranger = stranger;
  }

  /** Put one object in the store and return its sha. */
  put(kind: ObjKind, body: Buffer): string {
    const sha = objectSha(kind, body);
    if (!this.objects.has(sha)) this.objects.set(sha, { kind, body });
    return sha;
  }

  /** The object with this sha, or undefined. */
  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  /** Store a blob and return its sha. */
  putBlob(bytes: Buffer | string): string {
    return this.put('blob', Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'));
  }

  /** Store a tree from its entries and return its sha (an empty entry list is the empty tree). */
  putTree(entries: readonly TreeEntry[]): string {
    if (entries.length === 0) {
      const sha = EMPTY_TREE_SHA;
      if (!this.objects.has(sha)) this.objects.set(sha, { kind: 'tree', body: Buffer.alloc(0) });
      return sha;
    }
    return this.put('tree', treeBody(entries));
  }

  /** Store a commit and return its sha. */
  putCommit(info: CommitInfo): string {
    return this.put('commit', commitBody(info));
  }

  /** The key a repository is stored under: owner/name lowercased, as GitHub treats it. */
  static key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  /** Find a repository by owner and name, or undefined. */
  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  /** Create a repository record; the caller decides whether the name is taken. */
  createRepo(owner: string, name: string, opts: { description?: string | null; private?: boolean; defaultBranch?: string } = {}): Repo {
    const now = isoOf(FIXED_EPOCH_SEC);
    const repo: Repo = {
      name,
      owner,
      description: opts.description ?? null,
      private: opts.private === true,
      default_branch: opts.defaultBranch ?? 'main',
      created_at: now,
      updated_at: now,
      refs: new Map(),
      commits: new Map(),
      issues: new Map(),
      labels: new Map(),
      pulls: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      fork: false,
    };
    this.repos.set(Store.key(owner, name), repo);
    return repo;
  }

  /** Every repository this owner holds, in creation order (name order, since names are unique). */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    return out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
  }

  /** Read a ref ('refs/heads/main', 'HEAD') as this repo has it. */
  refOf(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') {
      const head = repo.refs.get('HEAD');
      if (head?.symref) return repo.refs.get(head.symref)?.sha ?? null;
      return head?.sha ?? null;
    }
    const direct = repo.refs.get(ref);
    if (direct) return direct.sha;
    // A short name is resolved against the usual namespaces, as git does.
    for (const prefix of ['refs/heads/', 'refs/tags/', 'refs/']) {
      const found = repo.refs.get(prefix + ref);
      if (found) return found.sha;
    }
    return null;
  }

  /** Resolve a commit-ish to a commit sha: a ref, a full sha, or a short sha. */
  commitOf(repo: Repo, ref: string): string | null {
    const direct = this.refOf(repo, ref);
    const sha = direct ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : null);
    if (sha === null) return null;
    // A tag peels to its target.
    const object = this.objects.get(sha);
    if (object?.kind === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(object.body.toString('utf8'));
      if (m) return repo.commits.has(m[1]) ? m[1] : null;
    }
    return repo.commits.has(sha) ? sha : null;
  }

  /** Walk from a commit back through its parents, nearest first. */
  *ancestry(repo: Repo, sha: string): Generator<string> {
    const seen = new Set<string>();
    const queue = [sha];
    while (queue.length > 0) {
      const at = queue.shift() as string;
      if (seen.has(at)) continue;
      seen.add(at);
      yield at;
      const info = repo.commits.get(at);
      if (!info) continue;
      for (const parent of info.parents) if (!seen.has(parent)) queue.push(parent);
    }
  }

  /** Flatten a tree into every file it holds, path -> sha, depth first. */
  flatTree(treeSha: string, prefix = '', seen = new Set<string>()): FileEntry[] {
    const out: FileEntry[] = [];
    const object = this.objects.get(treeSha);
    if (!object || object.kind !== 'tree') return out;
    // A cycle cannot exist in a well-formed history, but a malformed pack could make one.
    if (seen.has(treeSha)) return out;
    seen.add(treeSha);
    for (const entry of parseTree(object.body)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') out.push(...this.flatTree(entry.sha, path, seen));
      else out.push({ path, sha: entry.sha, mode: entry.mode });
    }
    return out;
  }

  /** The file entries of one commit, path -> entry. */
  filesOfCommit(repo: Repo, sha: string): Map<string, FileEntry> {
    const info = repo.commits.get(sha);
    const out = new Map<string, FileEntry>();
    if (!info) return out;
    for (const entry of this.flatTree(info.tree)) out.set(entry.path, entry);
    return out;
  }

  /** Build a tree from a path -> {sha, mode} map, nesting directories as git does. */
  buildTree(files: Map<string, { sha: string; mode: string }>): string {
    // Group by the first path segment; a file with no slash sits at this level.
    const direct: TreeEntry[] = [];
    const dirs = new Map<string, Map<string, { sha: string; mode: string }>>();
    for (const [path, value] of files) {
      const slash = path.indexOf('/');
      if (slash < 0) direct.push({ mode: value.mode, name: path, sha: value.sha });
      else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        let bucket = dirs.get(dir);
        if (!bucket) {
          bucket = new Map();
          dirs.set(dir, bucket);
        }
        bucket.set(rest, value);
      }
    }
    for (const [dir, bucket] of dirs) {
      direct.push({ mode: '40000', name: dir, sha: this.buildTree(bucket) });
    }
    return this.putTree(direct);
  }

  /** The blob bytes at a path in a commit, or null. */
  blobAt(repo: Repo, commitSha: string, path: string): Buffer | null {
    const files = this.filesOfCommit(repo, commitSha);
    const entry = files.get(path);
    if (!entry) return null;
    const object = this.objects.get(entry.sha);
    return object ? object.body : null;
  }

  /**
   * Commit a change to `files` on top of `parentSha` (or the empty tree when null) and advance
   * `refName` to it. This is the one write path the contents API and git receive-pack share.
   */
  commitFiles(repo: Repo, refName: string, parentSha: string | null, files: Map<string, { sha: string; mode: string }>, message: string, author: string): string {
    const tree = this.buildTree(files);
    const info: CommitInfo = {
      tree,
      parents: parentSha === null ? [] : [parentSha],
      author,
      committer: author,
      message,
      time: FIXED_EPOCH_SEC,
      tz: '+0000',
    };
    const sha = this.putCommit(info);
    repo.commits.set(sha, info);
    repo.refs.set(refName, { sha, symref: null });
    if (refName.startsWith('refs/heads/') && !repo.refs.has('HEAD')) {
      repo.refs.set('HEAD', { sha, symref: refName });
    }
    repo.updated_at = isoOf(FIXED_EPOCH_SEC);
    return sha;
  }

  /** The files of a ref's commit, or an empty map for an unborn branch. */
  filesOfRef(repo: Repo, refName: string): Map<string, { sha: string; mode: string }> {
    const sha = this.refOf(repo, refName);
    if (sha === null) return new Map();
    const out = new Map<string, { sha: string; mode: string }>();
    for (const [path, entry] of this.filesOfCommit(repo, sha)) out.set(path, { sha: entry.sha, mode: entry.mode });
    return out;
  }
}
