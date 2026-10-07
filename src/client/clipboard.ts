/**
 * Copy text to the system clipboard. Returns false when the write fails (for
 * example permission denied). `navigator.clipboard` needs https or localhost,
 * so on http:// LAN addresses it falls back to the legacy textarea trick.
 * The write is awaited so a failure is reported, not logged as "copied".
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Fall through to the legacy textarea path.
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(ta);
		return ok;
	} catch {
		return false;
	}
}
