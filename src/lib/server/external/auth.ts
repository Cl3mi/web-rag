import { env } from '$env/dynamic/private';

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export function requireApiKey(request: Request): void {
  const expected = env.EVAL_API_KEY;
  if (!expected) {
    throw new UnauthorizedError('Server missing EVAL_API_KEY');
  }
  const header = request.headers.get('authorization') ?? '';
  const presented = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : header.trim();
  if (presented !== expected) {
    throw new UnauthorizedError();
  }
}
