import { createHash } from 'node:crypto';

/**
 * Harper's primary key limit is MAX_KEY_BYTES = 1978 (harper/resources/Table.ts:146).
 * Next imposes NO size limit on a "use cache" key — it is composed from the cached
 * component's serializable props, so a component handed a large prop produces a
 * correspondingly large key. Observed in the wild at 87,465 bytes, which Harper
 * rejects with `Primary key size is too large`. The rejection surfaces as a rejected
 * cache boundary, which aborts the streamed subtree: a dead page with nothing in the
 * server log, because the error is a Next streaming rejection rather than a Harper one.
 *
 * Oversized keys are truncated and suffixed with a hash of the FULL key. Short keys are
 * passed through untouched, deliberately: hashing unconditionally would change every
 * key and silently invalidate the whole cache on upgrade, and it would throw away a
 * readable id for no benefit.
 *
 * Budgeted well under 1978 rather than up to it — Harper's check serializes the key, and
 * the encoded form can exceed the raw byte count.
 */
const MAX_KEY_BYTES = 1500;
const KEY_HASH_BYTES = 16;
/** Cannot occur in a Next cache key, so a short key can never collide with a truncated one. */
const KEY_HASH_SEPARATOR = '\u0000#';

export function toStorageKey(cacheKey: string): string {
	// A UTF-16 code unit is at most 3 UTF-8 bytes, so most keys skip measuring.
	if (cacheKey.length <= MAX_KEY_BYTES / 3 || Buffer.byteLength(cacheKey, 'utf8') <= MAX_KEY_BYTES) return cacheKey;

	// Hashed over UTF-16 code units, not their UTF-8 encoding. Next composes a key with `encodeReply`,
	// whose FormData/binary encoding can leave lone surrogates in the string; UTF-8 collapses every one
	// of them to U+FFFD, so two keys differing only there would hash alike — and, since the truncated
	// prefix collapses the same way, land on one row and serve one cache boundary's bytes for another's
	// key. `utf16le` writes each code unit verbatim, so the digest keeps them apart.
	const digest = createHash('sha256').update(cacheKey, 'utf16le').digest('hex').slice(0, KEY_HASH_BYTES);
	const budget = MAX_KEY_BYTES - Buffer.byteLength(KEY_HASH_SEPARATOR, 'utf8') - digest.length;

	// Truncate by BYTES on a character boundary. Slicing by .length would overshoot on
	// multi-byte input, and slicing mid-codepoint could re-encode differently on another
	// node — two nodes must derive the same key for the same entry.
	const truncated = Buffer.from(cacheKey, 'utf8').subarray(0, budget).toString('utf8').replace(/\uFFFD+$/, '');

	return `${truncated}${KEY_HASH_SEPARATOR}${digest}`;
}
