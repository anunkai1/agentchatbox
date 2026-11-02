/** Private local discovery for authorised services using /api/internal.
 * The bearer rotates each boot; clients must read this file for each request.
 * No session routing or agent workflow belongs here.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function publishInternalEndpoint(port: number, token: string, home = homedir()): void {
	const dir = join(home, ".config", "acb", "internal");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, `${port}.json`);
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify({ url: `http://127.0.0.1:${port}`, token })}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	renameSync(temp, file);
}
