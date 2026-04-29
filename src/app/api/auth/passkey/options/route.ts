import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { createPasskeyOptions } from '@/lib/auth';

export async function POST() {
  const options = await createPasskeyOptions();
  (await cookies()).set('pk_challenge', options.challenge, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 5
  });

  return NextResponse.json(options);
}
