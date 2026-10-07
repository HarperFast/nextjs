import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';

export async function POST(request) {
	const tag = new URL(request.url).searchParams.get('tag');
	if (!tag) {
		return NextResponse.json({ error: 'tag required' }, { status: 400 });
	}
	// `profile` selects Next 16's stale-while-revalidate form; without it the tag expires immediately.
	const profile = new URL(request.url).searchParams.get('profile');
	if (profile) revalidateTag(tag, profile);
	else revalidateTag(tag);
	return NextResponse.json({ revalidated: true, tag, profile });
}
