// Keep recovery runnable from any working directory and Node version supported by ACB.
import { tsImport } from "tsx/esm/api";

await tsImport("./recovery-cli.ts", import.meta.url);
