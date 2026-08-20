import { describe, expect, it, vi } from "vitest";
import registerLocalAi from "../extensions/local-ai/index.js";
import { localAiLabel, parseLocalAiState } from "../extensions/local-ai/lib.js";

describe("local AI status", () => {
	it("recognises the Qwen backend", () => {
		expect(parseLocalAiState("Qwen API  : ready\nFLUX API  : unavailable")).toBe("qwen");
		expect(localAiLabel("qwen")).toBe("Qwen active");
	});

	it("recognises the image backend", () => {
		expect(parseLocalAiState("Qwen API  : unavailable\nFLUX API  : ready")).toBe("image");
	});

	it("recognises LTX while ComfyUI is active or busy", () => {
		expect(parseLocalAiState("LTX-2.5   : active")).toBe("video");
		expect(parseLocalAiState("LTX-2.5   : busy")).toBe("video");
	});

	it("distinguishes stopped and unreachable server4", () => {
		expect(parseLocalAiState("Qwen API  : unavailable\nFLUX API  : unavailable")).toBe("stopped");
		expect(parseLocalAiState("ssh: connect to host server4 failed", 255)).toBe("offline");
	});
});

type LocalCommand = (args: string, ctx: LocalContext) => Promise<void>;
type LocalContext = {
	modelRegistry: { find: (provider: string, id: string) => { provider: string; id: string } | undefined };
	ui: {
		notify: (message: string, level: string) => void;
		select: (title: string, options: string[]) => Promise<string | undefined>;
		setStatus: (key: string, text: string | undefined) => void;
	};
};

function localAiHarness(
	setModelResult: { provider: string; id: string } | false = { provider: "local", id: "qwen3.8-27b-ud-q3" },
) {
	let command: LocalCommand | undefined;
	const notify = vi.fn();
	const setStatus = vi.fn();
	const model = { provider: "local", id: "qwen3.8-27b-ud-q3" };
	const exec = vi.fn(async () => ({
		stdout: "Qwen API  : ready\nFLUX API  : unavailable\nLTX-2.5   : unavailable",
		code: 0,
	}));
	registerLocalAi({
		registerCommand: (_name: string, options: { handler: LocalCommand }) => {
			command = options.handler;
		},
		exec,
		setModel: async () => setModelResult,
	} as never);
	return {
		command: command!,
		exec,
		notify,
		setStatus,
		ctx: {
			modelRegistry: { find: () => model },
			ui: { notify, select: vi.fn(async () => undefined), setStatus },
		},
	};
}

describe("local AI extension", () => {
	it("checks server4 status before selecting the registered Qwen model", async () => {
		const h = localAiHarness();
		await h.command("qwen", h.ctx);
		expect(h.exec).toHaveBeenCalledWith(
			"ssh",
			expect.arrayContaining(["server4", "local-ai", "status"]),
			expect.anything(),
		);
		expect(h.notify).toHaveBeenCalledWith("Qwen local is ready and selected.", "info");
		expect(h.setStatus).toHaveBeenLastCalledWith("local-ai", "Qwen active");
	});

	it("reports a model-selection failure instead of claiming Qwen is active", async () => {
		const h = localAiHarness(false);
		await h.command("qwen", h.ctx);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Local AI failed:"), "error");
	});

	it("starts LTX video without changing the selected chat model", async () => {
		const h = localAiHarness();
		await h.command("video", h.ctx);
		expect(h.exec).toHaveBeenCalledWith(
			"ssh",
			expect.arrayContaining(["server4", "local-ai", "video"]),
			expect.anything(),
		);
		expect(h.notify).toHaveBeenCalledWith("LTX-2.5 video is ready on :8188.", "info");
		expect(h.setStatus).toHaveBeenLastCalledWith("local-ai", "Video active");
	});
});
