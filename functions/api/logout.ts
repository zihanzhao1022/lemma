// POST /api/logout (see server/auth.ts).
import { Env, handleLogout } from '../../server/auth';

export const onRequestPost = ({ request, env }: { request: Request; env: Env }): Promise<Response> => handleLogout(request, env);
