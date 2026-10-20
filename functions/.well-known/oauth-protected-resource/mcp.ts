// The same metadata at the address RFC 9728 gives for the resource /mcp.
import { preflight, protectedResource } from '../../../server/mcp/oauth';

export const onRequestGet = ({ request }: { request: Request }): Response => protectedResource(request);
export const onRequestOptions = (): Response => preflight();
