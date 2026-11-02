// Resolve tsx from this checkout, even when Claude Code runs in another workspace.
import { tsImport } from "tsx/esm/api";

await tsImport("./cli.ts", import.meta.url);
