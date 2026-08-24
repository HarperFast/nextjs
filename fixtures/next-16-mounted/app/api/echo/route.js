export const dynamic = 'force-dynamic';

export async function GET(request) {
	const url = new URL(request.url);
	return Response.json({ pathname: url.pathname, search: url.search });
}
