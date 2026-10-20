// RFC 8414 metadata of the site as an authorization server for MCP clients (see server/mcp/oauth.ts).
import { authorizationServer, preflight } from '../../server/mcp/oauth';

export const onRequestGet = ({ request }: { request: Request }): Response => authorizationServer(request);
export const onRequestOptions = (): Response => preflight();
