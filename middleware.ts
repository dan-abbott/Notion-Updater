import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Gates /admin and /api/admin/* behind HTTP Basic Auth. This is a small
// internal tool for a handful of people — Basic Auth (browser's native
// login prompt, checked against a single shared password) is proportional
// to that, not a reason to build a full auth system.
//
// Fails CLOSED if ADMIN_PASSWORD isn't set: the check below requires
// `expectedPassword` to be truthy before it can ever match, so a missing
// env var means every request is rejected, never accidentally left open.
export function middleware(request: NextRequest) {
  const authHeader = request.headers.get('authorization');

  if (authHeader?.startsWith('Basic ')) {
    const decoded = atob(authHeader.slice('Basic '.length));
    const separatorIndex = decoded.indexOf(':');
    const user = decoded.slice(0, separatorIndex);
    const pwd = decoded.slice(separatorIndex + 1);

    const expectedUser = process.env.ADMIN_USERNAME || 'admin';
    const expectedPassword = process.env.ADMIN_PASSWORD;

    if (expectedPassword && user === expectedUser && pwd === expectedPassword) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Notion-Updater Admin"' },
  });
}

export const config = {
  matcher: ['/admin/:path*', '/api/admin/:path*'],
};
