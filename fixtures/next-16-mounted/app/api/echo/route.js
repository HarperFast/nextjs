export const dynamic = 'force-dynamic';

// Echoes back the path Next.js received, which is what the mount-stripping fix is about.
export async function GET(request) {
	return Response.json({ pathname: new URL(request.url).pathname });
}
