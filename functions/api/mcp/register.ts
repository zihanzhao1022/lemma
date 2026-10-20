// POST /api/mcp/register (see server/mcp/oauth.ts).
import { Env } from '../../../server/auth';
import { preflight, register } from '../../../server/mcp/oauth';

export const onRequestPost = ({ request, env }: { request: Request; env: Env }): Promise<Response> => register(request, env);
export const onRequestOptions = (): Response => preflight();
