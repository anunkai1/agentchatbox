/**
 * Antigravity account discovery and isolated GEMINI_HOME management.
 *
 * The primary account lives at `~/.gemini/antigravity-acp/acp_token.json`
 * (the upstream default). Extra accounts live in isolated `GEMINI_HOME`
 * directories under `~/.gemini/antigravity-accounts/<label>/`, each with its
 * own `antigravity-acp/acp_token.json` and session store so multiple Google
 * accounts can stay signed in simultaneously without clobbering each other.
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PRIMARY_LABEL = "primary";
export const AUTO_LABEL = "auto";
export const VALID_LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function defaultPrimaryHome(): string {
	return process.env.ACB_ANTIGRAVITY_PRIMARY_HOME?.trim() || join(homedir(), ".gemini");
}

export function defaultAccountsDir(): string {
	return (
		process.env.ACB_ANTIGRAVITY_ACCOUNTS_DIR?.trim() ||
		join(homedir(), ".gemini", "antigravity-accounts")
	);
}

export function defaultStateFile(accountsDir = defaultAccountsDir()): string {
	return process.env.ACB_ANTIGRAVITY_POOL_STATE_FILE?.trim() || join(accountsDir, "state.json");
}

export interface AntigravityAccount {
	label: string;
	isPrimary: boolean;
	geminiHome: string;
	acpDir: string;
	tokenFile: string;
	/** In-memory only for deduplication; never printed or serialized. */
	refreshToken: string;
}

export interface AccountPaths {
	geminiHome: string;
	acpDir: string;
	tokenFile: string;
	settingsFile: string;
}

export function validateAccountLabel(raw: string): string {
	const label = raw.trim();
	if (!label) throw new Error("Account label is required.");
	if (label.toLowerCase() === AUTO_LABEL) {
		throw new Error(`"${AUTO_LABEL}" is reserved for automatic priority mode.`);
	}
	if (!VALID_LABEL_RE.test(label) || label === "." || label === "..") {
		throw new Error("Account label must be 1–32 characters of letters, digits, '.', '_' or '-'.");
	}
	return label;
}

export function resolveAccountPaths(
	label: string,
	primaryHome = defaultPrimaryHome(),
	accountsDir = defaultAccountsDir(),
): AccountPaths {
	const geminiHome = label === PRIMARY_LABEL ? primaryHome : join(accountsDir, label);
	const acpDir = join(geminiHome, "antigravity-acp");
	return {
		geminiHome,
		acpDir,
		tokenFile: join(acpDir, "acp_token.json"),
		settingsFile: join(acpDir, "settings.json"),
	};
}

export function readRefreshToken(tokenFile: string): string | undefined {
	try {
		const raw = JSON.parse(readFileSync(tokenFile, "utf8")) as { refresh_token?: unknown };
		if (typeof raw.refresh_token === "string" && raw.refresh_token.trim().length > 0) {
			return raw.refresh_token.trim();
		}
	} catch {
		// Missing or malformed token file.
	}
	return undefined;
}

/** Primary account first, then extra account slots sorted alphabetically. */
export function readAntigravityAccounts(
	primaryHome = defaultPrimaryHome(),
	accountsDir = defaultAccountsDir(),
): AntigravityAccount[] {
	const accounts: AntigravityAccount[] = [];
	const seenTokens = new Set<string>();

	const tryAdd = (label: string, isPrimary: boolean) => {
		const paths = resolveAccountPaths(label, primaryHome, accountsDir);
		const refreshToken = readRefreshToken(paths.tokenFile);
		if (!refreshToken || seenTokens.has(refreshToken)) return;
		seenTokens.add(refreshToken);
		accounts.push({
			label,
			isPrimary,
			geminiHome: paths.geminiHome,
			acpDir: paths.acpDir,
			tokenFile: paths.tokenFile,
			refreshToken,
		});
	};

	tryAdd(PRIMARY_LABEL, true);

	if (existsSync(accountsDir)) {
		const entries = readdirSync(accountsDir).sort((a, b) => a.localeCompare(b));
		for (const name of entries) {
			if (name.startsWith(".") || name === PRIMARY_LABEL || name === AUTO_LABEL) continue;
			if (!VALID_LABEL_RE.test(name)) continue;
			const full = join(accountsDir, name);
			try {
				if (!statSync(full).isDirectory()) continue;
			} catch {
				continue;
			}
			tryAdd(name, false);
		}
	}

	return accounts;
}

/** Returns another slot's label if `tokenFile` shares its refresh_token. */
export function findDuplicateLabel(
	tokenFile: string,
	targetLabel: string,
	primaryHome = defaultPrimaryHome(),
	accountsDir = defaultAccountsDir(),
): string | undefined {
	const token = readRefreshToken(tokenFile);
	if (!token) return undefined;
	for (const account of readAntigravityAccounts(primaryHome, accountsDir)) {
		if (account.label !== targetLabel && account.refreshToken === token) {
			return account.label;
		}
	}
	return undefined;
}

/** Ensures an isolated `GEMINI_HOME/antigravity-acp` directory and oauth settings exist. */
export function prepareAccountDirectory(
	rawLabel: string,
	primaryHome = defaultPrimaryHome(),
	accountsDir = defaultAccountsDir(),
): AccountPaths {
	const label = validateAccountLabel(rawLabel);
	const paths = resolveAccountPaths(label, primaryHome, accountsDir);
	if (label !== PRIMARY_LABEL) {
		mkdirSync(accountsDir, { recursive: true, mode: 0o700 });
		chmodSync(accountsDir, 0o700);
		mkdirSync(paths.geminiHome, { recursive: true, mode: 0o700 });
		chmodSync(paths.geminiHome, 0o700);
	}
	mkdirSync(paths.acpDir, { recursive: true, mode: 0o700 });
	chmodSync(paths.acpDir, 0o700);

	let hasAuth = false;
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(readFileSync(paths.settingsFile, "utf8")) as Record<string, unknown>;
		if (existing && typeof existing.auth === "object" && existing.auth !== null) {
			hasAuth = true;
		}
	} catch {
		// Create settings.json below.
	}
	if (!hasAuth) {
		writeFileSync(
			paths.settingsFile,
			`${JSON.stringify({ ...existing, auth: { type: "oauth-personal" } }, null, 2)}\n`,
			{ mode: 0o600 },
		);
	}
	return paths;
}

export function removeAccountSlot(rawLabel: string, accountsDir = defaultAccountsDir()): boolean {
	const label = validateAccountLabel(rawLabel);
	if (label === PRIMARY_LABEL) {
		throw new Error(
			'Cannot remove "primary". Use `/antigravity-acp logout` or `/gemini-accounts login primary` instead.',
		);
	}
	const dir = join(accountsDir, label);
	if (!existsSync(dir)) return false;
	rmSync(dir, { recursive: true, force: true });
	return true;
}

export function suggestNextLabel(accounts: readonly AntigravityAccount[]): string {
	const existing = new Set(accounts.map((a) => a.label.toLowerCase()));
	for (let n = 2; n < 100; n += 1) {
		const candidate = `pro${n}`;
		if (!existing.has(candidate)) return candidate;
	}
	return "pro2";
}
