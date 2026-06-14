/**
 * DOM helpers and the uuid fallback. No framework, no dependencies on
 * the rest of the app. Imported by every other client module.
 */

/**
 * UUID helper — `crypto.randomUUID()` is unavailable in non-secure contexts
 * on some Android WebViews (e.g. plain http://LAN IPs). Fall back to a
 * tiny RFC4122 v4 generator so the page still loads.
 */
export function uuid(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	const b = new Uint8Array(16);
	const get = (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function")
		? crypto.getRandomValues.bind(crypto)
		: (a: Uint8Array) => a.map(() => Math.floor(Math.random() * 256));
	get(b);
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const h = Array.from(b, (x) => x.toString(16).padStart(2, "0"));
	return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

export function $<T extends HTMLElement>(sel: string): T {
	const el = document.querySelector(sel) as T | null;
	if (!el) throw new Error(`element not found: ${sel}`);
	return el;
}

export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Record<string, unknown> = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") node.className = v as string;
		else if (k === "html") (node as HTMLElement).innerHTML = v as string;
		else if (k === "text") (node as HTMLElement).textContent = v as string;
		else if (k === "on") {
			for (const [event, handler] of Object.entries(v as Record<string, EventListener>)) {
				node.addEventListener(event, handler);
			}
		} else (node as unknown as Record<string, unknown>)[k] = v;
	}
	for (const c of children) node.append(c);
	return node;
}

export function text(s: string): Text {
	return document.createTextNode(s);
}

/**
 * Return handles into a live assistant message's DOM nodes so callers
 * (the event dispatcher) can stream updates in place without re-rendering.
 */
export interface LiveAssistantDom {
	textPre: HTMLPreElement;
	thinkingWrap: HTMLDivElement;
	thinkingPre: HTMLPreElement;
}
