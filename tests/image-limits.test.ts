import { constants } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	MAX_PI_RPC_LINE_CHARS,
	MAX_PROMPT_IMAGE_BYTES,
	MAX_PROMPT_IMAGE_TOTAL_BYTES,
	MAX_PROMPT_IMAGES,
} from "../src/shared/limits.js";

describe("image transport budget", () => {
	it("allows 25 MiB per image, 300 MiB combined and at most 20 images", () => {
		expect(MAX_PROMPT_IMAGE_BYTES).toBe(25 * 1024 * 1024);
		expect(MAX_PROMPT_IMAGE_TOTAL_BYTES).toBe(300 * 1024 * 1024);
		expect(MAX_PROMPT_IMAGES).toBe(20);
	});

	it("fits base64, escaped prompt text and metadata below the RPC and Node string limits", () => {
		// Arithmetic only: do not allocate a hundreds-of-MiB regression fixture.
		// Each separately encoded image can add padding. A prompt may contain
		// one million characters, each requiring six JSON characters (\\u0000).
		const base64Chars = Math.ceil(MAX_PROMPT_IMAGE_TOTAL_BYTES / 3) * 4 + 4 * MAX_PROMPT_IMAGES;
		const escapedPromptChars = 6 * 1_000_000;
		const metadataHeadroom = 1024 * 1024;
		expect(base64Chars + escapedPromptChars + metadataHeadroom).toBeLessThan(MAX_PI_RPC_LINE_CHARS);
		expect(MAX_PI_RPC_LINE_CHARS).toBeLessThan(constants.MAX_STRING_LENGTH);
	});
});
