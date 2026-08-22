/** Cache policy for public client assets. */
export function staticCacheControl(filePath: string, requestUrl: string): string {
	if (filePath.endsWith(".html")) return "no-store, no-cache, must-revalidate";
	// Build-generated content hashes live in the query string. Browsers key
	// caches by the complete URL, so a changed build automatically fetches a
	// new object while unchanged assets require no conditional round-trip.
	if (/[?&]v=[a-f0-9]{8,64}(?:&|$)/i.test(requestUrl)) {
		return "public, max-age=31536000, immutable";
	}
	// Favicons/social images have stable names. Cache them long enough to make
	// repeat tabs instant, but not forever because a future deploy may replace
	// them without changing index.html.
	return "public, max-age=86400";
}
