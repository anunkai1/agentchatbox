/**
 * Client-side service registry — a tiny leaf module that breaks the
 * render↔main / render↔voice import cycle.
 *
 * `render.ts` needs to (a) fork a message and (b) request a voice reply /
 * speak — capabilities owned by `main.ts` and `voice.ts`. But `voice.ts`
 * imports `render.ts` statically (for appendError/refreshStatus), so
 * `render.ts` importing either back would form a cycle. Previously this
 * was papered over with ~`import("./main.js").then(...)` /
 * `import("./voice.js").then(...)` dynamic imports.
 *
 * Instead, `main.ts` registers concrete implementations into this object
 * at boot, and `render.ts` calls through `services` (optional-chained, so
 * it's a harmless no-op before boot wires it up — matching the prior
 * hook behavior).
 */

export interface ClientServices {
	/** Fork the current chat at a message ordinal (per-message fork button). */
	forkFromMessage(messageCount: number): void;
	/** Send a slash command / prompt with no local echo (voice-reply button). */
	sendSlashCommand(text: string): void;
	/** Send a normal user prompt from an inline response action. */
	sendPrompt(text: string): boolean;
	/** Copy text using the browser clipboard with the app fallback. */
	copyText(text: string): Promise<boolean>;
	/** Copy the current session's shareable URL. */
	copyShareLink(): void;
	/** Toggle speak/stop for a spoken-variant button on an assistant message. */
	toggleSpeak(text: string, src: unknown): void;
}

/** Populated by `setServices()` at boot; empty beforehand. */
export const services: Partial<ClientServices> = {};

/** Wire the concrete implementations (called once from main.ts boot). */
export function setServices(s: ClientServices): void {
	Object.assign(services, s);
}
