import { NextResponse } from 'next/server';

// Next constructs the incremental cache handler for Node.js middleware too, without serverDistDir.
// The header lets the integration test prove the proxy actually ran.
export function proxy() {
	const response = NextResponse.next();
	response.headers.set('x-harper-proxy', '1');
	return response;
}
