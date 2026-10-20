// GET and POST /api/mcp/authorize (see server/mcp/oauth.ts).
import { Env } from '../../../server/auth';
import { authorize } from '../../../server/mcp/oauth';

export const onRequestGet = ({ request, env }: { request: Request; env: Env }): Promise<Response> => authorize(request, env);
export const onRequestPost = onRequestGet;
