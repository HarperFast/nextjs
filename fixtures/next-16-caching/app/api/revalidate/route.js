import { revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';

export async function POST(request) {
	const tag = new URL(request.url).searchParams.get('tag');
	if (!tag) {
		return NextResponse.json({ error: 'tag required' }, { status: 400 });
	}
	revalidateTag(tag);
	return NextResponse.json({ revalidated: true, tag });
}
