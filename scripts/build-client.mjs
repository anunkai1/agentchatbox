/**
 * Build the client with esbuild.
 *
 *   node scripts/build-client.mjs          # one-shot build
 *   node scripts/build-client.mjs --watch  # rebuild on change
 *
 * Outputs to public/app.js and (if main.ts imports a CSS file) public/app.css.
 * The public/ folder is served by the Node server in production.
 */

import { build, context } from "esbuild";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const watch = process.argv.includes("--watch");

await mkdir(resolve(root, "public"), { recursive: true });

const cssSrc = resolve(root, "node_modules/@earendil-works/pi-web-ui/dist/app.css");
const cssDst = resolve(root, "public/app.css");
const htmlSrc = resolve(root, "index.html");
const htmlDst = resolve(root, "public/index.html");

async function copyStatic() {
	await copyFile(cssSrc, cssDst);
	const cssStat = await stat(cssDst);
	await copyFile(htmlSrc, htmlDst);
	console.log(`client: copied app.css (${(cssStat.size / 1024).toFixed(1)} KB) and index.html`);
}

const options = {
	entryPoints: [resolve(root, "src/client/main.ts")],
	bundle: true,
	format: "esm",
	target: ["es2022"],
	platform: "browser",
	outdir: resolve(root, "public"),
	entryNames: "app",
	sourcemap: true,
	minify: !watch,
	logLevel: "info",
	define: {
		"process.env.NODE_ENV": watch ? '"development"' : '"production"',
	},
	// These packages are Node-only (or pull in Node-only deps). The web UI
	// references them as optional integrations, so we let the browser skip them.
	external: ["@lmstudio/sdk", "ollama", "jszip"],
};

if (watch) {
	await copyStatic();
	const ctx = await context(options);
	await ctx.watch();
	console.log("client: watching for changes…");
} else {
	await build(options);
	await copyStatic();
}
