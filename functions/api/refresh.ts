// POST /api/refresh (see server/auth.ts).
import { Env, handleRefresh } from '../../server/auth';

export const onRequestPost = ({ request, env }: { request: Request; env: Env }): Promise<Response> => handleRefresh(request, env);
