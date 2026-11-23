/**
 * Client colour theme management: Pure Black (default), Soft Dark, Light, or
 * System (follows OS prefers-color-scheme, using Soft Dark in dark mode).
 */

export type ThemePreference = "black" | "dark" | "light" | "system";
export type ResolvedTheme = "black" | "dark" | "light";

export const THEME_LABELS: Record<ThemePreference, string> = {
	black: "Pure black",
	dark: "Soft dark",
	light: "Light",
	system: "System",
};

const THEME_META_COLORS: Record<ResolvedTheme, string> = {
	black: "#000000",
	dark: "#121418",
	light: "#ffffff",
};

export function parseThemePreference(value: unknown): ThemePreference {
	if (value === "black" || value === "dark" || value === "light" || value === "system") {
		return value;
	}
	return "black";
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
	if (pref !== "system") return pref;
	if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
		return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
	}
	return "dark";
}

export function applyTheme(pref: ThemePreference): ResolvedTheme {
	const resolved = resolveTheme(pref);
	if (typeof document !== "undefined") {
		const root = document.documentElement;
		if (root) {
			if (resolved === "black") root.removeAttribute("data-theme");
			else root.setAttribute("data-theme", resolved);
		}
		const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
		if (meta) meta.content = THEME_META_COLORS[resolved];
	}
	return resolved;
}

/** Watch OS colour-scheme changes while the user has "system" selected. */
export function watchSystemTheme(getPref: () => ThemePreference): void {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
	const mq = window.matchMedia("(prefers-color-scheme: light)");
	const onChange = () => {
		if (getPref() === "system") applyTheme("system");
	};
	if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
}
