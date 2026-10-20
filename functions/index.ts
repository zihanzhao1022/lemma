// The front page, where GitHub also sends people back after signing in for an MCP client: those answers go to
// server/mcp/oauth.ts, everything else is the app itself.
import { Env } from '../server/auth';
import { STATE_PREFIX, githubReturned } from '../server/mcp/oauth';

export const onRequestGet = ({ request, env, next }: { request: Request; env: Env; next: () => Promise<Response> }): Promise<Response> =>
  new URL(request.url).searchParams.get('state')?.startsWith(STATE_PREFIX) ? githubReturned(request, env) : next();
