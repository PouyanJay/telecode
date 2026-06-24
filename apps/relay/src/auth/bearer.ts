import type { FastifyRequest } from 'fastify';

/** Extract the `Authorization: Bearer <token>` value from a request, or null when absent/malformed. */
export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}
