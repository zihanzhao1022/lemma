// POST /api/token (see server/auth.ts).
import { Env, handleToken } from '../../server/auth';

export const onRequestPost = ({ request, env }: { request: Request; env: Env }): Promise<Response> => handleToken(request, env);
