/**
 * The MCP endpoint (POST /mcp, Streamable HTTP without sessions): JSON-RPC messages in, JSON answers out, for a
 * client signed in through oauth.ts. Each tool call reads (and may save) the person's papers through GitHub.
 */
import { ConflictError } from '../../editor/errors';
import { GitHubError } from '../../editor/github';
import { Env } from '../auth';
import { Library, ToolError, openLibrary } from './library';
import { CORS, caller, json, preflight, unauthorized } from './oauth';
import { TOOLS } from './tools';

/** The protocol versions this server speaks, newest first. */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  "Lemma keeps a person's LaTeX papers as blocks (text, figures, tables) in their own GitHub repository.",
  'Find a paper with list_papers and look at it with get_paper before changing it; read_blocks gives the LaTeX.',
  "Every change is saved at once as a commit to the person's repository.",
  "LaTeX does not run here: Lemma compiles changed blocks the next time the paper is open there, so keep the LaTeX valid and in the paper's own style, and tell the person to open the paper in Lemma to see the result.",
  "A paper's logic is a tree of its blocks starting at the introduction (each experiment under the method it tests, for example), plus links drawn between related blocks; Lemma presents the paper and builds its slides along it.",
].join(' ');

type Id = string | number | null;
interface Reply {
  jsonrpc: '2.0';
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

const ok = (id: Id, result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
const failed = (id: Id, code: number, message: string): Reply => ({ jsonrpc: '2.0', id, error: { code, message } });

/** What went wrong in a tool, in words the person (and the model) can act on. */
function describe(error: unknown): string {
  if (error instanceof ToolError) return error.message;
  if (error instanceof ConflictError) return 'The paper kept changing elsewhere while saving; look at it again and retry.';
  if (error instanceof GitHubError) {
    if (error.status === 401) return 'GitHub no longer accepts this sign-in: connect Lemma again in Claude Code (/mcp).';
    if (error.status === 403 || error.status === 404) return `GitHub refused (${error.status}): Lemma's App may no longer be installed on the repository.`;
    if (error.status === 0) return 'GitHub could not be reached; try again.';
    return `GitHub answered ${error.status}; try again.`;
  }
  return `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
}

type Open = (token: string, login: string, repo?: string) => Promise<Library>;

async function handle(message: unknown, who: { github: string; login: string }, open: Open): Promise<Reply | null> {
  if (!message || typeof message !== 'object') return failed(null, -32600, 'Invalid request');
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };
  // A response or a notification gets no answer.
  if (typeof method !== 'string') return null;
  if (id === undefined) return null;
  if (typeof id !== 'string' && typeof id !== 'number' && id !== null) return failed(null, -32600, 'Invalid request id');
  switch (method) {
    case 'initialize': {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      return ok(id, {
        protocolVersion: typeof asked === 'string' && VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lemma', title: 'Lemma', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS.map(({ run: _run, ...tool }) => tool) });
    case 'tools/call': {
      const call = (params ?? {}) as { name?: unknown; arguments?: unknown };
      const tool = TOOLS.find((item) => item.name === call.name);
      if (!tool) return failed(id, -32602, `Unknown tool: ${String(call.name)}`);
      const args = call.arguments && typeof call.arguments === 'object' ? (call.arguments as Record<string, unknown>) : {};
      try {
        const library = await open(who.github, who.login, typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : undefined);
        return ok(id, { content: [{ type: 'text', text: await tool.run(args, library) }] });
      } catch (error) {
        return ok(id, { content: [{ type: 'text', text: describe(error) }], isError: true });
      }
    }
    default:
      return failed(id, -32601, `Method not found: ${method}`);
  }
}

/** /mcp: POST carries the messages; the server opens no stream of its own, so GET has nothing to give. */
export async function handleMcp(request: Request, env: Env, open: Open = openLibrary): Promise<Response> {
  if (request.method === 'OPTIONS') return preflight();
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST, OPTIONS', ...CORS } });
  const who = await caller(request, env);
  if (!who) return unauthorized(request, request.headers.has('Authorization'));
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(failed(null, -32700, 'Parse error'), 400);
  }
  const messages = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(messages.map((message) => handle(message, who, open)))).filter((reply): reply is Reply => reply !== null);
  if (replies.length === 0) return new Response(null, { status: 202, headers: CORS });
  return json(Array.isArray(body) ? replies : replies[0]);
}
