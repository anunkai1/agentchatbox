import { describe, expect, it } from "vitest";
import { matchUploadVideoUrl } from "../src/client/linkify.js";

describe("matchUploadVideoUrl", () => {
	it("accepts safe /uploads video paths for mp4, webm, and mov", () => {
		expect(matchUploadVideoUrl("/uploads/clip.mp4")).toBe("/uploads/clip.mp4");
		expect(matchUploadVideoUrl(" /uploads/colab-20261120-a1b2c3.WEBM ")).toBe(
			"/uploads/colab-20261120-a1b2c3.WEBM",
		);
		expect(matchUploadVideoUrl("/uploads/take_1.mov")).toBe("/uploads/take_1.mov");
	});

	it("rejects non-video files, query strings, external URLs, and traversal", () => {
		expect(matchUploadVideoUrl("/uploads/pic.png")).toBeNull();
		expect(matchUploadVideoUrl("/uploads/clip.mp4?autoplay=1")).toBeNull();
		expect(matchUploadVideoUrl("/uploads/../secret.mp4")).toBeNull();
		expect(matchUploadVideoUrl("https://example.com/uploads/clip.mp4")).toBeNull();
		expect(matchUploadVideoUrl(null)).toBeNull();
	});
});
