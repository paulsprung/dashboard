import { env } from './env';

export function assertOrigin(req: Request) {
  const origin = req.headers.get('origin');
  if (origin !== env.origin) throw new Error('Invalid origin');
}
