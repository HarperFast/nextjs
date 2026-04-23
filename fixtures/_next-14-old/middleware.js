import { NextResponse, NextRequest } from 'next/server';

export function middleware(request) {
	return new NextResponse('Hello from middleware', {
		headers: { 'x-middleware': 'true' },
	});
}

export const config = {
	matcher: '/test-middleware',
};
