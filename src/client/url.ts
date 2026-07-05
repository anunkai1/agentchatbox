/**
 * Shareable-session URL state.
 *
 * The current chat's `pi` session id is mirrored into the URL path
 * (`/s/<sessionId>`) so a chat is a bookmarkable, shareable link: open
 * the URL later — or on another device pointed at the same server — and
 * the client resumes that session through the existing `init.sessionId`
 * handshake. The server is unchanged; it already resumes by id (see
 * chat.ts / session-registry.ts). This module only decides which id the
 * browser *asks for*, which is exactly the kind of thing the "transport
 * layer only" rule leaves to the client.
 *
 * Why the URL *path* (not a query param or hash): the server's SPA
 * fallback already serves index.html for any non-`/api/` / non-`/uploads/`
 * GET (see index.ts), so `/s/<id>` loads the app with no extra routing.
 *
 * `history.replaceState` (never `pushState`) is used so reloading or
 * sharing always reflects the current chat, and so the back button
 * doesn't accumulate one history entry per session swap.
 */

const SESSION_PREFIX = "/s/";

/**
 * Extract the session id from the current URL, or null when the URL
 * isn't a session link. Tolerates a trailing slash.
 */
export function readSessionIdFromUrl(): string | null {
	if (!location.pathname.startsWith(SESSION_PREFIX)) return null;
	const id = location.pathname.slice(SESSION_PREFIX.length).replace(/\/+$/, "");
	return id || null;
}

/**
 * The path-only URL for a session: `/s/<id>`. Used by the sidebar row's
 * `<a href>` so middle-click / ⌘-click open the same shareable link in a
 * new tab — identical to how Firefox treats a regular link.
 */
export function sessionPath(id: string): string {
	return `${SESSION_PREFIX}${id}`;
}

/**
 * Mirror a session id into the URL via `replaceState`. Pass null to
 * reset to `/` (e.g. when a link turns out to be stale). No-op if the
 * URL already points at the requested target — avoids needless history
 * churn on every `ready` (reconnects re-emit ready for the same session).
 */
export function writeSessionIdToUrl(sessionId: string | null): void {
	const target = sessionId ? `${SESSION_PREFIX}${sessionId}` : "/";
	if (location.pathname === target) return;
	try {
		history.replaceState(null, "", target);
	} catch {
		// replaceState can throw in some sandboxed iframe / opaque-origin
		// contexts. The URL is cosmetic, so swallow rather than break the app.
	}
}

/**
 * The full, shareable URL for a session: origin + `/s/<id>`. Returns
 * null when there is no bound session yet (the `/link` command and the
 * share button use this to copy a link to the clipboard).
 */
export function shareableSessionUrl(sessionId: string | null): string | null {
	if (!sessionId) return null;
	return `${location.origin}${SESSION_PREFIX}${sessionId}`;
}
