/**
 * Voice note transcription.
 *
 * Accepts a multipart audio upload, sends it to OpenAI's Whisper API, and
 * returns the transcript. The browser then sends the transcript as a
 * regular text prompt to the agent.
 *
 * If no OpenAI key is configured, returns 501 with a clear message so the
 * client can fall back gracefully.
 */

import { Router } from "express";
import express from "express";
import multer from "multer";
import { config } from "./config.js";
import type { TranscribeResponse } from "../shared/protocol.js";

const upload = multer({
	storage: multer.memoryStorage(),
	limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB cap on audio
});

export function createTranscribeRouter(): Router {
	const router = express.Router();

	router.post("/", upload.single("audio"), async (req, res) => {
		if (!config.openaiApiKey) {
			res.status(501).json({
				error: "voice transcription is not configured (set OPENAI_API_KEY on the server)",
			});
			return;
		}

		const file = (req as express.Request & { file?: Express.Multer.File }).file;
		if (!file) {
			res.status(400).json({ error: "no audio uploaded (field name: 'audio')" });
			return;
		}

		// Build a multipart/form-data body for the Whisper API.
		const form = new FormData();
		const blob = new Blob([new Uint8Array(file.buffer)], { type: file.mimetype || "audio/webm" });
		form.append("file", blob, file.originalname || "voice.webm");
		form.append("model", "whisper-1");
		form.append("response_format", "json");

		try {
			const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
				method: "POST",
				headers: { Authorization: `Bearer ${config.openaiApiKey}` },
				body: form,
			});

			if (!upstream.ok) {
				const text = await upstream.text();
				res.status(upstream.status).json({ error: `whisper: ${text}` });
				return;
			}

			const data = (await upstream.json()) as { text?: string };
			const response: TranscribeResponse = { text: data.text ?? "" };
			res.json(response);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			res.status(502).json({ error: `transcription failed: ${message}` });
		}
	});

	return router;
}
