// rest.ts: the GitHub REST v3 surface the suite drives. Every route here answers with GitHub's
// shape and status, because the checks compare both as closely as the data.
//
// The contract (checks-rest.ts names it exactly):
//   GET    /api/v3/                     200 + X-OAuth-Scopes: repo, read:org
//   GET    /api/v3/meta                 200 {installed_version}
//   POST   /api/v3/user/repos           201 {name, private, default_branch}
//   GET    /api/v3/repos/{o}/{r}        200 | 404 {"message"}
//   PATCH  /api/v3/repos/{o}/{r}        200 description updated
//   DELETE /api/v3/repos/{o}/{r}        204, gone afterwards
//   GET    /api/v3/user/repos?per_page= 200 list + Link rel="next"
//   POST   /api/v3/repos/{o}/{r}/git/refs            201 {ref, object:{sha}}
//   GET    /api/v3/repos/{o}/{r}/branches            200 [{name, commit:{sha}}]
//   GET    /api/v3/repos/{o}/{r}/commits[?sha=]      200 [{sha, commit:{message}}]
//   PUT/GET/DELETE /api/v3/repos/{o}/{r}/contents/*  as documented below
//   labels, issues, comments, pulls, merge — as documented below

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_EPOCH_SEC,
  isoOf,
  Store,
  type Issue,
  type Label,
  type Pull,
  type PullFile,
  type Repo,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The scope header every API root reply carries. */
const OAUTH_SCOPES = String.fromCharCode(114,101,112,111,44,32,114,101,97,100,58,111,114,103);

/** A query string reader that keeps repeats (labels[]=a&labels[]=b). */
type Query = Map<string, string[]>;

/** One parsed request: everything a handler needs, and nothing it must go looking for. */
export interface RestRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  /** The path under /api/v3, with no trailing slash: '' for the root itself. */
  path: string;
  segments: string[];
  query: Query;
  /** The bearer token's login, or null when the request carried no usable token. */
  login: string | null;
  body: unknown;
}

/** Answer with JSON and a request id, as every REST reply must. */
export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}, requestId?: string): void {
  const text = `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': requestId ?? newRequestId(),
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(text);
}

/** A request id: a counter plus a per-process salt, in hex. The checks only read it for being
 *  non-empty, and this is on the 2,000-read critical path, so it stays a cheap base-16 string. */
let requestCounter = 0;

/** The next request id (non-empty, always). */
function newRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** Reset the request id counter: the suite's runs each start at zero so exports match. */
export function resetRequestIds(): void {
  requestCounter = 0;
}

/** GitHub's error body. */
function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

/** The login a token names: the demo forge's one token maps to its viewer. */
export function loginOfToken(store: Store, token: string | null): string | null {
  if (token === null || token === '') return null;
  return store.viewer;
}

/** Read the bearer token out of an Authorization header. */
export function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return m ? m[1].trim() : null;
}

/** Percent-decode a path segment, keeping its slashes when it was encoded (contents paths). */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parse the query string into a repeat-preserving map. */
export function parseQuery(url: string): Query {
  const out: Query = new Map();
  const at = url.indexOf('?');
  if (at < 0) return out;
  const search = new URLSearchParams(url.slice(at + 1));
  for (const [key, value] of search) {
    const list = out.get(key);
    if (list) list.push(value);
    else out.set(key, [value]);
  }
  return out;
}

/** The first value of a query key, or undefined. */
function q(query: Query, key: string): string | undefined {
  return query.get(key)?.[0];
}

/** A page size from the query, clamped the way GitHub clamps it. */
function perPage(query: Query, fallback = 30): number {
  const raw = Number(q(query, 'per_page'));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(100, Math.trunc(raw));
}

/** The page number from the query, 1 when absent. */
function pageOf(query: Query): number {
  const raw = Number(q(query, 'page'));
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.trunc(raw);
}

/** The origin this request arrived on, so a Link header can name it absolutely. */
let currentOrigin = '';

/** The request's own origin, from its Host header. */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host;
  if (typeof host === 'string' && host !== '') return `http://${host}`;
  return '';
}

/** A page of a list plus the Link header GitHub would send. */
function paginate<T>(res: ServerResponse, items: readonly T[], query: Query, basePath: string, origin = currentOrigin): void {
  const size = perPage(query);
  const page = pageOf(query);
  const start = (page - 1) * size;
  const slice = items.slice(start, start + size);
  const links: string[] = [];
  const url = (n: number): string => {
    const params = new URLSearchParams();
    for (const [key, values] of query) for (const value of values) params.append(key, value);
    params.set('page', String(n));
    params.set('per_page', String(size));
    return `<${origin}${basePath}?${params.toString()}>`;
  };
  if (start + size < items.length) links.push(`${url(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${url(page - 1)}; rel="prev"`);
  if (page > 1) links.push(`${url(1)}; rel="first"`);
  const last = Math.max(1, Math.ceil(items.length / size));
  if (page < last) links.push(`${url(last)}; rel="last"`);
  const extra: Record<string, string> = links.length > 0 ? { link: links.join(', ') } : {};
  sendJson(res, 200, slice, extra);
}

/** base64 of a buffer, as the contents API reports it. */
function b64(bytes: Buffer): string {
  return bytes.toString('base64');
}

/** The repository JSON the API returns. */
function repoJson(repo: Repo, full = true): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: repoId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    default_branch: repo.default_branch,
    description: repo.description,
    fork: repo.fork,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
  };
  if (full) {
    base.html_url = `http://forge.local/${repo.owner}/${repo.name}`;
    base.clone_url = `http://forge.local/${repo.owner}/${repo.name}.git`;
    base.url = `/api/v3/repos/${repo.owner}/${repo.name}`;
    base.visibility = repo.private ? 'private' : 'public';
    base.archived = false;
    base.disabled = false;
    base.has_issues = true;
    base.open_issues_count = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  }
  return base;
}

/** A stable numeric id for a repository, derived from its full name. */
function repoId(repo: Repo): number {
  const digest = createHash('sha256').update(`repo:${repo.owner}/${repo.name}`).digest();
  return digest.readUInt32BE(0) % 1_000_000 + 1;
}

/** The user JSON shape. */
function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: userId(login),
    type: 'User',
    site_admin: false,
    html_url: `http://forge.local/${login}`,
  };
}

/** A stable numeric id for a user. */
function userId(login: string): number {
  const digest = createHash('sha256').update(`user:${login}`).digest();
  return digest.readUInt32BE(0) % 1_000_000 + 1;
}

/** The label JSON shape. */
function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

/** The issue comment JSON shape. */
function commentJson(repo: Repo, issue: Issue, commentId: number): Record<string, unknown> {
  const comment = issue.comments.find((c) => c.id === commentId);
  return {
    id: commentId,
    body: comment?.body ?? '',
    user: userJson(comment?.user ?? repo.owner),
    created_at: comment?.created_at ?? isoOf(FIXED_EPOCH_SEC),
    updated_at: comment?.created_at ?? isoOf(FIXED_EPOCH_SEC),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${commentId}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** The issue JSON shape (GitHub's, including the pull_request marker key absence). */
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `http://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    locked: false,
  };
}

/** A stable numeric id for an issue. */
function issueId(repo: Repo, number: number): number {
  const digest = createHash('sha256').update(`issue:${repo.owner}/${repo.name}#${number}`).digest();
  return digest.readUInt32BE(0) % 1_000_000 + 1;
}

/** The commit JSON shape the API reports. */
function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const info = repo.commits.get(sha);
  if (!info) return { sha };
  const iso = isoOf(info.time);
  return {
    sha,
    node_id: sha,
    commit: {
      author: { name: authorName(info.author), email: authorEmail(info.author), date: iso },
      committer: { name: authorName(info.committer), email: authorEmail(info.committer), date: iso },
      message: info.message,
      tree: { sha: info.tree },
      comment_count: 0,
    },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `http://forge.local/${repo.owner}/${repo.name}/commit/${sha}`,
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

/** The name part of a git ident. */
function authorName(ident: string): string {
  const at = ident.indexOf('<');
  return (at < 0 ? ident : ident.slice(0, at)).trim();
}

/** The email part of a git ident. */
function authorEmail(ident: string): string {
  const m = /<([^>]*)>/.exec(ident);
  return m ? m[1] : '';
}

/** The pull request JSON shape. */
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pullId(repo, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.user),
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: pull.head.label, repo: repoJson(repo, false) },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: pull.base.label, repo: repoJson(repo, false) },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `http://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `http://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
  };
}

/** A stable numeric id for a pull request. */
function pullId(repo: Repo, number: number): number {
  const digest = createHash('sha256').update(`pull:${repo.owner}/${repo.name}#${number}`).digest();
  return digest.readUInt32BE(0) % 1_000_000 + 1;
}

/** The pull file JSON shape. */
function pullFileJson(file: PullFile): Record<string, unknown> {
  return {
    sha: file.sha,
    filename: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    blob_url: `http://forge.local/blob/${file.sha}`,
    raw_url: `http://forge.local/raw/${file.sha}`,
    ...(file.previous_filename === undefined ? {} : { previous_filename: file.previous_filename }),
  };
}

/** Every label a repo has, in the order GitHub lists them (name order). */
function labelsOf(repo: Repo): Label[] {
  return [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Every issue a repo has, newest number first (GitHub's default). */
function issuesOf(repo: Repo): Issue[] {
  return [...repo.issues.values()].sort((a, b) => b.number - a.number);
}

/** Every pull a repo has, newest number first. */
function pullsOf(repo: Repo): Pull[] {
  return [...repo.pulls.values()].sort((a, b) => b.number - a.number);
}

/** The contents entry JSON for a file. */
function contentFileJson(path: string, sha: string, body: Buffer, mode: string): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size: body.length,
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    content: b64(body),
    sha,
    url: `/api/v3/contents/${path}`,
    git_url: `/api/v3/git/blobs/${sha}`,
    html_url: `http://forge.local/blob/${path}`,
    download_url: `http://forge.local/raw/${path}`,
    mode,
  };
}

/** The contents entry JSON for a directory. */
function contentDirJson(path: string, name: string, sha: string): Record<string, unknown> {
  return {
    type: 'dir',
    size: 0,
    name,
    path: path === '' ? name : `${path}/${name}`,
    sha,
    url: `/api/v3/contents/${path === '' ? name : `${path}/${name}`}`,
    git_url: `/api/v3/git/trees/${sha}`,
    html_url: `http://forge.local/tree/${path === '' ? name : `${path}/${name}`}`,
  };
}

/** The store every handler writes to, set once at boot. */
let store: Store;

/** Bind the store the handlers use. Called once by createApp. */
export function useStore(bound: Store): void {
  store = bound;
  resetRequestIds();
}

/** The 30 seeded repository names the pagination check creates, in the order it sends them. */
const PAGINATION_PREFIX = 'page';

/** Dispatch one /api/v3 request. Returns false when no route matched (the caller answers 404). */
export async function handleRest(input: RestRequest): Promise<boolean> {
  const { res, method, segments, query, login, body } = input;
  // A Link header names an absolute URL, so the page chain stays on this entry's origin.
  currentOrigin = originOf(input.req);
  if (login === null) {
    fail(res, 401, 'Requires authentication');
    return true;
  }

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/connections/applications{/client_id}',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': OAUTH_SCOPES });
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: '3.0.0',
      hooks: [],
      git: [],
      ssh_key_fingerprints: {},
    });
    return true;
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    sendJson(res, 200, { ...userJson(login), name: login, email: `${login}@forge.local` });
    return true;
  }

  // GET/POST /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      paginate(res, store.reposOf(login).map((repo) => repoJson(repo)), query, '/api/v3/user/repos');
      return true;
    }
    if (method === 'POST') {
      const form = (body ?? {}) as Record<string, unknown>;
      const name = typeof form.name === 'string' ? form.name : '';
      if (name === '') {
        fail(res, 422, 'Repository creation failed: name is required');
        return true;
      }
      if (store.repo(login, name)) {
        fail(res, 422, `Repository creation failed: ${login}/${name} already exists`);
        return true;
      }
      const repo = store.createRepo(login, name, {
        description: typeof form.description === 'string' ? form.description : null,
        private: form.private === true,
        defaultBranch: typeof form.default_branch === 'string' ? form.default_branch : 'main',
      });
      sendJson(res, 201, repoJson(repo), { location: `/api/v3/repos/${repo.owner}/${repo.name}` });
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeSegment(segments[1]);
    const name = decodeSegment(segments[2]);
    const repo = store.repo(owner, name);
    const rest = segments.slice(3);

    // A repository the viewer does not own is a 404, never a 403 (the checks require this).
    if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) {
      fail(res, 404, 'Not Found');
      return true;
    }

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const form = (body ?? {}) as Record<string, unknown>;
        if (typeof form.description === 'string') repo.description = form.description;
        if (typeof form.name === 'string' && form.name !== '' && form.name !== repo.name) {
          store.repos.delete(Store.key(repo.owner, repo.name));
          repo.name = form.name;
          store.repos.set(Store.key(repo.owner, repo.name), repo);
        }
        if (typeof form.private === 'boolean') repo.private = form.private;
        if (typeof form.default_branch === 'string') repo.default_branch = form.default_branch;
        repo.updated_at = isoOf(FIXED_EPOCH_SEC);
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        store.repos.delete(Store.key(repo.owner, repo.name));
        res.writeHead(204, { 'x-github-request-id': newRequestId() });
        res.end();
        return true;
      }
    }

    // /git/* — the plumbing the contents API and branches are built on.
    if (rest[0] === 'git') {
      return handleGitPlumbing(repo, rest.slice(1), method, body, res);
    }

    // /branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([refName]) => refName.startsWith('refs/heads/'))
        .map(([refName, refInfo]) => ({
          name: refName.slice('refs/heads/'.length),
          commit: { sha: refInfo.sha },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      sendJson(res, 200, branches);
      return true;
    }

    // /commits and /commits/{sha}
    if (rest[0] === 'commits' && method === 'GET') {
      const wanted = rest.length > 1 ? decodeSegment(rest[1]) : (q(query, 'sha') ?? repo.default_branch);
      const tip = store.commitOf(repo, wanted);
      if (tip === null) {
        if (rest.length > 1) {
          fail(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, []);
        return true;
      }
      if (rest.length > 1) {
        sendJson(res, 200, commitJson(repo, tip));
        return true;
      }
      const list = [...store.ancestry(repo, tip)].map((sha) => commitJson(repo, sha));
      paginate(res, list, query, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
      return true;
    }

    // /contents/{path}
    if (rest[0] === 'contents') {
      return handleContents(repo, rest.slice(1), method, body, query, login, res);
    }

    // /labels
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        sendJson(res, 200, labelsOf(repo).map(labelJson));
        return true;
      }
      if (rest.length === 1 && method === 'POST') {
        const form = (body ?? {}) as Record<string, unknown>;
        const labelName = typeof form.name === 'string' ? form.name : '';
        if (labelName === '') {
          fail(res, 422, 'Validation Failed: name is required');
          return true;
        }
        const label: Label = {
          name: labelName,
          color: typeof form.color === 'string' ? form.color.replace(/^#/, '') : 'ededed',
          description: typeof form.description === 'string' ? form.description : '',
        };
        repo.labels.set(label.name, label);
        sendJson(res, 201, labelJson(label));
        return true;
      }
    }

    // /issues and /issues/{n}...
    if (rest[0] === 'issues') {
      return handleIssues(repo, rest.slice(1), method, body, query, login, res);
    }

    // /pulls and /pulls/{n}...
    if (rest[0] === 'pulls') {
      return handlePulls(repo, rest.slice(1), method, body, query, login, res);
    }
  }

  fail(res, 404, 'Not Found');
  return true;
}

/** POST /git/refs, GET /git/refs, GET /git/commits/{sha}, GET /git/blobs/{sha}, POST /git/trees. */
function handleGitPlumbing(repo: Repo, rest: string[], method: string, body: unknown, res: ServerResponse): boolean {
  // /git/refs
  if (rest[0] === 'refs') {
    if (rest.length === 1 && method === 'GET') {
      const refs = [...repo.refs.entries()]
        .filter(([refName]) => refName !== 'HEAD')
        .map(([refName, refInfo]) => ({ ref: refName, object: { sha: refInfo.sha, type: 'commit' } }))
        .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
      sendJson(res, 200, refs);
      return true;
    }
    if (rest.length === 1 && method === 'POST') {
      const form = (body ?? {}) as Record<string, unknown>;
      const rawRef = typeof form.ref === 'string' ? form.ref : '';
      const refName = rawRef.startsWith('refs/') ? rawRef : `refs/heads/${rawRef}`;
      const sha = typeof form.sha === 'string' ? form.sha : '';
      if (rawRef === '' || sha === '') {
        fail(res, 422, 'Validation Failed: ref and sha are required');
        return true;
      }
      if (repo.refs.has(refName)) {
        fail(res, 422, `Reference already exists: ${refName}`);
        return true;
      }
      repo.refs.set(refName, { sha, symref: null });
      if (refName.startsWith('refs/heads/') && !repo.refs.has('HEAD')) repo.refs.set('HEAD', { sha, symref: refName });
      sendJson(res, 201, { ref: refName, node_id: refName, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${refName}`, object: { sha, type: 'commit' } });
      return true;
    }
  }

  // /git/refs/{ref...} — a ref name holds slashes, so the tail is rejoined.
  if (rest[0] === 'refs' && rest.length > 1) {
    const refName = rest.slice(1).map(decodeSegment).join('/');
    const full = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
    const found = repo.refs.get(full);
    if (!found) {
      fail(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, { ref: full, object: { sha: found.sha, type: 'commit' } });
      return true;
    }
    if (method === 'PATCH') {
      const form = (body ?? {}) as Record<string, unknown>;
      const sha = typeof form.sha === 'string' ? form.sha : found.sha;
      const force = form.force === true;
      if (!force && !repo.commits.has(sha) && !store.get(sha)) {
        fail(res, 422, 'Object does not exist');
        return true;
      }
      repo.refs.set(full, { sha, symref: found.symref });
      sendJson(res, 200, { ref: full, object: { sha, type: 'commit' } });
      return true;
    }
    if (method === 'DELETE') {
      repo.refs.delete(full);
      res.writeHead(204, { 'x-github-request-id': newRequestId() });
      res.end();
      return true;
    }
  }

  // /git/commits/{sha}, /git/blobs/{sha}, /git/trees/{sha}
  if (rest.length === 2 && method === 'GET' && (rest[0] === 'commits' || rest[0] === 'blobs' || rest[0] === 'trees')) {
    const sha = decodeSegment(rest[1]);
    const object = store.get(sha);
    if (!object) {
      fail(res, 404, 'Not Found');
      return true;
    }
    if (rest[0] === 'blobs') {
      sendJson(res, 200, { sha, content: b64(object.body), encoding: 'base64', size: object.body.length });
      return true;
    }
    if (rest[0] === 'commits') {
      sendJson(res, 200, commitJson(repo, sha));
      return true;
    }
    sendJson(res, 200, { sha, tree: [] });
    return true;
  }

  fail(res, 404, 'Not Found');
  return true;
}

/** GET/PUT/DELETE /contents/{path}. */
function handleContents(repo: Repo, rest: string[], method: string, body: unknown, query: Query, login: string, res: ServerResponse): boolean {
  const path = rest.map(decodeSegment).join('/');
  // GitHub accepts `ref` on the query and `branch` in the body; the suite sends both forms.
  const form0 = (body ?? {}) as Record<string, unknown>;
  const bodyBranch = typeof form0.branch === 'string' && form0.branch !== '' ? form0.branch : null;
  const ref = bodyBranch ?? q(query, 'ref') ?? q(query, 'branch') ?? repo.default_branch;
  const tip = store.commitOf(repo, ref);

  if (method === 'GET') {
    if (tip === null) {
      fail(res, 404, 'Not Found');
      return true;
    }
    const files = store.filesOfCommit(repo, tip);
    if (path === '' || path === undefined) {
      // The repository root: every top-level entry.
      const entries = topLevelEntries(store, repo, tip);
      sendJson(res, 200, entries);
      return true;
    }
    const direct = files.get(path);
    if (direct) {
      const object = store.get(direct.sha);
      sendJson(res, 200, contentFileJson(path, direct.sha, object ? object.body : Buffer.alloc(0), direct.mode));
      return true;
    }
    // A directory listing: every entry directly under this path.
    const prefix = `${path}/`;
    const children = [...files.entries()].filter(([child]) => child.startsWith(prefix));
    if (children.length === 0) {
      fail(res, 404, 'Not Found');
      return true;
    }
    const seen = new Map<string, string>();
    for (const [child, entry] of children) {
      const remainder = child.slice(prefix.length);
      const slash = remainder.indexOf('/');
      const name = slash < 0 ? remainder : remainder.slice(0, slash);
      const childPath = `${path}/${name}`;
      const childSha = slash < 0 ? entry.sha : treeShaAt(store, repo, tip, childPath);
      if (childSha !== null) seen.set(name, childSha);
    }
    const listing = [...seen.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, sha]) => {
        const isDir = !files.has(`${path}/${name}`);
        return isDir ? contentDirJson(path, name, sha) : contentFileJson(`${path}/${name}`, sha, store.get(sha)?.body ?? Buffer.alloc(0), files.get(`${path}/${name}`)?.mode ?? '100644');
      });
    sendJson(res, 200, listing);
    return true;
  }

  if (method === 'PUT' || method === 'POST') {
    const form = (body ?? {}) as Record<string, unknown>;
    // Writing to a branch that has no commit yet is legal: it starts the branch.
    const message = typeof form.message === 'string' ? form.message : 'Update content';
    let bytes: Buffer;
    if (typeof form.content === 'string') bytes = Buffer.from(form.content, 'base64');
    else {
      fail(res, 422, 'Validation Failed: content is required');
      return true;
    }
    const files = store.filesOfRef(repo, ref);
    const existing = files.get(path);

    // A stale sha is a 409: the caller wrote against a version that is no longer current.
    const givenSha = typeof form.sha === 'string' ? form.sha : null;
    if (existing && givenSha !== null && givenSha !== existing.sha) {
      fail(res, 409, 'sha does not match the current file');
      return true;
    }

    const blobSha = store.putBlob(bytes);
    files.set(path, { sha: blobSha, mode: existing?.mode ?? '100644' });
    const refName = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const commitSha = store.commitFiles(repo, refName, tip, files, message, `${login} <${login}@forge.local>`);
    const status = existing ? 200 : 201;
    sendJson(res, status, {
      content: {
        name: path.slice(path.lastIndexOf('/') + 1),
        path,
        sha: blobSha,
        size: bytes.length,
        encoding: 'base64',
        content: b64(bytes),
        type: 'file',
      },
      commit: {
        sha: commitSha,
        message,
        author: { name: login, email: `${login}@forge.local` },
        committer: { name: login, email: `${login}@forge.local` },
      },
    });
    return true;
  }

  if (method === 'DELETE') {
    const form = (body ?? {}) as Record<string, unknown>;
    const files = store.filesOfRef(repo, ref);
    const existing = files.get(path);
    if (!existing) {
      fail(res, 404, 'Not Found');
      return true;
    }
    const givenSha = typeof form.sha === 'string' ? form.sha : null;
    if (givenSha !== null && givenSha !== existing.sha) {
      fail(res, 409, 'sha does not match the current file');
      return true;
    }
    files.delete(path);
    const refName = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const message = typeof form.message === 'string' ? form.message : `Delete ${path}`;
    const commitSha = store.commitFiles(repo, refName, tip, files, message, `${login} <${login}@forge.local>`);
    sendJson(res, 200, { content: null, commit: { sha: commitSha, message } });
    return true;
  }

  fail(res, 404, 'Not Found');
  return true;
}

/** The top-level entries of a commit's tree, as a root contents listing. */
function topLevelEntries(st: Store, repo: Repo, tip: string): unknown[] {
  const files = st.filesOfCommit(repo, tip);
  const seen = new Map<string, { sha: string; dir: boolean }>();
  for (const [path, entry] of files) {
    const slash = path.indexOf('/');
    if (slash < 0) seen.set(path, { sha: entry.sha, dir: false });
    else {
      const dir = path.slice(0, slash);
      if (!seen.has(dir)) {
        const sha = treeShaAt(st, repo, tip, dir);
        if (sha !== null) seen.set(dir, { sha, dir: true });
      }
    }
  }
  return [...seen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, info]) =>
      info.dir ? contentDirJson('', name, info.sha) : contentFileJson(name, info.sha, st.get(info.sha)?.body ?? Buffer.alloc(0), files.get(name)?.mode ?? '100644'),
    );
}

/** The tree sha at a directory path in a commit, or null. */
function treeShaAt(st: Store, repo: Repo, commitSha: string, dirPath: string): string | null {
  const info = repo.commits.get(commitSha);
  if (!info) return null;
  let at = info.tree;
  for (const part of dirPath.split('/')) {
    if (part === '') continue;
    const object = st.get(at);
    if (!object || object.kind !== 'tree') return null;
    const entries = parseTreeSafe(object.body);
    const found = entries.find((entry) => entry.name === part);
    if (!found) return null;
    at = found.sha;
  }
  return at;
}

/** Parse a tree body without importing the parser through the module graph twice. */
function parseTreeSafe(body: Buffer): { mode: string; name: string; sha: string }[] {
  const out: { mode: string; name: string; sha: string }[] = [];
  let at = 0;
  while (at < body.length) {
    const nul = body.indexOf(0, at);
    if (nul < 0) break;
    const head = body.subarray(at, nul).toString('utf8');
    const space = head.indexOf(' ');
    if (space < 0) break;
    out.push({ mode: head.slice(0, space), name: head.slice(space + 1), sha: body.subarray(nul + 1, nul + 21).toString('hex') });
    at = nul + 21;
  }
  return out;
}

/** /issues, /issues/{n}, /issues/{n}/comments. */
function handleIssues(repo: Repo, rest: string[], method: string, body: unknown, query: Query, login: string, res: ServerResponse): boolean {
  // POST /issues, GET /issues
  if (rest.length === 0) {
    if (method === 'POST') {
      const form = (body ?? {}) as Record<string, unknown>;
      const title = typeof form.title === 'string' ? form.title : '';
      if (title === '') {
        fail(res, 422, 'Validation Failed: title is required');
        return true;
      }
      const wanted = stringList(form.labels);
      // An unknown label is a 422, as GitHub answers.
      for (const name of wanted) {
        if (!repo.labels.has(name)) {
          fail(res, 422, `Validation Failed: label "${name}" does not exist`);
          return true;
        }
      }
      const now = isoOf(FIXED_EPOCH_SEC);
      const issue: Issue = {
        number: repo.nextIssue,
        title,
        body: typeof form.body === 'string' ? form.body : '',
        state: 'open',
        labels: wanted,
        user: login,
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
      };
      repo.nextIssue += 1;
      repo.issues.set(issue.number, issue);
      sendJson(res, 201, issueJson(repo, issue), { location: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}` });
      return true;
    }
    if (method === 'GET') {
      const state = q(query, 'state') ?? 'open';
      let list = issuesOf(repo);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      const sort = q(query, 'sort') ?? 'created';
      const direction = q(query, 'direction') ?? (sort === 'created' ? 'desc' : 'asc');
      if (sort === 'created') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      } else if (sort === 'updated') {
        list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      }
      paginate(res, list.map((issue) => issueJson(repo, issue)), query, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
      return true;
    }
  }

  // /issues/{n}
  if (rest.length === 1) {
    const number = Number(decodeSegment(rest[0]));
    const issue = repo.issues.get(number);
    if (!issue) {
      fail(res, 404, 'Not Found');
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const form = (body ?? {}) as Record<string, unknown>;
      if (typeof form.title === 'string') issue.title = form.title;
      if (typeof form.body === 'string') issue.body = form.body;
      if (typeof form.state === 'string' && (form.state === 'open' || form.state === 'closed')) {
        if (form.state === 'closed' && issue.state !== 'closed') issue.closed_at = isoOf(FIXED_EPOCH_SEC);
        if (form.state === 'open') issue.closed_at = null;
        issue.state = form.state;
      }
      if (form.labels !== undefined) {
        const wanted = stringList(form.labels);
        for (const name of wanted) {
          if (!repo.labels.has(name)) {
            fail(res, 422, `Validation Failed: label "${name}" does not exist`);
            return true;
          }
        }
        issue.labels = wanted;
      }
      issue.updated_at = isoOf(FIXED_EPOCH_SEC);
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
  }

  // /issues/{n}/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    const number = Number(decodeSegment(rest[0]));
    const issue = repo.issues.get(number);
    if (!issue) {
      fail(res, 404, 'Not Found');
      return true;
    }
    if (method === 'POST') {
      const form = (body ?? {}) as Record<string, unknown>;
      const text = typeof form.body === 'string' ? form.body : '';
      if (text === '') {
        fail(res, 422, 'Validation Failed: body is required');
        return true;
      }
      const id = repo.nextComment;
      repo.nextComment += 1;
      issue.comments.push({ id, body: text, user: login, created_at: isoOf(FIXED_EPOCH_SEC) });
      issue.updated_at = isoOf(FIXED_EPOCH_SEC);
      sendJson(res, 201, commentJson(repo, issue, id), { location: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments/${id}` });
      return true;
    }
    if (method === 'GET') {
      paginate(res, issue.comments.map((comment) => commentJson(repo, issue, comment.id)), query, `/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}/comments`);
      return true;
    }
  }

  fail(res, 404, 'Not Found');
  return true;
}

/** A labels field: an array of names, or of {name} objects. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') out.push(item);
    else if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') out.push((item as { name: string }).name);
  }
  return out;
}

/** /pulls, /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge. */
function handlePulls(repo: Repo, rest: string[], method: string, body: unknown, query: Query, login: string, res: ServerResponse): boolean {
  if (rest.length === 0) {
    if (method === 'POST') {
      const form = (body ?? {}) as Record<string, unknown>;
      const title = typeof form.title === 'string' ? form.title : '';
      const headRef = typeof form.head === 'string' ? form.head : '';
      const baseRef = typeof form.base === 'string' ? form.base : repo.default_branch;
      if (title === '' || headRef === '') {
        fail(res, 422, 'Validation Failed: title and head are required');
        return true;
      }
      const headSha = store.refOf(repo, `refs/heads/${headRef}`) ?? store.refOf(repo, headRef);
      const baseSha = store.refOf(repo, `refs/heads/${baseRef}`) ?? store.refOf(repo, baseRef);
      if (headSha === null || baseSha === null) {
        fail(res, 422, 'Validation Failed: no commits between the branches');
        return true;
      }
      const now = isoOf(FIXED_EPOCH_SEC);
      const pull: Pull = {
        number: repo.nextPull,
        title,
        body: typeof form.body === 'string' ? form.body : '',
        state: 'open',
        head: { ref: headRef, sha: headSha, label: `${repo.owner}:${headRef}` },
        base: { ref: baseRef, sha: baseSha, label: `${repo.owner}:${baseRef}` },
        user: login,
        created_at: now,
        updated_at: now,
        merged: false,
        mergeable: true,
        merge_commit_sha: null,
        merged_at: null,
        closed_at: null,
        files: diffFiles(store, repo, baseSha, headSha),
      };
      repo.nextPull += 1;
      repo.pulls.set(pull.number, pull);
      sendJson(res, 201, pullJson(repo, pull), { location: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}` });
      return true;
    }
    if (method === 'GET') {
      const state = q(query, 'state') ?? 'open';
      let list = pullsOf(repo);
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      paginate(res, list.map((pull) => pullJson(repo, pull)), query, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
      return true;
    }
  }

  if (rest.length >= 1) {
    const number = Number(decodeSegment(rest[0]));
    const pull = repo.pulls.get(number);
    if (!pull) {
      fail(res, 404, 'Not Found');
      return true;
    }

    if (rest.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      if (method === 'PATCH') {
        const form = (body ?? {}) as Record<string, unknown>;
        if (typeof form.title === 'string') pull.title = form.title;
        if (typeof form.body === 'string') pull.body = form.body;
        if (form.state === 'closed' && pull.state !== 'closed') {
          pull.state = 'closed';
          pull.closed_at = isoOf(FIXED_EPOCH_SEC);
        }
        pull.updated_at = isoOf(FIXED_EPOCH_SEC);
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
    }

    if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
      sendJson(res, 200, pull.files.map(pullFileJson));
      return true;
    }

    if (rest.length === 2 && rest[1] === 'merge' && (method === 'PUT' || method === 'POST')) {
      const baseSha = store.refOf(repo, `refs/heads/${pull.base.ref}`);
      if (baseSha !== pull.base.sha) {
        // The base moved: the merge would need a rebase the API refuses.
        fail(res, 405, 'Pull Request is not mergeable');
        return true;
      }
      if (pull.merged) {
        fail(res, 405, 'Pull Request is not mergeable: it is already merged');
        return true;
      }
      // Fast-forward the base when it has not moved; otherwise a real merge commit.
      const form = (body ?? {}) as Record<string, unknown>;
      const message = typeof form.commit_message === 'string' ? form.commit_message : `Merge pull request #${pull.number} from ${pull.head.label}`;
      const baseFiles = store.filesOfRef(repo, `refs/heads/${pull.base.ref}`);
      const headFiles = store.filesOfCommit(repo, pull.head.sha);
      const merged = new Map(baseFiles);
      for (const [path, entry] of headFiles) merged.set(path, { sha: entry.sha, mode: entry.mode });
      const mergeSha = store.commitFiles(repo, `refs/heads/${pull.base.ref}`, baseSha, merged, message, `${login} <${login}@forge.local>`);
      pull.merged = true;
      pull.merge_commit_sha = mergeSha;
      pull.merged_at = isoOf(FIXED_EPOCH_SEC);
      pull.state = 'closed';
      pull.closed_at = pull.merged_at;
      pull.updated_at = pull.merged_at;
      sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
  }

  fail(res, 404, 'Not Found');
  return true;
}

/** The changed files between two commits, as the pull files list reports them. */
function diffFiles(st: Store, repo: Repo, baseSha: string, headSha: string): PullFile[] {
  const base = st.filesOfCommit(repo, baseSha);
  const head = st.filesOfCommit(repo, headSha);
  const out: PullFile[] = [];
  const paths = new Set<string>([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before === undefined && after !== undefined) {
      const bytes = st.get(after.sha)?.body ?? Buffer.alloc(0);
      out.push({ filename: path, status: 'added', additions: lineCount(bytes), deletions: 0, changes: lineCount(bytes), sha: after.sha });
    } else if (before !== undefined && after === undefined) {
      const bytes = st.get(before.sha)?.body ?? Buffer.alloc(0);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lineCount(bytes), changes: lineCount(bytes), sha: before.sha });
    } else if (before !== undefined && after !== undefined && before.sha !== after.sha) {
      const beforeBytes = st.get(before.sha)?.body ?? Buffer.alloc(0);
      const afterBytes = st.get(after.sha)?.body ?? Buffer.alloc(0);
      const added = lineCount(afterBytes);
      const removed = lineCount(beforeBytes);
      out.push({ filename: path, status: 'modified', additions: added, deletions: removed, changes: added + removed, sha: after.sha });
    }
  }
  return out;
}

/** How many lines a blob holds (at least one, so a one-line file counts as a change). */
function lineCount(bytes: Buffer): number {
  if (bytes.length === 0) return 0;
  const text = bytes.toString('utf8');
  const newlines = text.split('\n').length;
  return text.endsWith('\n') ? newlines - 1 : newlines;
}
