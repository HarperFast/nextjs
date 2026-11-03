import { NextResponse } from 'next/server';

// Next constructs the incremental cache handler for Node.js middleware too, without serverDistDir.
export function proxy() {
	return NextResponse.next();
}
