/** Read-only sidebar projection of the delegate extension's existing records.
 * Execution, status transitions and record ownership stay in the extension. */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface SidebarDelegation {
	parentSessionId: string;
	status: string;
}
const cache = new Map<string, { stamp: string; value: SidebarDelegation | null }>();

export function sessionDelegation(id: string): SidebarDelegation | null {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return null;
	const dir = process.env.ACB_DELEGATIONS_DIR ?? join(homedir(), ".config/acb/delegations");
	const file = join(dir, `${id}.json`);
	try {
		const st = statSync(file);
		const stamp = `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
		const previous = cache.get(file);
		if (previous?.stamp === stamp) return previous.value;
		const record = JSON.parse(readFileSync(file, "utf8"));
		const value =
			record.id === id &&
			typeof record.parentSessionId === "string" &&
			typeof record.status === "string"
				? { parentSessionId: record.parentSessionId, status: record.status }
				: null;
		cache.set(file, { stamp, value });
		return value;
	} catch {
		cache.delete(file);
		return null;
	}
}
