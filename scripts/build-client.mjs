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
import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const watch = process.argv.includes("--watch");

await mkdir(resolve(root, "public"), { recursive: true });

const cssSrc = resolve(root, "node_modules/@earendil-works/pi-web-ui/dist/app.css");
const cssDst = resolve(root, "public/app.css");
const htmlSrc = resolve(root, "index.html");
const htmlDst = resolve(root, "public/index.html");

/**
 * Copy the brand assets (favicon, logo PNGs/SVG, og-image) from
 * `assets/brand/` into `public/` so express.static can serve them at
 * the same paths the HTML <link> tags reference. Source of truth
 * lives in `assets/brand/` so the binary PNGs are tracked in git
 * (public/ is mostly build output and partly gitignored).
 */
async function copyBrand() {
	const brandSrc = resolve(root, "assets/brand");
	const brandDst = resolve(root, "public");
	let copied = 0;
	let bytes = 0;
	for (const name of await readdir(brandSrc)) {
		if (name.startsWith(".")) continue;
		await copyFile(join(brandSrc, name), join(brandDst, name));
		const s = await stat(join(brandDst, name));
		copied += 1;
		bytes += s.size;
	}
	console.log(`client: copied ${copied} brand asset(s) (${(bytes / 1024).toFixed(1)} KB)`);
}

async function copyStatic() {
	const clientCssSrc = resolve(root, "src/client/styles.css");
	const clientCssDst = resolve(root, "public/styles.css");
	await copyFile(cssSrc, cssDst);
	await copyFile(clientCssSrc, clientCssDst);
	await copyFile(htmlSrc, htmlDst);
	await copyBrand();
	const cssStat = await stat(cssDst);
	console.log(`client: copied app.css (${(cssStat.size / 1024).toFixed(1)} KB) + styles.css + index.html`);
}

/**
 * Stamp the bundled app.js AND styles.css with content-hash query
 * strings in public/index.html so browsers fetch fresh copies on every
 * deploy instead of serving a stale cached bundle/stylesheet.
 *
 * Without this, <script src="/app.js"> and <link href="/styles.css">
 * get cached indefinitely and a normal reload after a deploy keeps
 * running the old code/CSS (the "why don't my changes show up" bug).
 *
 * Each hash is derived from that file's own bytes, so a JS-only change
 * leaves the CSS hash (and its cache entry) untouched and vice versa;
 * a change to either forces a re-fetch of just that asset.
 */
async function stampCacheBust() {
	const { createHash } = await import("node:crypto");
	const { readFile, writeFile } = await import("node:fs/promises");
	const appJsPath = resolve(root, "public/app.js");
	const cssPath = resolve(root, "public/styles.css");
	const htmlPath = resolve(root, "public/index.html");
	let html = await readFile(htmlPath, "utf8");

	const appBuf = await readFile(appJsPath);
	const appHash = createHash("sha256").update(appBuf).digest("hex").slice(0, 12);
	html = html.replace(/src="\/app\.js(\?v=[a-f0-9]+)?"/, `src="/app.js?v=${appHash}"`);
	console.log(`client: stamped index.html with app.js?v=${appHash}`);

	// CSS has its OWN content hash — a JS-only rebuild leaves styles.css
	// cached (correct), and a CSS-only change forces a re-fetch without
	// needlessly invalidating app.js. Previously styles.css had no
	// cache-bust at all, so it was cached forever and CSS changes never
	// reached returning browsers.
	const cssBuf = await readFile(cssPath);
	const cssHash = createHash("sha256").update(cssBuf).digest("hex").slice(0, 12);
	html = html.replace(/href="\/styles\.css(\?v=[a-f0-9]+)?"/, `href="/styles.css?v=${cssHash}"`);
	console.log(`client: stamped index.html with styles.css?v=${cssHash}`);

	await writeFile(htmlPath, html);
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
	// These packages are Node-only (or pull in Node-only deps like `process`).
	// The web UI references them as optional integrations; we replace any
	// import of them (including subpaths) with an empty stub.
	plugins: [
		{
			name: "stub-optional-deps",
			setup(build) {
				const STUB = resolve(root, "src/client/stubs/empty.js");
				const STUB_PREFIXES = ["@lmstudio/sdk", "ollama", "jszip"];
				build.onResolve({ filter: /.*/ }, (args) => {
					for (const prefix of STUB_PREFIXES) {
						if (args.path === prefix || args.path.startsWith(prefix + "/")) {
							return { path: STUB };
						}
					}
					return undefined;
				});
			},
		},
	],
};

if (watch) {
	await copyStatic();
	await stampCacheBust();
	const ctx = await context(options);
	await ctx.watch();
	console.log("client: watching for changes…");
} else {
	await build(options);
	await copyStatic();
	await stampCacheBust();
}
