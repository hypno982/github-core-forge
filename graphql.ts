// graphql.ts: GitHub GraphQL v4, for the documents gh and github-mcp-server actually send.
//
// A full GraphQL engine is not needed: the suite sends a fixed family of documents (checks-graphql.ts
// names every one), so this module parses the query's shape — operation type, the root fields asked
// for, their arguments and the selection set — and answers those from the same store REST reads.
//
// Contract highlights (from checks-graphql.ts):
//   viewer { login }                              the token's user
//   repository(owner:, name:) { ... }             null for a repository that is not the token's
//   issue(number:, ...)                           null when absent
//   createIssue / closeIssue / addComment         mutations with input objects
//   pullRequests / pullRequest / createPullRequest / mergePullRequest
//   node(id:)                                     a global id resolves to its object
//   introspection (__schema, __type)              enough shape for a client to plan
//   errors: [{message, type, path}]               with a 200 status, as GitHub answers
//   batches: a JSON array of operations           answered with an array of results
//   null data + errors for a field that does not exist
//   unauthenticated: errors with type UNAUTHENTICATED

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_EPOCH_SEC, Store, isoOf, type Issue, type Pull, type Repo } from './store.ts';

/** One GraphQL error, GitHub's shape. */
interface GqlError {
  message: string;
  type: string;
  path?: (string | number)[];
}

/** A parsed field: its name, arguments and child selections. */
interface Field {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  children: Field[];
  /** The raw text of the arguments, for a mutation's `input: {...}` object. */
  rawArgs: string;
}

/** Parse a GraphQL document into its operations' root fields. */
function parseDocument(query: string): { operation: 'query' | 'mutation' | 'subscription'; fields: Field[] } {
  const text = stripComments(query);
  let operation: 'query' | 'mutation' | 'subscription' = 'query';
  let body = text.trim();
  const opMatch = /^(query|mutation|subscription)\b/.exec(body);
  if (opMatch) {
    operation = opMatch[1] as 'query' | 'mutation' | 'subscription';
    body = body.slice(opMatch[0].length).trim();
    // Skip an operation name and variable definitions.
    if (/^[A-Za-z_][A-Za-z0-9_]*/.test(body) && !body.startsWith('{')) {
      body = body.replace(/^[A-Za-z_][A-Za-z0-9_]*/, '').trim();
    }
    if (body.startsWith('(')) {
      let depth = 0;
      let at = 0;
      for (; at < body.length; at += 1) {
        if (body[at] === '(') depth += 1;
        else if (body[at] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      body = body.slice(at + 1).trim();
    }
  }
  const start = body.indexOf('{');
  if (start < 0) return { operation, fields: [] };
  const end = matchBrace(body, start);
  return { operation, fields: parseSelections(body.slice(start + 1, end)) };
}

/** Remove # comments outside strings. */
function stripComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== '\\') inString = !inString;
    if (!inString && ch === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** The index of the brace closing the one at `start`. */
function matchBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/** Parse a selection set body into fields (fragments and spreads are skipped). */
function parseSelections(text: string): Field[] {
  const fields: Field[] = [];
  let at = 0;
  while (at < text.length) {
    // Skip whitespace and commas.
    while (at < text.length && /[\s,]/.test(text[at])) at += 1;
    if (at >= text.length) break;

    // A fragment spread or inline fragment is not a field.
    if (text[at] === '.') {
      while (at < text.length && text[at] !== '\n' && text[at] !== '}') at += 1;
      continue;
    }
    if (text.startsWith('fragment', at)) {
      at = text.indexOf('}', at);
      if (at < 0) break;
      at += 1;
      continue;
    }

    // A name, optionally an alias before a colon.
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at));
    if (!nameMatch) {
      at += 1;
      continue;
    }
    let name = nameMatch[0];
    at += name.length;
    while (at < text.length && /\s/.test(text[at])) at += 1;
    let alias: string | null = null;
    if (text[at] === ':') {
      alias = name;
      at += 1;
      while (at < text.length && /\s/.test(text[at])) at += 1;
      const realMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at));
      if (realMatch) {
        name = realMatch[0];
        at += name.length;
      }
    }

    // Arguments, kept raw for input objects and parsed for scalar values.
    let rawArgs = '';
    while (at < text.length && /\s/.test(text[at])) at += 1;
    if (text[at] === '(') {
      const argStart = at;
      let depth = 0;
      for (; at < text.length; at += 1) {
        if (text[at] === '(') depth += 1;
        else if (text[at] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      rawArgs = text.slice(argStart + 1, at);
      at += 1;
    }

    // A child selection set, when the field has one.
    while (at < text.length && /\s/.test(text[at])) at += 1;
    let children: Field[] = [];
    if (text[at] === '{') {
      const end = matchBrace(text, at);
      children = parseSelections(text.slice(at + 1, end));
      at = end + 1;
    }

    fields.push({ name, alias, args: parseArgs(rawArgs), children, rawArgs });
  }
  return fields;
}

/** Parse an argument list into scalar values (a nested object stays as its raw text). */
function parseArgs(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let at = 0;
  while (at < raw.length) {
    while (at < raw.length && /[\s,]/.test(raw[at])) at += 1;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(at));
    if (!nameMatch) {
      at += 1;
      continue;
    }
    const key = nameMatch[0];
    at += key.length;
    while (at < raw.length && /[\s:]/.test(raw[at])) at += 1;
    if (raw[at] === '{') {
      const end = matchBrace(raw, at);
      out[key] = { __raw: raw.slice(at + 1, end) };
      at = end + 1;
      continue;
    }
    if (raw[at] === '[') {
      let depth = 0;
      const start = at;
      for (; at < raw.length; at += 1) {
        if (raw[at] === '[') depth += 1;
        else if (raw[at] === ']') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out[key] = parseScalarList(raw.slice(start + 1, at));
      at += 1;
      continue;
    }
    if (raw[at] === '"') {
      let end = at + 1;
      while (end < raw.length && (raw[end] !== '"' || raw[end - 1] === '\\')) end += 1;
      out[key] = JSON.parse(raw.slice(at, end + 1));
      at = end + 1;
      continue;
    }
    const scalar = /^[^,\s)]+/.exec(raw.slice(at));
    if (!scalar) break;
    out[key] = scalarValue(scalar[0]);
    at += scalar[0].length;
  }
  return out;
}

/** A list argument's items. */
function parseScalarList(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('"')) {
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        out.push(trimmed.replace(/^"|"$/g, ''));
      }
    } else if (trimmed.startsWith('{')) out.push({ __raw: trimmed.slice(1, -1) });
    else out.push(scalarValue(trimmed));
  }
  return out;
}

/** A GraphQL scalar literal. */
function scalarValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  const num = Number(raw);
  if (Number.isFinite(num) && /^-?\d+(\.\d+)?$/.test(raw)) return num;
  return raw;
}

/** The global id of an object: the base64 GitHub uses, derived from the kind and key. */
function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

/** A repository's numeric id (`databaseId`), the same derivation the REST payload uses. */
function repoNumericId(repo: Repo): number {
  const digest = createHash('sha256').update(`repo:${repo.owner}/${repo.name}`).digest();
  return (digest.readUInt32BE(0) % 1_000_000) + 1;
}

/** Decode a global id back to its kind and key. */
function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at < 0) return null;
    return { kind: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

/** The request context graphql needs. */
export interface GraphqlRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  login: string | null;
  store: Store;
  body: unknown;
}

/** Answer one GraphQL operation (or a batch of them). */
export async function handleGraphql(input: GraphqlRequest): Promise<void> {
  const { res, method, login, store, body } = input;
  if (method !== 'POST') {
    // GitHub answers a non-POST on /graphql with a 405 and a JSON message.
    sendGql(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  if (login === null) {
    sendGql(res, 200, { data: null, errors: [{ message: 'Requires authentication', type: 'UNAUTHENTICATED' }] });
    return;
  }

  // A batch is a JSON array of {query, variables}; each is answered in order.
  if (Array.isArray(body)) {
    const results = body.map((item) => runOne(store, login, item));
    sendGql(res, 200, results);
    return;
  }
  sendGql(res, 200, runOne(store, login, body));
}

/** Answer with GraphQL's JSON content type. */
function sendGql(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': createHash('sha256').update(text).digest('hex').slice(0, 16),
  });
  res.end(text);
}

/** Run one operation and return its {data, errors} envelope. */
function runOne(store: Store, login: string, raw: unknown): Record<string, unknown> {
  const payload = (raw ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof payload.query !== 'string' || payload.query.trim() === '') {
    return { data: null, errors: [{ message: 'Problems parsing JSON: a query is required', type: 'BAD_REQUEST' }] };
  }
  const variables = (payload.variables ?? {}) as Record<string, unknown>;
  const parsed = parseDocument(payload.query);
  const operation = parsed.operation;
  // A `$name` argument is a reference: bind every one to the request's variables before any field is
  // answered, so `repository(owner: $owner, name: $name)` and `input: $input` resolve like literals.
  const fields = bindVariables(parsed.fields, variables);
  if (fields.length === 0) {
    return { data: null, errors: [{ message: 'Problems parsing JSON: the query names no field', type: 'BAD_REQUEST' }] };
  }

  const errors: GqlError[] = [];
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    try {
      const value = resolveField(store, login, field, variables, errors, operation);
      if (value !== SKIP) data[key] = value;
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err), type: 'INTERNAL', path: [key] });
      data[key] = null;
    }
  }
  const envelope: Record<string, unknown> = { data: errors.length > 0 && Object.keys(data).length === 0 ? null : data };
  if (errors.length > 0) envelope.errors = errors;
  return envelope;
}

/** A sentinel for a field that answers nothing at all (an introspection-only name). */
const SKIP = Symbol('skip');

/**
 * Bind every `$name` argument reference in a parsed selection tree to the request's variables.
 *
 * The parser keeps `$owner` as the raw text `$owner`, and a `{__raw}` marker for an inline input
 * object. Both are replaced here: a scalar becomes its variable's value, and an `input:` that names a
 * variable is re-rendered as an inline object so parseInputObject reads it the same way as a literal.
 */
function bindVariables(fields: Field[], variables: Record<string, unknown>): Field[] {
  const bind = (value: unknown): unknown => {
    if (typeof value === 'string' && value.startsWith('$')) {
      return variables[value.slice(1)];
    }
    if (Array.isArray(value)) {
      return value.map((item) => (typeof item === 'string' && item.startsWith('$') ? variables[item.slice(1)] : item));
    }
    return value;
  };
  return fields.map((field) => {
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(field.args)) args[name] = bind(value);
    let rawArgs = field.rawArgs;
    // `input: $input` — the raw args hold the reference, so it is re-rendered from the bound object.
    const inputVar = /\binput\s*:\s*\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rawArgs);
    if (inputVar) {
      const bound = variables[inputVar[1]];
      if (bound !== undefined) {
        const rendered = renderInputValue(bound);
        args.input = bound;
        rawArgs = rawArgs.replace(inputVar[0], `input: ${rendered}`);
      }
    }
    return { name: field.name, alias: field.alias, args, children: bindVariables(field.children, variables), rawArgs };
  });
}

/** Render a JS value as GraphQL input syntax, so an input object reads the same inline as from a variable. */
function renderInputValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(renderInputValue).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${renderInputValue(item)}`);
    return `{${entries.join(', ')}}`;
  }
  return 'null';
}


/** Resolve one root field. */
function resolveField(
  store: Store,
  login: string,
  field: Field,
  variables: Record<string, unknown>,
  errors: GqlError[],
  operation: string,
): unknown {
  const arg = (name: string): unknown => {
    const direct = field.args[name];
    if (direct !== undefined) return direct;
    // A variable reference is passed from the request's variables map.
    return variables[name];
  };

  switch (field.name) {
    case 'viewer': {
      // A field the User type does not have is a null plus an error, never a silent null.
      const user = { login, id: globalId('User', login), name: login, email: `${login}@forge.local`, avatarUrl: `http://forge.local/${login}.png`, resourcePath: `/${login}`, url: `http://forge.local/${login}` };
      const known = new Set(Object.keys(user));
      for (const child of field.children) {
        if (child.name === '__typename') continue;
        if (known.has(child.name)) continue;
        errors.push({
          message: `Field '${child.name}' doesn't exist on type 'User'`,
          type: 'INVALID_FIELD',
          path: [field.alias ?? field.name, child.name],
        });
      }
      const projected = project(user, field.children) ?? {};
      for (const child of field.children) {
        if (!known.has(child.name) && child.name !== '__typename') projected[child.alias ?? child.name] = null;
      }
      return projected;
    }
    case 'repository':
      return resolveRepository(store, login, field, arg, variables, errors);
    case 'node':
      return resolveNode(store, login, field, arg);
    case '__typename':
      return operation === 'mutation' ? 'Mutation' : 'Query';
    case '__schema':
    case '__type':
      return resolveIntrospection(field);
    case 'rateLimit':
      return { limit: 5000, remaining: 4999, resetAt: isoOf(FIXED_EPOCH_SEC), used: 1 };
    default:
      break;
  }

  // Mutations: create/close/comment/merge.
  if (operation === 'mutation') return resolveMutation(store, login, field, errors);

  // A field that does not exist is a null plus an error, never a crash.
  errors.push({ message: `Field '${field.name}' doesn't exist on type 'Query'`, type: 'INVALID_FIELD', path: [field.name] });
  return null;
}

/** Resolve repository(owner:, name:). */
function resolveRepository(store: Store, login: string, field: Field, arg: (name: string) => unknown, variables: Record<string, unknown>, errors: GqlError[]): unknown {
  const owner = String(arg('owner') ?? '');
  const name = String(arg('name') ?? '');
  void variables;
  const repo = store.repo(owner, name);
  if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
  return projectRepo(store, repo, field.children, errors);
}

/** Project a repository object against a selection set. */
function projectRepo(store: Store, repo: Repo, children: Field[], errorSink: GqlError[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const id = globalId('Repository', `${repo.owner}/${repo.name}`);
  const full = {
    id,
    databaseId: repoNumericId(repo),
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    url: `http://forge.local/${repo.owner}/${repo.name}`,
    defaultBranchRef: { name: repo.default_branch, target: { oid: store.refOf(repo, `refs/heads/${repo.default_branch}`) ?? '' } },
    owner: { login: repo.owner, id: globalId('User', repo.owner), avatarUrl: `http://forge.local/${repo.owner}.png`, resourcePath: `/${repo.owner}` },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasWikiEnabled: true,
    isFork: false,
    isEmpty: false,
    stargazerCount: 0,
    forkCount: 0,
    visibility: repo.private ? 'PRIVATE' : 'PUBLIC',
    diskUsage: 0,
  } as Record<string, unknown>;

  for (const child of children) {
    switch (child.name) {
      case 'issues': {
        // GitHub's own filters: `states:` narrows to OPEN/CLOSED, `orderBy:` picks the sort.
        const states = Array.isArray(child.args.states)
          ? (child.args.states as unknown[]).map((s) => String(s).toUpperCase())
          : typeof child.args.states === 'string'
            ? [String(child.args.states).toUpperCase()]
            : [];
        const orderRaw = child.args.orderBy as { __raw?: string } | undefined;
        const orderText = typeof orderRaw?.__raw === 'string' ? orderRaw.__raw : '';
        const ascending = /direction\s*:\s*ASC/i.test(orderText);
        let items = [...repo.issues.values()];
        if (states.length > 0) {
          items = items.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        items.sort((a, b) => {
          if (/field\s*:\s*(CREATED_AT|UPDATED_AT)/i.test(orderText)) {
            const av = /CREATED/i.test(orderText) ? a.created_at : a.updated_at;
            const bv = /CREATED/i.test(orderText) ? b.created_at : b.updated_at;
            if (av !== bv) return av < bv ? (ascending ? -1 : 1) : ascending ? 1 : -1;
          }
          return ascending ? a.number - b.number : b.number - a.number;
        });
        out[child.alias ?? 'issues'] = projectConnection(
          items,
          child,
          (issue) => projectIssue(store, repo, issue, child.children.find((c) => c.name === 'nodes')?.children ?? child.children),
        );
        break;
      }
      case 'pullRequests':
        out[child.alias ?? 'pullRequests'] = projectConnection(
          [...repo.pulls.values()].sort((a, b) => b.number - a.number),
          child,
          (pull) => projectPull(store, repo, pull, child.children.find((c) => c.name === 'nodes')?.children ?? child.children),
        );
        break;
      case 'pullRequest': {
        const number = Number(child.args.number ?? 0);
        const pull = repo.pulls.get(number);
        out[child.alias ?? 'pullRequest'] = pull ? projectPull(store, repo, pull, child.children) : null;
        break;
      }
      case 'issue': {
        const number = Number(child.args.number ?? 0);
        const issue = repo.issues.get(number);
        out[child.alias ?? 'issue'] = issue ? projectIssue(store, repo, issue, child.children) : null;
        break;
      }
      case 'ref': {
        const refName = String(child.args.qualifiedName ?? '');
        const sha = store.refOf(repo, refName);
        out[child.alias ?? 'ref'] = sha === null ? null : project({ name: refName.replace(/^refs\//, ''), target: { oid: sha } }, child.children);
        break;
      }
      case 'object': {
        const oid = String(child.args.oid ?? child.args.expression ?? '');
        const sha = store.commitOf(repo, oid);
        out[child.alias ?? 'object'] = sha === null ? null : project({ oid: sha, abbreviatedOid: sha.slice(0, 7) }, child.children);
        break;
      }
      case 'labels':
        out[child.alias ?? 'labels'] = projectConnection(
          [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
          child,
          (label) => project({ id: globalId('Label', label.name), name: label.name, color: label.color, description: label.description }, child.children.find((c) => c.name === 'nodes')?.children ?? child.children),
        );
        break;
      case '__typename':
        out[child.alias ?? '__typename'] = 'Repository';
        break;
      default: {
        // A field the Repository type does not have is a null plus an error, never a silent null.
        const key2 = child.alias ?? child.name;
        if (!(child.name in full)) {
          errorSink.push({ message: `Field '${child.name}' doesn't exist on type 'Repository'`, type: 'INVALID_FIELD', path: ['repository', child.name] });
          out[key2] = null;
        } else out[key2] = project(full, [child])[key2] ?? null;
        break;
      }
    }
  }
  return out;
}

/** A Relay connection: nodes, totalCount and pageInfo. */
function projectConnection<T>(items: T[], field: Field, project: (item: T) => unknown): Record<string, unknown> {
  const first = Number(field.args.first ?? items.length);
  const after = field.args.after;
  const last = Number(field.args.last ?? 0);
  // `after` is an opaque cursor naming the index of the last item already handed out, so the page
  // starts at the next one. A null `after` (an explicit null, or the variable it bound) is the head.
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const at = Number(Buffer.from(after, 'base64').toString('utf8').replace('cursor:', ''));
    if (Number.isFinite(at)) start = at + 1;
  }
  const remaining = items.slice(start);
  let slice = remaining;
  if (last > 0) slice = remaining.slice(-last);
  else if (Number.isFinite(first) && first > 0) slice = remaining.slice(0, first);
  return projectConnectionPage(items, remaining, slice, start, project, field);
}

/** Build a page's payload: nodes, totalCount and a pageInfo measured from the page's own start. */
function projectConnectionPage<T>(
  items: T[],
  remaining: T[],
  slice: T[],
  start: number,
  project: (item: T) => unknown,
  field: Field,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const endIndex = start + slice.length;
  for (const child of field.children) {
    if (child.name === 'nodes') out[child.alias ?? 'nodes'] = slice.map(project);
    else if (child.name === 'totalCount') out.totalCount = items.length;
    else if (child.name === 'pageInfo') {
      out.pageInfo = {
        hasNextPage: endIndex < items.length,
        hasPreviousPage: start > 0,
        startCursor: slice.length > 0 ? Buffer.from(`cursor:${start}`, 'utf8').toString('base64') : null,
        endCursor: slice.length > 0 ? Buffer.from(`cursor:${endIndex - 1}`, 'utf8').toString('base64') : null,
      };
    } else if (child.name === 'edges') {
      // An edge names its own cursor, which is the index of its node.
      out.edges = slice.map((item, index) => ({
        cursor: Buffer.from(`cursor:${start + index}`, 'utf8').toString('base64'),
        node: project(item),
      }));
    } else if (child.name === '__typename') out.__typename = 'IssueConnection';
  }
  void remaining;
  return { ...out, totalCount: items.length };
}

/** Project an issue. */
function projectIssue(store: Store, repo: Repo, issue: Issue, children: Field[]): Record<string, unknown> {
  const full: Record<string, unknown> = {
    id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    author: { login: issue.user },
    url: `http://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository: { name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` },
  };
  const out: Record<string, unknown> = {};
  for (const child of children) {
    if (child.name === 'labels') {
      out[child.alias ?? 'labels'] = projectConnection(
        issue.labels.map((name) => repo.labels.get(name) ?? { name, color: 'ededed', description: '' }),
        child,
        (label) => project({ id: globalId('Label', label.name), name: label.name, color: label.color, description: label.description }, child.children.find((c) => c.name === 'nodes')?.children ?? child.children),
      );
    } else if (child.name === 'comments') {
      out[child.alias ?? 'comments'] = projectConnection(
        issue.comments,
        child,
        (comment) => project({ id: globalId('Comment', String(comment.id)), body: comment.body, author: { login: comment.user }, createdAt: comment.created_at }, child.children.find((c) => c.name === 'nodes')?.children ?? child.children),
      );
    } else if (child.name === 'state' && issue.state === 'closed') {
      // GitHub lists a closed issue as CLOSED, and closeIssue's payload reports its reason.
      out[child.alias ?? 'state'] = 'CLOSED';
      out.stateReason = 'COMPLETED';
    } else if (child.name === 'number' || child.name === 'title' || child.name === 'body') out[child.alias ?? child.name] = full[child.name] ?? null;
    else if (child.name === 'id') out[child.alias ?? 'id'] = full.id;
    else if (child.name === '__typename') out.__typename = 'Issue';
    else out[child.alias ?? child.name] = project(full, [child])[child.alias ?? child.name] ?? null;
  }
  void store;
  return out;
}

/** Project a pull request. */
function projectPull(store: Store, repo: Repo, pull: Pull, children: Field[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of children) {
    switch (child.name) {
      case 'files':
        out[child.alias ?? 'files'] = projectConnection(
          pull.files,
          child,
          (file) => project({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status.toUpperCase() }, child.children.find((c) => c.name === 'nodes')?.children ?? child.children),
        );
        break;
      case '__typename':
        out.__typename = 'PullRequest';
        break;
      default:
        out[child.alias ?? child.name] = pullValue(store, repo, pull, child);
        break;
    }
  }
  return out;
}

/** One field of a pull request. */
function pullValue(store: Store, repo: Repo, pull: Pull, field: Field): unknown {
  void store;
  switch (field.name) {
    case 'id':
      return globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'merged':
      return pull.merged;
    case 'mergeable':
      return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
    case 'createdAt':
      return pull.created_at;
    case 'updatedAt':
      return pull.updated_at;
    case 'mergedAt':
      return pull.merged_at;
    case 'closedAt':
      return pull.closed_at;
    case 'url':
      return `http://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`;
    case 'headRefName':
      return pull.head.ref;
    case 'baseRefName':
      return pull.base.ref;
    case 'headRefOid':
      return pull.head.sha;
    case 'baseRefOid':
      return pull.base.sha;
    case 'author':
      return { login: pull.user };
    default:
      if (field.children.length > 0) return project({ oid: pull.head.sha, name: pull.head.ref }, field.children);
      return null;
  }
}

/** Project an object against a selection set: a plain field lookup, recursively. */
function project(source: Record<string, unknown>, children: Field[]): Record<string, unknown> | null {
  if (children.length === 0) return source;
  const out: Record<string, unknown> = {};
  for (const child of children) {
    const key = child.alias ?? child.name;
    if (child.name === '__typename') {
      out[key] = (source.__typename as string) ?? 'Object';
      continue;
    }
    const value = source[child.name];
    if (child.children.length > 0 && value !== null && value !== undefined) {
      if (Array.isArray(value)) out[key] = value.map((item) => (item && typeof item === 'object' ? project(item as Record<string, unknown>, child.children) : item));
      else if (typeof value === 'object') out[key] = project(value as Record<string, unknown>, child.children);
      else out[key] = value;
    } else out[key] = value === undefined ? null : value;
  }
  return out;
}

/** node(id:): a global id resolves back to its object. */
function resolveNode(store: Store, login: string, field: Field, arg: (name: string) => unknown): unknown {
  const id = String(arg('id') ?? '');
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const [owner, name] = decoded.key.split('/');
  const repo = store.repo(owner, name);
  if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) return null;

  if (decoded.kind === 'Repository') return projectRepo(store, repo, field.children);
  if (decoded.kind === 'Issue') {
    const number = Number(decoded.key.split('#')[1]);
    const issue = repo.issues.get(number);
    return issue ? projectIssue(store, repo, issue, field.children) : null;
  }
  if (decoded.kind === 'PullRequest') {
    const number = Number(decoded.key.split('#')[1]);
    const pull = repo.pulls.get(number);
    return pull ? projectPull(store, repo, pull, field.children) : null;
  }
  return null;
}

/** The fields each type holds, as __type(name:).fields reports them (gh feature-detects against these). */
const SCHEMA_FIELDS: Record<string, string[]> = {
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'hasWikiEnabled', 'isPrivate', 'isFork', 'isEmpty',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'ref', 'object', 'label', 'labels',
    'createdAt', 'updatedAt', 'url', 'visibility', 'stargazerCount', 'forkCount', 'diskUsage',
  ],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'stateReason', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'url', 'repository', 'labels', 'comments', 'closed',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'mergedAt', 'createdAt',
    'updatedAt', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'author', 'files',
    'commits', 'url',
  ],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'resourcePath', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo', 'edges'],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo', 'edges'],
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  String: [],
  Int: [],
  Boolean: [],
  ID: [],
};

/** The enum values gh's SearchType probe reads. */
const SCHEMA_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'CODE'],
};

/** __type(name:) answers the type's fields (or enumValues); __schema lists every type. */
function resolveIntrospection(field: Field): unknown {
  if (field.name === '__schema') {
    return {
      queryType: { name: 'Query' },
      mutationType: { name: 'Mutation' },
      types: Object.keys(SCHEMA_FIELDS).map((name) => ({ name, kind: 'OBJECT' })),
    };
  }
  const wanted = String(field.args.name ?? '');
  const fieldNames = SCHEMA_FIELDS[wanted];
  const enumNames = SCHEMA_ENUM_VALUES[wanted];
  if (fieldNames === undefined && enumNames === undefined) return null;
  const out: Record<string, unknown> = { name: wanted, kind: enumNames ? 'ENUM' : 'OBJECT' };
  for (const child of field.children) {
    const key = child.alias ?? child.name;
    if (child.name === 'fields') {
      out[key] = (fieldNames ?? []).map((name) => ({
        name,
        type: { name: name === 'id' ? 'ID' : 'String', kind: 'SCALAR' },
        args: [],
        isDeprecated: false,
        deprecationReason: null,
      }));
    } else if (child.name === 'enumValues') {
      out[key] = (enumNames ?? []).map((name) => ({ name, isDeprecated: false, deprecationReason: null }));
    } else if (child.name === 'kind') {
      out.kind = enumNames ? 'ENUM' : 'OBJECT';
    } else if (child.name === 'name') {
      out.name = wanted;
    } else if (child.name === '__typename') {
      out[key] = '__Type';
    }
  }
  return out;
}

/** Resolve the repository a mutation input names: `repositoryId` (a global id) or owner/repo. */
function resolveRepoInput(store: Store, login: string, input: Record<string, unknown>): Repo | null {
  if (typeof input.repositoryId === 'string') {
    const decoded = decodeGlobalId(input.repositoryId);
    if (decoded && decoded.kind === 'Repository') {
      const [owner, name] = decoded.key.split('/');
      const repo = store.repo(owner ?? '', name ?? '');
      return repo && repo.owner.toLowerCase() === login.toLowerCase() ? repo : null;
    }
    return null;
  }
  const repo = store.repo(String(input.owner ?? ''), String(input.repo ?? input.repositoryName ?? ''));
  return repo && repo.owner.toLowerCase() === login.toLowerCase() ? repo : null;
}

/** Mutations: createIssue, closeIssue, addComment, createPullRequest, mergePullRequest. */
function resolveMutation(store: Store, login: string, field: Field, errors: GqlError[]): unknown {
  const input = parseInputObject(field.rawArgs);
  switch (field.name) {
    case 'createIssue': {
      const repo = resolveRepoInput(store, login, input);
      if (!repo) {
        errors.push({ message: 'Could not resolve to a Repository', type: 'NOT_FOUND', path: ['createIssue'] });
        return null;
      }
      const now = isoOf(FIXED_EPOCH_SEC);
      const issue: Issue = {
        number: repo.nextIssue,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        user: login,
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
      };
      repo.nextIssue += 1;
      repo.issues.set(issue.number, issue);
      return { issue: projectIssue(store, repo, issue, findChildren(field, 'issue')), clientMutationId: input.clientMutationId ?? null };
    }
    case 'closeIssue': {
      const resolved = resolveIssueInput(store, login, input);
      if (!resolved) {
        errors.push({ message: 'Could not resolve to an Issue', type: 'NOT_FOUND', path: ['closeIssue'] });
        return null;
      }
      resolved.issue.state = 'closed';
      resolved.issue.closed_at = isoOf(FIXED_EPOCH_SEC);
      resolved.issue.updated_at = isoOf(FIXED_EPOCH_SEC);
      return { issue: projectIssue(store, resolved.repo, resolved.issue, findChildren(field, 'issue')), clientMutationId: input.clientMutationId ?? null };
    }
    case 'reopenIssue': {
      const resolved = resolveIssueInput(store, login, input);
      if (!resolved) {
        errors.push({ message: 'Could not resolve to an Issue', type: 'NOT_FOUND', path: ['reopenIssue'] });
        return null;
      }
      resolved.issue.state = 'open';
      resolved.issue.closed_at = null;
      return { issue: projectIssue(store, resolved.repo, resolved.issue, findChildren(field, 'issue')), clientMutationId: input.clientMutationId ?? null };
    }
    case 'addComment': {
      const resolved = resolveIssueInput(store, login, input);
      if (!resolved) {
        errors.push({ message: 'Could not resolve to an Issue', type: 'NOT_FOUND', path: ['addComment'] });
        return null;
      }
      const id = resolved.repo.nextComment;
      resolved.repo.nextComment += 1;
      resolved.issue.comments.push({ id, body: String(input.body ?? ''), user: login, created_at: isoOf(FIXED_EPOCH_SEC) });
      return {
        commentEdge: { node: { id: globalId('Comment', String(id)), body: String(input.body ?? ''), author: { login }, createdAt: isoOf(FIXED_EPOCH_SEC) } },
        clientMutationId: input.clientMutationId ?? null,
      };
    }
    case 'createPullRequest': {
      const repo = resolveRepoInput(store, login, input);
      if (!repo) {
        errors.push({ message: 'Could not resolve to a Repository', type: 'NOT_FOUND', path: ['createPullRequest'] });
        return null;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? repo.default_branch);
      const headSha = store.refOf(repo, `refs/heads/${headRef}`);
      const baseSha = store.refOf(repo, `refs/heads/${baseRef}`);
      if (headSha === null || baseSha === null) {
        errors.push({ message: 'No commits between the branches', type: 'UNPROCESSABLE', path: ['createPullRequest'] });
        return null;
      }
      const now = isoOf(FIXED_EPOCH_SEC);
      const pull: Pull = {
        number: repo.nextPull,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
        files: [],
      };
      repo.nextPull += 1;
      repo.pulls.set(pull.number, pull);
      return { pullRequest: projectPull(store, repo, pull, findChildren(field, 'pullRequest')), clientMutationId: input.clientMutationId ?? null };
    }
    case 'mergePullRequest': {
      const resolved = resolvePullInput(store, login, input);
      if (!resolved) {
        errors.push({ message: 'Could not resolve to a PullRequest', type: 'NOT_FOUND', path: ['mergePullRequest'] });
        return null;
      }
      resolved.pull.merged = true;
      resolved.pull.state = 'closed';
      resolved.pull.merged_at = isoOf(FIXED_EPOCH_SEC);
      resolved.pull.closed_at = resolved.pull.merged_at;
      return { pullRequest: projectPull(store, resolved.repo, resolved.pull, findChildren(field, 'pullRequest')), clientMutationId: input.clientMutationId ?? null };
    }
    case '__typename':
      return 'Mutation';
    default:
      errors.push({ message: `Field '${field.name}' doesn't exist on type 'Mutation'`, type: 'INVALID_FIELD', path: [field.name] });
      return null;
  }
}

/** The children of the payload field named `name` (null when the selection omits it). */
function findChildren(field: Field, name: string): Field[] {
  const found = field.children.find((child) => child.name === name);
  return found ? found.children : [];
}

/** Parse a mutation's input object from the raw argument text. */
function parseInputObject(rawArgs: string): Record<string, unknown> {
  const at = rawArgs.indexOf('input');
  if (at < 0) return {};
  let cursor = rawArgs.indexOf('{', at);
  if (cursor < 0) return {};
  let depth = 0;
  const start = cursor;
  for (; cursor < rawArgs.length; cursor += 1) {
    if (rawArgs[cursor] === '{') depth += 1;
    else if (rawArgs[cursor] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return flattenInput(rawArgs.slice(start + 1, cursor));
}

/** Flatten a GraphQL input object into a plain JS object (nested objects keep their keys). */
function flattenInput(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let at = 0;
  while (at < text.length) {
    while (at < text.length && /[\s,]/.test(text[at])) at += 1;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at));
    if (!nameMatch) break;
    const key = nameMatch[0];
    at += key.length;
    while (at < text.length && /[\s:]/.test(text[at])) at += 1;
    if (text[at] === '{') {
      let depth = 0;
      const start = at;
      for (; at < text.length; at += 1) {
        if (text[at] === '{') depth += 1;
        else if (text[at] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      out[key] = flattenInput(text.slice(start + 1, at));
      at += 1;
      continue;
    }
    if (text[at] === '"') {
      let end = at + 1;
      while (end < text.length && (text[end] !== '"' || text[end - 1] === '\\')) end += 1;
      try {
        out[key] = JSON.parse(text.slice(at, end + 1));
      } catch {
        out[key] = text.slice(at + 1, end);
      }
      at = end + 1;
      continue;
    }
    const scalar = /^[^,\s}]+/.exec(text.slice(at));
    if (!scalar) break;
    out[key] = scalarValue(scalar[0]);
    at += scalar[0].length;
  }
  return out;
}

/** Resolve an issue from a mutation input: {issueId} or {subjectId} (a global id), or {issueNumber, owner, repo}. */
function resolveIssueInput(store: Store, login: string, input: Record<string, unknown>): { repo: Repo; issue: Issue } | null {
  // AddComment names the issue in `subjectId`; the issue mutations name it in `issueId`.
  const rawId = input.issueId ?? input.subjectId;
  if (typeof rawId === 'string') {
    const decoded = decodeGlobalId(rawId);
    if (!decoded || decoded.kind !== 'Issue') return null;
    // The key is `<owner>/<repo>#<number>`: the number comes after the `#`, the repo before it.
    const hash = decoded.key.lastIndexOf('#');
    const path = hash < 0 ? decoded.key : decoded.key.slice(0, hash);
    const number = hash < 0 ? 0 : Number(decoded.key.slice(hash + 1));
    const slash = path.indexOf('/');
    if (slash < 0) return null;
    const repo = store.repo(path.slice(0, slash), path.slice(slash + 1));
    if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
    const issue = repo.issues.get(number);
    return issue ? { repo, issue } : null;
  }
  const repo = store.repo(String(input.owner ?? ''), String(input.repo ?? ''));
  if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
  const issue = repo.issues.get(Number(input.issueNumber ?? input.number ?? 0));
  return issue ? { repo, issue } : null;
}

/** Resolve a pull request from a mutation input. */
function resolvePullInput(store: Store, login: string, input: Record<string, unknown>): { repo: Repo; pull: Pull } | null {
  if (typeof input.pullRequestId === 'string') {
    const decoded = decodeGlobalId(input.pullRequestId);
    if (!decoded || decoded.kind !== 'PullRequest') return null;
    const hash = decoded.key.lastIndexOf('#');
    const path = hash < 0 ? decoded.key : decoded.key.slice(0, hash);
    const number = hash < 0 ? 0 : Number(decoded.key.slice(hash + 1));
    const slash = path.indexOf('/');
    if (slash < 0) return null;
    const repo = store.repo(path.slice(0, slash), path.slice(slash + 1));
    if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
    const pull = repo.pulls.get(number);
    return pull ? { repo, pull } : null;
  }
  const repo = store.repo(String(input.owner ?? ''), String(input.repo ?? ''));
  if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) return null;
  const pull = repo.pulls.get(Number(input.pullRequestNumber ?? input.number ?? 0));
  return pull ? { repo, pull } : null;
}
