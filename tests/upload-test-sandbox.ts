import { rmSync } from "node:fs";
import type { TestProject } from "vitest/node";

/** Remove only the scratch directory allocated by vitest.config.ts. */
export default function setup(project: TestProject): () => void {
	const directory = project.config.env.UPLOADS_DIR;
	if (!directory) throw new Error("test upload sandbox is not configured");
	return () => rmSync(directory, { recursive: true, force: true });
}
