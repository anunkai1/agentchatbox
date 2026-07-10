/**
 * rewriteUploadUrls — rewrites /uploads/<file> web URLs in prompt text.
 *
 * The image case is load-bearing: an attached image is delivered BOTH as a
 * structured `images` block (base64) AND as a markdown link in the text.
 * Leaving the link as a readable on-disk path makes pi's multimodal-proxy
 * re-read the same file and analyze it twice ("Analyzing 2 images" for one
 * attachment). When structured bytes are present, the image link must
 * collapse to a bare label with no path. Non-image files keep the path
 * rewrite so pi's `read` tool can open them.
 */
import { describe, expect, it } from "vitest";
import { rewriteUploadUrls } from "../src/server/chat.js";

describe("rewriteUploadUrls", () => {
	it("rewrites non-image file links to an absolute filesystem path", () => {
		const out = rewriteUploadUrls("[file: data.csv](/uploads/abc.csv)", false);
		// Path is rewritten (not stripped) so pi's read tool can open it.
		expect(out).toMatch(/\[file: data\.csv\]\(.+\/abc\.csv\)$/);
		expect(out).not.toContain("(/uploads/abc.csv)");
	});

	it("collapses an image link to a bare label when structured bytes are present", () => {
		const out = rewriteUploadUrls("[image: photo.png](/uploads/abc.png)", true);
		expect(out).toBe("[image: photo.png]");
		// No readable path survives — the proxy must not re-read the file.
		expect(out).not.toContain("/uploads/");
		expect(out).not.toContain(".png)");
	});

	it("still rewrites an image link to a path when NO structured bytes are present (manual/quoted URL)", () => {
		// Edge case: user types an old /uploads/ image URL with no fresh
		// attachment. There are no structured bytes, so the path must stay
		// readable so the proxy (or read tool) can still load it.
		const out = rewriteUploadUrls("[image: photo.png](/uploads/abc.png)", false);
		expect(out).toMatch(/\[image: photo\.png\]\(.+\/abc\.png\)$/);
	});

	it("handles multiple image extensions and mixed image/file links", () => {
		const text =
			"here is a pic [image: a.png](/uploads/u1.png) " +
			"and a doc [file: notes.txt](/uploads/u2.txt) " +
			"and another [image: b.jpeg](/uploads/u3.jpeg)";
		const out = rewriteUploadUrls(text, true);
		// Both image links collapse to bare labels with no readable path.
		expect(out).toContain("[image: a.png]");
		expect(out).toContain("[image: b.jpeg]");
		expect(out).not.toContain("/uploads/u1.png");
		expect(out).not.toContain("/uploads/u3.jpeg");
		// The non-image file link is rewritten to a real (non-/uploads/) path
		// so pi's read tool can open it.
		expect(out).toMatch(/\[file: notes\.txt\]\([^)]+u2\.txt\)/);
		expect(out).not.toContain("(/uploads/u2.txt)");
	});

	it("leaves text without upload links untouched", () => {
		expect(rewriteUploadUrls("just a normal message", true)).toBe("just a normal message");
	});
});
