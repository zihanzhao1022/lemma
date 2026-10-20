// POST /api/mcp/token (see server/mcp/oauth.ts).
import { Env } from '../../../server/auth';
import { preflight, token } from '../../../server/mcp/oauth';

export const onRequestPost = ({ request, env }: { request: Request; env: Env }): Promise<Response> => token(request, env);
export const onRequestOptions = (): Response => preflight();
