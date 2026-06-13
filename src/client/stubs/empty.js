// Empty stub for browser-incompatible optional dependencies.
// esbuild's plugin maps any import of @lmstudio/sdk, ollama, or jszip
// (including subpaths) to this file.

// jszip (default export)
const JSZip = class {};

// @lmstudio/sdk
class LMStudioClient {
	async list() { return []; }
}

// ollama/browser
class Ollama {
	async list() { return []; }
}

export default JSZip;
export { JSZip, LMStudioClient, Ollama };
