import { Resource } from 'harper';

export class Greeting extends Resource {
	static async get() {
		return { message: 'hello from harper' };
	}
}
