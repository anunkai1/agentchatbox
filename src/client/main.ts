/**
 * agentchatbox client entry.
 *
 * Minimal chat UI: text in, text out, with a model picker and thinking
 * level. Talks to the Node server which proxies LLM calls. No web UI
 * framework — vanilla DOM, small bundle, easy to read.
 */

import { Agent, type AgentMessage, type AgentState } from "@earendil-works/pi-agent-core";
import { getModel, type TextContent } from "@earendil-works/pi-ai";
import { proxiedStreamFn, transcribeAudio, uploadFile } from "./api.js";
import {
	SEED_CUSTOM_PROVIDERS,
	listAvailableModels,
} from "./seed-providers.js";

// -----------------------------------------------------------------------------
// Storage (sessions + per-provider keys in IndexedDB)
// -----------------------------------------------------------------------------

const DB_NAME = "agentchatbox";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains("sessions")) {
				const s = db.createObjectStore("sessions", { keyPath: "id" });
				s.createIndex("byLastModified", "lastModified");
			}
			if (!db.objectStoreNames.contains("provider-keys")) {
				db.createObjectStore("provider-keys");
			}
			if (!db.objectStoreNames.contains("custom-providers")) {
				db.createObjectStore("custom-providers", { keyPath: "id" });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function dbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(store, "readonly");
		const req = tx.objectStore(store).get(key);
		req.onsuccess = () => { db.close(); resolve(req.result as T | undefined); };
		req.onerror = () => { db.close(); reject(req.error); };
	});
}

async function dbPut(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(store, "readwrite");
		const req = key !== undefined ? tx.objectStore(store).put(value, key) : tx.objectStore(store).put(value);
		req.onsuccess = () => { db.close(); resolve(); };
		req.onerror = () => { db.close(); reject(req.error); };
	});
}

async function dbGetAll<T>(store: string): Promise<T[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(store, "readonly");
		const req = tx.objectStore(store).getAll();
		req.onsuccess = () => { db.close(); resolve(req.result as T[]); };
		req.onerror = () => { db.close(); reject(req.error); };
	});
}

async function getApiKey(provider: string): Promise<string | undefined> {
	const v = await dbGet<string>("provider-keys", provider);
	return v && v.length > 0 ? v : undefined;
}

async function setApiKey(provider: string, key: string): Promise<void> {
	return dbPut("provider-keys", key, provider);
}

interface CustomProviderRecord {
	id: string;
	name: string;
	type: string;
	baseUrl: string;
	apiKey?: string;
	models?: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: string[] }>;
}

async function getCustomProviders(): Promise<CustomProviderRecord[]> {
	return dbGetAll<CustomProviderRecord>("custom-providers");
}

async function setCustomProvider(provider: CustomProviderRecord): Promise<void> {
	return dbPut("custom-providers", provider);
}

async function seedProviders(): Promise<void> {
	for (const p of SEED_CUSTOM_PROVIDERS) {
		const existing = (await getCustomProviders()).find((x) => x.id === p.id);
		if (!existing) {
			await setCustomProvider(p as CustomProviderRecord);
		}
	}
}

interface SessionRecord {
	id: string;
	title: string;
	modelId: string;
	provider: string;
	thinkingLevel: string;
	messages: AgentMessage[];
	createdAt: string;
	lastModified: string;
}

async function saveSession(s: SessionRecord): Promise<void> {
	return dbPut("sessions", s);
}

async function listSessions(): Promise<SessionRecord[]> {
	const all = await dbGetAll<SessionRecord>("sessions");
	return all.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

type ModelOption = { id: string; name: string; provider: string; baseUrl?: string };

let agent: Agent;
let currentSessionId: string | undefined;
let currentTitle = "New chat";
let availableModels: ModelOption[] = [];
let isStreaming = false;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const elApp = () => $<HTMLDivElement>("#app");
const elMessages = () => $<HTMLDivElement>("#messages");
const elInput = () => $<HTMLTextAreaElement>("#input");
const elSendBtn = () => $<HTMLButtonElement>("#send");
const elStopBtn = () => $<HTMLButtonElement>("#stop");
const elModelBtn = () => $<HTMLButtonElement>("#model-picker");
const elThinkBtn = () => $<HTMLButtonElement>("#think-picker");
const elTitle = () => $<HTMLSpanElement>("#title");

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> & { class?: string; html?: string; text?: string } = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === "class") (node as HTMLElement).className = v as string;
		else if (k === "html") (node as HTMLElement).innerHTML = v as string;
		else if (k === "text") (node as HTMLElement).textContent = v as string;
		else (node as unknown as Record<string, unknown>)[k] = v;
	}
	for (const c of children) node.append(c);
	return node;
}

function renderShell(): void {
	elApp().innerHTML = `
		<div class="header">
			<button id="new-chat" class="icon-btn" title="New chat">+</button>
			<button id="sessions" class="icon-btn" title="Sessions">≡</button>
			<span id="title">${currentTitle}</span>
			<div class="spacer"></div>
			<button id="model-picker" class="picker-btn">…</button>
			<button id="think-picker" class="picker-btn">…</button>
		</div>
		<div id="messages" class="messages"></div>
		<div class="composer">
			<button id="attach" class="icon-btn" title="Attach file">📎</button>
			<button id="voice" class="icon-btn" title="Voice note">🎙</button>
			<textarea id="input" rows="1" placeholder="Message agentchatbox… (Enter to send, Shift+Enter for newline)"></textarea>
			<button id="send" class="send-btn">Send</button>
			<button id="stop" class="stop-btn" hidden>Stop</button>
		</div>
		<input type="file" id="file-input" hidden multiple />
	`;

	$("#send").addEventListener("click", sendMessage);
	$("#stop").addEventListener("click", () => agent?.abort());
	$("#input").addEventListener("keydown", (e) => {
		const ke = e as KeyboardEvent;
		if (ke.key === "Enter" && !ke.shiftKey) {
			ke.preventDefault();
			sendMessage();
		}
	});
	$("#input").addEventListener("input", autoSize);
	$("#new-chat").addEventListener("click", newChat);
	$("#sessions").addEventListener("click", openSessionsDialog);
	$("#model-picker").addEventListener("click", openModelPicker);
	$("#think-picker").addEventListener("click", openThinkPicker);
	$("#attach").addEventListener("click", () => $<HTMLInputElement>("#file-input").click());
	$("#file-input").addEventListener("change", handleFileAttach);
	$("#voice").addEventListener("click", handleVoiceRecord);
}

function autoSize(): void {
	const ta = elInput();
	ta.style.height = "auto";
	ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
}

function setStreaming(s: boolean): void {
	isStreaming = s;
	elSendBtn().hidden = s;
	elStopBtn().hidden = !s;
	elInput().disabled = s;
}

function messageNode(m: AgentMessage): HTMLElement {
	const wrap = el("div", { class: `msg msg-${m.role}` });
	wrap.dataset.role = m.role;

	const role = el("div", { class: "msg-role" }, m.role);
	wrap.append(role);

	const body = el("div", { class: "msg-body" });
	if (m.role === "user") {
		body.textContent = typeof m.content === "string" ? m.content : extractText(m.content);
	} else if (m.role === "assistant") {
		body.textContent = extractText(m.content);
	} else if (m.role === "toolResult") {
		const text = extractText(m.content);
		body.classList.add("tool");
		body.textContent = text.slice(0, 2000);
	}
	wrap.append(body);
	return wrap;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c: { type: string; text?: string; thinking?: string }) => {
			if (c.type === "text") return c.text ?? "";
			if (c.type === "thinking") return c.thinking ?? "";
			if (c.type === "image") return "[image]";
			if (c.type === "toolCall") return `[tool call: ${(c as { name?: string }).name ?? "?"}]`;
			return "";
		})
		.join("");
}

function renderAllMessages(): void {
	const list = elMessages();
	list.innerHTML = "";
	for (const m of agent.state.messages) {
		list.append(messageNode(m));
	}
	scrollToBottom();
}

function renderLatestAssistant(): void {
	// Streaming case: just update the last assistant message node.
	const list = elMessages();
	const msgs = agent.state.messages;
	const last = msgs[msgs.length - 1];
	if (!last || last.role !== "assistant") return;
	let node = list.querySelector(":scope > .msg-assistant:last-of-type") as HTMLElement | null;
	if (!node) {
		node = messageNode(last);
		list.append(node);
	} else {
		const body = node.querySelector(".msg-body") as HTMLElement;
		body.textContent = extractText(last.content);
	}
	scrollToBottom();
}

function scrollToBottom(): void {
	const list = elMessages();
	list.scrollTop = list.scrollHeight;
}

// -----------------------------------------------------------------------------
// Title / session persistence
// -----------------------------------------------------------------------------

function generateTitle(messages: AgentMessage[]): string {
	const first = messages.find((m) => m.role === "user");
	if (!first) return "New chat";
	let text = typeof first.content === "string" ? first.content : extractText(first.content);
	text = text.trim();
	if (!text) return "New chat";
	const end = text.search(/[.!?\n]/);
	if (end > 0 && end <= 50) return text.slice(0, end);
	return text.length <= 50 ? text : text.slice(0, 47) + "…";
}

async function maybeSaveSession(): Promise<void> {
	if (!agent) return;
	const msgs = agent.state.messages;
	if (msgs.length < 2) return;
	if (!currentSessionId) currentSessionId = crypto.randomUUID();
	if (currentTitle === "New chat" || !currentTitle) {
		currentTitle = generateTitle(msgs);
		elTitle().textContent = currentTitle;
	}
	const state = agent.state;
	if (!state.model) return;
	const record: SessionRecord = {
		id: currentSessionId,
		title: currentTitle,
		modelId: state.model.id,
		provider: state.model.provider,
		thinkingLevel: state.thinkingLevel,
		messages: msgs,
		createdAt: new Date().toISOString(),
		lastModified: new Date().toISOString(),
	};
	await saveSession(record);
}

// -----------------------------------------------------------------------------
// Agent lifecycle
// -----------------------------------------------------------------------------

async function pickDefaultModel(): Promise<ModelOption | undefined> {
	// Prefer MiniMax M3 from custom providers, then built-in fallbacks.
	const custom = await getCustomProviders();
	const minimax = custom.find((p) => p.id === "minimax");
	if (minimax?.models) {
		const m3 = minimax.models.find((m) => m.id === "MiniMax-M3");
		if (m3) return { id: m3.id, name: m3.name ?? m3.id, provider: "minimax", baseUrl: minimax.baseUrl };
	}
	const sonnet = getModel("anthropic", "claude-sonnet-4-5-20250929");
	if (sonnet) return { id: sonnet.id, name: sonnet.name, provider: sonnet.provider, baseUrl: sonnet.baseUrl };
	const gpt = getModel("openai", "gpt-4o");
	if (gpt) return { id: gpt.id, name: gpt.name, provider: gpt.provider, baseUrl: gpt.baseUrl };
	return undefined;
}

async function resolveModel(id: string, provider: string): Promise<ModelOption | undefined> {
	// Look in custom providers first.
	const custom = await getCustomProviders();
	for (const p of custom) {
		const m = p.models?.find((x) => x.id === id);
		if (m) return { id: m.id, name: m.name ?? m.id, provider, baseUrl: p.baseUrl };
	}
	// Fall back to built-in registry.
	const built = getModel(provider as never, id as never);
	if (built) return { id: built.id, name: built.name, provider: built.provider, baseUrl: built.baseUrl };
	return undefined;
}

async function createAgent(): Promise<void> {
	const model = await pickDefaultModel();
	if (!model) {
		alert("No model available. Check your providers.");
		return;
	}
	const modelObj = await resolveModel(model.id, model.provider);
	if (!modelObj) {
		alert("Could not resolve model: " + model.id);
		return;
	}
	agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful AI assistant with access to uploaded files and images the user shares.",
			model: {
				id: modelObj.id,
				name: modelObj.name,
				api: "anthropic-messages",
				provider: modelObj.provider,
				baseUrl: modelObj.baseUrl ?? "",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 32_000,
			},
			thinkingLevel: "off",
			messages: [],
			tools: [],
		},
		streamFn: proxiedStreamFn,
		getApiKey: async (provider: string) => (await getApiKey(provider)) ?? undefined,
	});

	agent.subscribe((event) => {
		if (event.type === "message_update") {
			renderLatestAssistant();
		} else if (event.type === "message_start" || event.type === "message_end") {
			renderAllMessages();
			void maybeSaveSession();
		} else if (event.type === "agent_end") {
			setStreaming(false);
			renderAllMessages();
			void maybeSaveSession();
		} else if (event.type === "agent_start") {
			setStreaming(true);
		} else if (event.type === "turn_start" || event.type === "turn_end") {
			renderAllMessages();
		}
	});
}

function updateModelLabel(): void {
	const m = agent?.state.model;
	if (!m) return;
	elModelBtn().textContent = m.id;
	elThinkBtn().textContent = `think: ${agent.state.thinkingLevel}`;
}

// -----------------------------------------------------------------------------
// Send / receive
// -----------------------------------------------------------------------------

async function sendMessage(): Promise<void> {
	if (isStreaming) return;
	const ta = elInput();
	const text = ta.value.trim();
	if (!text) return;
	ta.value = "";
	autoSize();
	setStreaming(true);
	try {
		// agent.prompt() handles appending the user message; we just re-render
		// when the agent emits message_start.
		await agent.prompt(text);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		showError(msg);
		setStreaming(false);
	}
}

function showError(text: string): void {
	const list = elMessages();
	const node = el("div", { class: "msg msg-error" }, `Error: ${text}`);
	list.append(node);
	scrollToBottom();
}

function newChat(): void {
	if (!confirm("Start a new chat? Current conversation will be saved.")) return;
	currentSessionId = undefined;
	currentTitle = "New chat";
	createAgent().then(() => {
		renderShell();
		renderAllMessages();
		updateModelLabel();
	});
}

async function openSessionsDialog(): Promise<void> {
	const all = await listSessions();
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box" });
	box.append(el("h3", { text: "Sessions" }));
	if (all.length === 0) {
		box.append(el("p", { class: "muted", text: "No saved sessions yet." }));
	} else {
		for (const s of all) {
			const row = el("div", { class: "session-row" });
			row.append(el("div", { class: "session-title" }, s.title));
			row.append(el("div", { class: "session-meta" }, `${s.messages.length} msgs · ${s.modelId}`));
			row.addEventListener("click", () => {
				loadSession(s.id);
				document.body.removeChild(overlay);
			});
			box.append(row);
		}
	}
	const closeBtn = el("button", { class: "btn", text: "Close" });
	closeBtn.addEventListener("click", () => document.body.removeChild(overlay));
	box.append(closeBtn);
	overlay.append(box);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) document.body.removeChild(overlay);
	});
	document.body.append(overlay);
}

async function loadSession(id: string): Promise<void> {
	const all = await listSessions();
	const s = all.find((x) => x.id === id);
	if (!s) return;
	currentSessionId = s.id;
	currentTitle = s.title;
	const modelObj = await resolveModel(s.modelId, s.provider);
	if (!modelObj) {
		alert("Model for this session is not available: " + s.modelId);
		return;
	}
	agent = new Agent({
		initialState: {
			systemPrompt: "You are a helpful AI assistant with access to uploaded files and images the user shares.",
			model: {
				id: modelObj.id,
				name: modelObj.name,
				api: "anthropic-messages",
				provider: modelObj.provider,
				baseUrl: modelObj.baseUrl ?? "",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 32_000,
			},
			thinkingLevel: (s.thinkingLevel as never) ?? "off",
			messages: s.messages,
			tools: [],
		},
		streamFn: proxiedStreamFn,
		getApiKey: async (provider: string) => (await getApiKey(provider)) ?? undefined,
	});
	attachAgentListeners();
	renderShell();
	renderAllMessages();
	updateModelLabel();
	elTitle().textContent = currentTitle;
}

function attachAgentListeners(): void {
	agent.subscribe((event) => {
		if (event.type === "message_update") {
			renderLatestAssistant();
		} else if (event.type === "message_start" || event.type === "message_end") {
			renderAllMessages();
			void maybeSaveSession();
		} else if (event.type === "agent_end") {
			setStreaming(false);
			renderAllMessages();
			void maybeSaveSession();
		} else if (event.type === "agent_start") {
			setStreaming(true);
		} else if (event.type === "turn_start" || event.type === "turn_end") {
			renderAllMessages();
		}
	});
}

// -----------------------------------------------------------------------------
// Model & thinking pickers
// -----------------------------------------------------------------------------

async function openModelPicker(): Promise<void> {
	availableModels = await listAvailableModels();
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box" });
	box.append(el("h3", { text: "Choose model" }));
	for (const m of availableModels) {
		const row = el("div", { class: "model-row" });
		row.append(el("div", { class: "model-name" }, m.name));
		row.append(el("div", { class: "model-provider" }, m.provider));
		if (m.id === agent?.state.model?.id) row.classList.add("active");
		row.addEventListener("click", async () => {
			const m2 = await resolveModel(m.id, m.provider);
			if (!m2) return;
			agent.state.model = {
				id: m2.id,
				name: m2.name,
				api: "anthropic-messages",
				provider: m2.provider,
				baseUrl: m2.baseUrl ?? "",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 32_000,
			};
			updateModelLabel();
			document.body.removeChild(overlay);
		});
		box.append(row);
	}
	box.append(buildApiKeySection("anthropic"));
	box.append(buildApiKeySection("minimax"));
	box.append(buildApiKeySection("openai"));
	box.append(buildApiKeySection("deepseek"));
	const close = el("button", { class: "btn", text: "Close" });
	close.addEventListener("click", () => document.body.removeChild(overlay));
	box.append(close);
	overlay.append(box);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) document.body.removeChild(overlay);
	});
	document.body.append(overlay);
}

function buildApiKeySection(provider: string): HTMLElement {
	const sec = el("div", { class: "apikey-section" });
	sec.append(el("label", { text: `${provider} API key (browser override)` }));
	const row = el("div", { class: "apikey-row" });
	const input = el("input", { type: "password", placeholder: "sk-… (leave empty to use server env key)" }) as HTMLInputElement;
	getApiKey(provider).then((v) => { input.value = v ?? ""; });
	const save = el("button", { class: "btn", text: "Save" });
	save.addEventListener("click", async () => {
		const v = input.value.trim();
		if (v) await setApiKey(provider, v);
		else await dbPut("provider-keys", undefined, provider).catch(() => {});
		(input.parentElement!.querySelector(".apikey-status") as HTMLElement).textContent = v ? "Saved" : "Cleared";
	});
	sec.append(row);
	row.append(input, save);
	sec.append(el("span", { class: "apikey-status muted" }));
	return sec;
}

function openThinkPicker(): void {
	const levels = ["off", "minimal", "low", "medium", "high"];
	const overlay = el("div", { class: "modal-overlay" });
	const box = el("div", { class: "modal-box" });
	box.append(el("h3", { text: "Thinking level" }));
	for (const lvl of levels) {
		const row = el("div", { class: "model-row" });
		row.append(el("div", { class: "model-name" }, lvl));
		if (lvl === agent?.state.thinkingLevel) row.classList.add("active");
		row.addEventListener("click", () => {
			agent.state.thinkingLevel = lvl as never;
			updateModelLabel();
			document.body.removeChild(overlay);
		});
		box.append(row);
	}
	const close = el("button", { class: "btn", text: "Close" });
	close.addEventListener("click", () => document.body.removeChild(overlay));
	box.append(close);
	overlay.append(box);
	overlay.addEventListener("click", (e) => {
		if (e.target === overlay) document.body.removeChild(overlay);
	});
	document.body.append(overlay);
}

// -----------------------------------------------------------------------------
// Attachments (file upload + voice)
// -----------------------------------------------------------------------------

async function handleFileAttach(e: Event): Promise<void> {
	const input = e.target as HTMLInputElement;
	const files = input.files;
	if (!files || files.length === 0) return;
	const ta = elInput();
	for (const file of Array.from(files)) {
		try {
			const res = await uploadFile(file);
			const insertion = res.mimeType.startsWith("image/")
				? `\n[attached image: ${res.filename}](${res.url})`
				: `\n[attached file: ${res.filename} (${res.url})]`;
			ta.value = (ta.value + " " + insertion).trim();
			autoSize();
		} catch (err) {
			showError(err instanceof Error ? err.message : String(err));
		}
	}
	input.value = "";
}

let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recordingStart = 0;

async function handleVoiceRecord(): Promise<void> {
	if (mediaRecorder && mediaRecorder.state === "recording") {
		mediaRecorder.stop();
		return;
	}
	try {
		const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		recordedChunks = [];
		mediaRecorder = new MediaRecorder(stream);
		mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
		mediaRecorder.onstop = async () => {
			stream.getTracks().forEach((t) => t.stop());
			const blob = new Blob(recordedChunks, { type: "audio/webm" });
			const secs = (Date.now() - recordingStart) / 1000;
			showError(`Transcribing ${secs.toFixed(1)}s of audio…`);
			try {
				const text = await transcribeAudio(blob);
				const ta = elInput();
				ta.value = (ta.value + " " + text).trim();
				autoSize();
			} catch (err) {
				showError("Transcription failed: " + (err instanceof Error ? err.message : String(err)));
			}
		};
		recordingStart = Date.now();
		mediaRecorder.start();
		$<HTMLButtonElement>("#voice").textContent = "⏹";
		showError("Recording… click again to stop");
	} catch (err) {
		showError("Microphone access denied: " + (err instanceof Error ? err.message : String(err)));
	}
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

async function boot(): Promise<void> {
	elApp().innerHTML = `<div class="loading">Loading agentchatbox…</div>`;
	await seedProviders();
	renderShell();
	await createAgent();
	renderAllMessages();
	updateModelLabel();
}

boot().catch((err) => {
	elApp().innerHTML = `<div class="loading">Failed to boot: ${err instanceof Error ? err.message : String(err)}</div>`;
});
