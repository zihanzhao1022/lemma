// The MCP endpoint for Claude Code and other MCP clients (see server/mcp/protocol.ts).
import { Env } from '../server/auth';
import { handleMcp } from '../server/mcp/protocol';

export const onRequest = ({ request, env }: { request: Request; env: Env }): Promise<Response> => handleMcp(request, env);
