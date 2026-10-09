import { revalidatePath } from 'next/cache';

export async function POST() {
	revalidatePath('/', 'page');
	return Response.json({ revalidated: true });
}
