import { NextRequest, NextResponse } from 'next/server';
import { sessionCookie, verifySessionToken } from '@/lib/session';

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith('/api/auth') || pathname === '/login') {
    return NextResponse.next();
  }

  const token = request.cookies.get(sessionCookie.name)?.value;

  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  const session = await verifySessionToken(token);

  if (!session) {
    const response = NextResponse.redirect(new URL('/login', request.url));
    response.cookies.set(sessionCookie.name, '', { ...sessionCookie.options, maxAge: 0 });
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
};
