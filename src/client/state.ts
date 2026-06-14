/**
 * In-memory app state, persisted message types, and the IndexedDB layer
 * for session titles + transcripts. Owned by main.ts at boot, mutated
 * by every other module via the exported `state` singleton.
 */

import type { ThinkingLevel } from "../shared/protocol.js";
import { uuid } from "./dom.js";

const DB_NAME = "agentchatbox";
const DB_VERSION = 2; // bumped: removed provider-keys, custom-providers

export interface SessionRecord {
	id: string;
	title: string;
	modelId: string;
	provider: string;
	thinkingLevel: ThinkingLevel;
	messages: Array<Record<string, unknown>>;
	createdAt: string;
	lastModified: string;
}

export function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains("sessions")) {
				const s = db.createObjectStore("sessions", { keyPath: "id" });
				s.createIndex("byLastModified", "lastModified");
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export async function dbAllSessions(): Promise<SessionRecord[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction("sessions", "readonly");
		const req = tx.objectStore("sessions").getAll();
		req.onsuccess = () => {
			db.close();
			const all = req.result as SessionRecord[];
			resolve(all.sort((a, b) => b.lastModified.localeCompare(a.lastModified)));
		};
		req.onerror = () => {
			db.close();
			reject(req.error);
		};
	});
}

export async function dbSaveSession(rec: SessionRecord): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction("sessions", "readwrite");
		tx.objectStore("sessions").put(rec);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
	});
}

export async function dbDeleteSession(id: string): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction("sessions", "readwrite");
		tx.objectStore("sessions").delete(id);
		tx.oncomplete = () => {
			db.close();
			resolve();
		};
		tx.onerror = () => {
			db.close();
			reject(tx.error);
		};
	});
}

// ---------------------------------------------------------------------------
// Session state (in-memory)
// ---------------------------------------------------------------------------

export interface AppState {
	sessionId: string;
	title: string;
	messages: PersistedMessage[];
	historyIdx: number | null; // null = at the "now" position
	history: string[]; // user prompts typed in this session
	isStreaming: boolean;
	toolSpinner: HTMLElement | null;
	costTotal: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	availableModels: ModelOption[];
	currentModelId: string | null;
	currentProvider: string | null;
	currentThinking: ThinkingLevel;
	/**
	 * The model id the user just clicked in the picker. The server will
	 * confirm it on the next `ready` event. Set to the model id at click
	 * time, cleared when the matching `ready` arrives. Used to distinguish
	 * "user picked this" from "server just connected and is reporting its
	 * default" — we only adopt the server-reported model if either we
	 * have no model displayed yet, or the server is confirming our pick.
	 */
	pendingModelSet: string | null;
	/**
	 * Map of uploaded image URL → base64 data + mime + filename. Populated
	 * when the user attaches an image via the file picker, consumed when
	 * they send a prompt that references the URL. Used to pass image
	 * bytes to the model so multimodal models (e.g. minimax M3) can see
	 * the picture, not just the markdown link.
	 */
	uploadedImages: Map<string, { data: string; mimeType: string; filename: string }>;
	connectionStatus: "connecting" | "open" | "closed";
	/** When true, every final assistant message is spoken automatically. */
	autoSpeak: boolean;
	/** Currently selected TTS voice id. */
	ttsVoice: string | null;
	/** Number of TTS requests in flight (for the status bar indicator). */
	ttsInFlight: number;
	/** Set true while audio is playing (for the play/pause indicator). */
	audioPlaying: boolean;
	/**
	 * Plain string snapshot of `state.messages` last assistant text, kept
	 * in sync by main.ts's event dispatcher. The render layer reads this
	 * for the live-streaming speak button (so re-clicking after streaming
	 * ends replays the final text) without needing a back-reference into
	 * the messages array.
	 */
	lastAssistantText: string;
}

export type PersistedMessage =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; thinking: string; spoken?: boolean }
	| { kind: "tool"; name: string; args: unknown; result?: string; isError?: boolean }
	| { kind: "error"; text: string };

export interface ModelOption {
	id: string;
	provider: string;
	/** Human-readable label from the server (e.g. "DeepSeek V4 Pro"). */
	name?: string;
	/** Whether this model supports extended thinking. */
	reasoning?: boolean;
}

export const state: AppState = {
	sessionId: uuid(),
	title: "New chat",
	messages: [],
	historyIdx: null,
	history: [],
	isStreaming: false,
	toolSpinner: null,
	costTotal: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	availableModels: [],
	currentModelId: null,
	currentProvider: null,
	currentThinking: "high",
	pendingModelSet: null,
	uploadedImages: new Map(),
	connectionStatus: "connecting",
	autoSpeak: false,
	ttsVoice: null,
	ttsInFlight: 0,
	audioPlaying: false,
	lastAssistantText: "",
};
