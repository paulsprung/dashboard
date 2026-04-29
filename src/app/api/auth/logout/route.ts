import { NextResponse } from 'next/server';
import { sessionCookie } from '@/lib/session';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookie.name, '', {
    ...sessionCookie.options,
    maxAge: 0
  });
  return response;
}
