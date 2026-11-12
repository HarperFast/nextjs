'use client';

import { useState } from 'react';
import { ping } from './actions.js';

export function ActionButton() {
	const [result, setResult] = useState('idle');

	async function run() {
		try {
			setResult(await ping());
		} catch (error) {
			setResult(`error: ${error.message}`);
		}
	}

	return (
		<div>
			<button onClick={run}>Ping</button>
			<p data-testid="result">{result}</p>
		</div>
	);
}
