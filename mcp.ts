// mcp.ts: Model Context Protocol over streamable HTTP, at POST /mcp.
//
// The suite drives initialize, tools/list and tools/call, then checks that each tool's effect shows
// up in the REST view (checks-mcp.ts names every check). The tools are the eight
// github-mcp-server exposes for issues and pull requests; their arguments and results follow MCP's
// JSON-RPC shape exactly.
//
// Transport: streamable HTTP, JSON responses (no SSE unless the client asks for it). Every request
// is one JSON-RPC message; a batch is an array. Notifications get a 202 with no body.

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_EPOCH_SEC, Store, isoOf, type Issue, type Pull, type Repo } from './store.ts';

/** The MCP protocol revision this server speaks. */
const PROTOCOL_VERSION = '2025-06-18';

/** The tool names and their input schemas, as github-mcp-server defines them. */
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A JSON-RPC request. */
interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** The request context mcp needs. */
export interface McpRequest {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  login: string | null;
  store: Store;
  body: Buffer;
}

/** Write a JSON-RPC result. */
function rpcResult(res: ServerResponse, id: string | number | null | undefined, result: unknown): void {
  writeJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

/** Write a JSON-RPC error. */
function rpcError(res: ServerResponse, id: string | number | null | undefined, code: number, message: string): void {
  writeJson(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/** A tool result carrying one JSON object as text content, which is what the client parses. */
function toolResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** A tool result reporting a failure the model should see (in-band, not a protocol error). */
function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** The JSON headers every reply carries. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'mcp-protocol-version': PROTOCOL_VERSION,
  });
  res.end(text);
}

/** The tools this server exposes. */
function tools(login: string): ToolDef[] {
  const repoProps = {
    owner: { type: 'string', description: 'Repository owner (user or organisation).' },
    repo: { type: 'string', description: 'Repository name.' },
  };
  return [
    {
      name: 'create_repo',
      description: 'Create a repository in the authenticated user\'s account.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The repository name.' },
          description: { type: 'string', description: 'A short description.' },
          private: { type: 'boolean', description: 'Whether the repository is private.' },
          autoInit: { type: 'boolean', description: 'Create an initial commit with a README.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'get_repo',
      description: 'Get one repository by owner and name.',
      inputSchema: {
        type: 'object',
        properties: { ...repoProps },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'get_me',
      description: `Get details of the authenticated GitHub user. Use this when a request is about the page itself, such as "what is my username?". The output will be a JSON object with the user's details, e.g. {"login":"${login}","id":1}.`,
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'list_issues',
      description: 'List issues in a GitHub repository, with optional filters by state, labels and order.',
      inputSchema: {
        type: 'object',
        properties: {
          ...repoProps,
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state. Default: open.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Filter by label names.' },
          orderBy: { type: 'string', description: 'Order: "created" or "updated", then "asc" or "desc".' },
          page: { type: 'number', description: 'Page number, starting at 1.' },
          perPage: { type: 'number', description: 'Results per page, at most 100.' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'issue_read',
      description: 'Read one issue, its comments, or its labels.',
      inputSchema: {
        type: 'object',
        properties: {
          ...repoProps,
          issue_number: { type: 'number', description: 'The issue number.' },
          method: { type: 'string', enum: ['get', 'get_comments', 'get_labels'], description: 'What to read. Default: get.' },
        },
        required: ['owner', 'repo', 'issue_number'],
      },
    },
    {
      name: 'create_issue',
      description: 'Create a new issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          ...repoProps,
          title: { type: 'string', description: 'The issue title.' },
          body: { type: 'string', description: 'The issue body.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to attach.' },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
    {
      name: 'issue_write',
      description: 'Create a new issue, or update an existing one (title, body, state, labels).',
      inputSchema: {
        type: 'object',
        properties: {
          ...repoProps,
          method: { type: 'string', enum: ['create', 'update'], description: 'Create or update. Default: create.' },
          issue_number: { type: 'number', description: 'The issue to update.' },
          title: { type: 'string', description: 'The issue title.' },
          body: { type: 'string', description: 'The issue body.' },
          state: { type: 'string', enum: ['open', 'closed'], description: 'The new state.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Labels to set.' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'add_issue_comment',
      description: 'Add a comment to an existing issue.',
      inputSchema: {
        type: 'object',
        properties: {
          ...repoProps,
          issue_number: { type: 'number', description: 'The issue number.' },
          body: { type: 'string', description: 'The comment text.' },
        },
        required: ['owner', 'repo', 'issue_number', 'body'],
      },
    },
    {
      name: 'list_pull_requests',
      description: 'List pull requests in a repository, filtered by state.',
      inputSchema: {
        type: 'object',
        properties: {
          ...repoProps,
          state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'], description: 'Filter by state.' },
          page: { type: 'number', description: 'Page number, starting at 1.' },
          perPage: { type: 'number', description: 'Results per page.' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'pull_request_read',
      description: 'Read one pull request, its files, or its status.',
      inputSchema: {
        type: 'object',
        properties: {
          ...repoProps,
          pullNumber: { type: 'number', description: 'The pull request number.' },
          method: { type: 'string', enum: ['get', 'get_files', 'get_status'], description: 'What to read.' },
        },
        required: ['owner', 'repo', 'pullNumber'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request from a head branch into a base branch.',
      inputSchema: {
        type: 'object',
        properties: {
          ...repoProps,
          title: { type: 'string', description: 'The pull request title.' },
          body: { type: 'string', description: 'The pull request body.' },
          head: { type: 'string', description: 'The branch holding the changes.' },
          base: { type: 'string', description: 'The branch to merge into. Default: the default branch.' },
          draft: { type: 'boolean', description: 'Open as a draft.' },
        },
        required: ['owner', 'repo', 'title', 'head'],
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request that is open and mergeable.',
      inputSchema: {
        type: 'object',
        properties: {
          ...repoProps,
          pullNumber: { type: 'number', description: 'The pull request number.' },
          commit_title: { type: 'string', description: 'The merge commit title.' },
          merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'How to merge.' },
        },
        required: ['owner', 'repo', 'pullNumber'],
      },
    },
  ];
}

/** Route one /mcp request. */
export async function handleMcp(input: McpRequest): Promise<void> {
  const { res, method, login, store, body } = input;

  // A GET on /mcp opens an SSE stream; this server answers with a plain 405, which the client
  // treats as "JSON responses only" and does not need.
  if (method !== 'POST') {
    writeJson(res, 405, { error: 'the MCP endpoint takes POST' });
    return;
  }
  if (login === null) {
    // The auth check requires an unauthenticated call to be refused with a 401.
    writeJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    // A parse error is a JSON-RPC error with code -32700.
    writeJson(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  // A batch is an array; answer each in order, skipping notifications.
  if (Array.isArray(parsed)) {
    const answers: unknown[] = [];
    for (const item of parsed) {
      const answer = await answerOne(store, login, item as RpcRequest);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    writeJson(res, 200, answers);
    return;
  }

  const answer = await answerOne(store, login, parsed as RpcRequest);
  if (answer === null) {
    // A notification is acknowledged with 202 and no body.
    res.writeHead(202);
    res.end();
    return;
  }
  writeJson(res, 200, answer);
}

/** Answer one JSON-RPC message, or null when it is a notification. */
async function answerOne(store: Store, login: string, message: RpcRequest): Promise<Record<string, unknown> | null> {
  if (!message || typeof message !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const isNotification = message.id === undefined || message.id === null;
  const id = message.id ?? null;

  switch (message.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo: { name: 'forge-mcp', version: '1.0.0', title: 'Forge MCP server' },
          instructions: `A GitHub-compatible forge. Authenticated as ${login}. Tools cover issues and pull requests.`,
        },
      };

    case 'notifications/initialized':
    case 'initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: tools(login).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) },
      };

    case 'tools/call': {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === '') {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid params: a tool name is required' } };
      }
      const known = tools(login).find((tool) => tool.name === name);
      if (!known) {
        // An unknown tool is a JSON-RPC error with code -32602, as MCP specifies.
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
      // A required argument that is missing is also -32602.
      const required = (known.inputSchema.required as string[] | undefined) ?? [];
      const missing = required.filter((key) => args[key] === undefined || args[key] === null);
      if (missing.length > 0) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Invalid params: missing required argument(s): ${missing.join(', ')}` } };
      }
      const result = runTool(store, login, name, args);
      return { jsonrpc: '2.0', id, result };
    }

    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };

    default:
      if (isNotification) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

/** Run one tool and return its MCP result. */
function runTool(store: Store, login: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const ownerArg = String(args.owner ?? '');
  const repoArg = String(args.repo ?? '');

  if (name === 'get_me') {
    return toolResult({ login, id: numericId(`user:${login}`), name: login, type: 'User' });
  }

  // create_repo makes the repository the other tools then address, so it runs before the lookup.
  if (name === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name : '';
    if (repoName === '') return toolFailure('a repository name is required');
    if (store.repo(login, repoName)) return toolFailure(`repository ${login}/${repoName} already exists`);
    const created = store.createRepo(login, repoName, {
      description: typeof args.description === 'string' ? args.description : null,
      private: args.private === true,
    });
    // autoInit creates a first commit, which is what a client expects of GitHub's default.
    if (args.autoInit === true) {
      const blob = store.putBlob(`# ${repoName}\n`);
      const files = new Map<string, { sha: string; mode: string }>([['README.md', { sha: blob, mode: '100644' }]]);
      store.commitFiles(created, `refs/heads/${created.default_branch}`, null, files, 'Initial commit', `${login} <${login}@forge.local>`);
    }
    return toolResult({ id: numericId(`repo:${login}/${repoName}`), name: repoName, full_name: `${login}/${repoName}`, owner: { login }, private: created.private, default_branch: created.default_branch });
  }

  const repo = store.repo(ownerArg, repoArg);
  if (!repo || repo.owner.toLowerCase() !== login.toLowerCase()) {
    return toolFailure(`repository ${ownerArg}/${repoArg} not found`);
  }

  if (name === 'get_repo') {
    return toolResult({
      id: numericId(`repo:${repo.owner}/${repo.name}`),
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner },
      private: repo.private,
      description: repo.description,
      default_branch: repo.default_branch,
      open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    });
  }

  switch (name) {
    case 'list_issues': {
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()].sort((a, b) => b.number - a.number);
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      if (Array.isArray(args.labels)) {
        const wanted = args.labels.map(String);
        list = list.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
      }
      const perPage = Number(args.perPage ?? 30);
      const page = Number(args.page ?? 1);
      const start = (Math.max(1, page) - 1) * Math.max(1, perPage);
      const slice = list.slice(start, start + Math.max(1, perPage));
      return toolResult(slice.map((issue) => issueView(repo, issue)));
    }

    case 'issue_read': {
      const number = Number(args.issue_number ?? 0);
      const issue = repo.issues.get(number);
      if (!issue) return toolFailure(`issue #${number} not found`);
      const how = typeof args.method === 'string' ? args.method : 'get';
      if (how === 'get_comments') return toolResult(issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: comment.user } })));
      if (how === 'get_labels') return toolResult(issue.labels.map((label) => repo.labels.get(label) ?? { name: label }));
      return toolResult(issueView(repo, issue));
    }

    case 'create_issue':
    case 'issue_write': {
      const how = typeof args.method === 'string' ? args.method : 'create';
      if (how === 'update') {
        const number = Number(args.issue_number ?? 0);
        const issue = repo.issues.get(number);
        if (!issue) return toolFailure(`issue #${number} not found`);
        if (typeof args.title === 'string') issue.title = args.title;
        if (typeof args.body === 'string') issue.body = args.body;
        if (args.state === 'open' || args.state === 'closed') {
          issue.state = args.state;
          issue.closed_at = args.state === 'closed' ? isoOf(FIXED_EPOCH_SEC) : null;
        }
        if (Array.isArray(args.labels)) {
          issue.labels = args.labels.map(String);
        }
        issue.updated_at = isoOf(FIXED_EPOCH_SEC);
        return toolResult(issueView(repo, issue));
      }
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return toolFailure('a title is required to create an issue');
      const now = isoOf(FIXED_EPOCH_SEC);
      const issue: Issue = {
        number: repo.nextIssue,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: Array.isArray(args.labels) ? args.labels.map(String) : [],
        user: login,
        created_at: now,
        updated_at: now,
        closed_at: null,
        comments: [],
      };
      repo.nextIssue += 1;
      repo.issues.set(issue.number, issue);
      return toolResult(issueView(repo, issue));
    }

    case 'add_issue_comment': {
      const number = Number(args.issue_number ?? 0);
      const issue = repo.issues.get(number);
      if (!issue) return toolFailure(`issue #${number} not found`);
      const id = repo.nextComment;
      repo.nextComment += 1;
      issue.comments.push({ id, body: String(args.body ?? ''), user: login, created_at: isoOf(FIXED_EPOCH_SEC) });
      return toolResult({ id, body: String(args.body ?? ''), user: { login }, created_at: isoOf(FIXED_EPOCH_SEC) });
    }

    case 'list_pull_requests': {
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed' && !pull.merged);
      else if (state === 'merged') list = list.filter((pull) => pull.merged);
      return toolResult(list.map((pull) => pullView(repo, pull)));
    }

    case 'pull_request_read': {
      const number = Number(args.pullNumber ?? 0);
      const pull = repo.pulls.get(number);
      if (!pull) return toolFailure(`pull request #${number} not found`);
      const how = typeof args.method === 'string' ? args.method : 'get';
      if (how === 'get_files') return toolResult(pull.files.map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions })));
      if (how === 'get_status') return toolResult({ state: pull.state, merged: pull.merged, mergeable: pull.mergeable });
      return toolResult(pullView(repo, pull));
    }

    case 'create_pull_request': {
      const headRef = typeof args.head === 'string' ? args.head : '';
      const baseRef = typeof args.base === 'string' ? args.base : repo.default_branch;
      const headSha = store.refOf(repo, `refs/heads/${headRef}`);
      const baseSha = store.refOf(repo, `refs/heads/${baseRef}`);
      if (headSha === null || baseSha === null) return toolFailure(`no commits between ${headRef} and ${baseRef}`);
      const now = isoOf(FIXED_EPOCH_SEC);
      const pull: Pull = {
        number: repo.nextPull,
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
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
      return toolResult(pullView(repo, pull));
    }

    case 'merge_pull_request': {
      const number = Number(args.pullNumber ?? 0);
      const pull = repo.pulls.get(number);
      if (!pull) return toolFailure(`pull request #${number} not found`);
      if (pull.merged) return toolFailure(`pull request #${number} is already merged`);
      if (pull.state !== 'open') return toolFailure(`pull request #${number} is not open`);
      pull.merged = true;
      pull.state = 'closed';
      pull.merged_at = isoOf(FIXED_EPOCH_SEC);
      pull.closed_at = pull.merged_at;
      return toolResult({ merged: true, number, state: 'closed', merged_at: pull.merged_at });
    }

    default:
      return toolFailure(`tool ${name} is not implemented`);
  }
}

/** The issue JSON a tool returns: GitHub's REST shape, which is what a model expects. */
function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: { login: issue.user },
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: `http://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository: `${repo.owner}/${repo.name}`,
  };
}

/** The pull request JSON a tool returns. */
function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    head: { ref: pull.head.ref, sha: pull.head.sha },
    base: { ref: pull.base.ref, sha: pull.base.sha },
    user: { login: pull.user },
    created_at: pull.created_at,
    html_url: `http://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    repository: `${repo.owner}/${repo.name}`,
  };
}

/** A stable numeric id, so a tool result is deterministic across runs. */
function numericId(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) % 1_000_000 + 1;
}
