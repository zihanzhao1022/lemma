// RFC 9728 metadata of the MCP endpoint (see server/mcp/oauth.ts).
import { preflight, protectedResource } from '../../server/mcp/oauth';

export const onRequestGet = ({ request }: { request: Request }): Response => protectedResource(request);
export const onRequestOptions = (): Response => preflight();
