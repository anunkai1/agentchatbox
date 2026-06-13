/**
 * Agentchatbox client entry.
 *
 * Wires the official `@earendil-works/pi-web-ui` ChatPanel up with our
 * proxied stream function, so the agent runs in the browser but uses
 * API keys configured on the server.
 */

import { Agent, type AgentMessage, type AgentState } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import { html, render } from "lit";
import { Alert } from "@mariozechner/mini-lit/dist/Alert.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { icon } from "@mariozechner/mini-lit";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { Bell, History, Plus, Settings } from "lucide";
import {
	ApiKeyPromptDialog,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	ProvidersModelsTab,
	ProxyTab,
	SessionListDialog,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "@earendil-works/pi-web-ui";
import { proxiedStreamFn } from "./api.js";
// CSS is loaded via <link> in index.html (see scripts/build-client.mjs for the copy step).

import { SEED_CUSTOM_PROVIDERS } from "./seed-providers.js";


// =============================================================================
// Storage (browser-side IndexedDB; same pattern as the official example)
// =============================================================================

const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
];

const backend = new IndexedDBStorageBackend({
	dbName: "agentchatbox",
	version: 1,
	stores: configs,
});

settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// Seed custom providers (e.g. MiniMax M3) the first time the app loads.
// Existing user entries are preserved; missing ones are added.
async function seedProviders() {
	for (const provider of SEED_CUSTOM_PROVIDERS) {
		const existing = await customProviders.get(provider.id);
		if (!existing) {
			await customProviders.set(provider);
		}
	}
}

// =============================================================================
// State
// =============================================================================

let currentSessionId: string | undefined;
let currentTitle = "";
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;

const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg) return "";
	let text = "";
	const content = firstUserMsg.content;
	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c): c is TextContent => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}
	text = text.trim();
	if (!text) return "";
	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) return text.substring(0, sentenceEnd + 1);
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	return (
		messages.some((m) => m.role === "user") && messages.some((m) => m.role === "assistant")
	);
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;
	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;
	try {
		const sessionData = {
			id: currentSessionId,
			title: currentTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
		};
		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt: sessionData.createdAt,
			lastModified: sessionData.lastModified,
			messageCount: state.messages.length,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			modelId: state.model?.id || null,
			thinkingLevel: state.thinkingLevel,
			preview: generateTitle(state.messages),
		};
		await storage.sessions.save(sessionData, metadata);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};

const createAgent = async (initialState?: Partial<AgentState>) => {
	if (agentUnsubscribe) agentUnsubscribe();

	// Pick a default model. The user can switch in the model selector.
	const defaultModel =
		getModel("anthropic", "claude-sonnet-4-5-20250929") ?? getModel("openai", "gpt-4o");

	agent = new Agent({
		initialState: initialState || {
			systemPrompt:
				"You are a helpful AI assistant. You have access to uploaded files and images the user shares.",
			model: defaultModel,
			thinkingLevel: "off",
			messages: [],
			tools: [],
		},
		// Always go through the server proxy so API keys stay on the server.
		streamFn: proxiedStreamFn,
	});

	agentUnsubscribe = agent.subscribe((event: { type: string; state?: AgentState }) => {
		if (event.type === "state-update" && event.state) {
			const messages = event.state.messages;
			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
			}
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				updateUrl(currentSessionId);
			}
			if (currentSessionId) {
				void saveSession();
			}
			renderApp();
		}
	});

	await chatPanel.setAgent(agent, {
		onApiKeyRequired: async (provider: string) => {
			return await ApiKeyPromptDialog.prompt(provider);
		},
	});
};

const loadSession = async (sessionId: string): Promise<boolean> => {
	if (!storage.sessions) return false;
	const sessionData = await storage.sessions.get(sessionId);
	if (!sessionData) return false;
	currentSessionId = sessionId;
	const metadata = await storage.sessions.getMetadata(sessionId);
	currentTitle = metadata?.title || "";
	await createAgent({
		model: sessionData.model,
		thinkingLevel: sessionData.thinkingLevel,
		messages: sessionData.messages,
		tools: [],
	});
	updateUrl(sessionId);
	renderApp();
	return true;
};

const newSession = () => {
	const url = new URL(window.location.href);
	url.search = "";
	window.location.href = url.toString();
};

// =============================================================================
// Render
// =============================================================================

const renderApp = () => {
	const app = document.getElementById("app");
	if (!app) return;

	const appHtml = html`
		<div class="w-full h-screen flex flex-col bg-background text-foreground overflow-hidden">
			<div class="flex items-center justify-between border-b border-border shrink-0 px-2 py-1">
				<div class="flex items-center gap-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SessionListDialog.open(
								async (sessionId) => {
									await loadSession(sessionId);
								},
								(deletedSessionId) => {
									if (deletedSessionId === currentSessionId) newSession();
								},
							);
						},
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "New Session",
					})}
					${currentTitle
						? html`<span class="px-2 py-1 text-sm text-foreground">${currentTitle}</span>`
						: html`<span class="px-2 py-1 text-sm font-semibold text-foreground">agentchatbox</span>`}
				</div>
				<div class="flex items-center gap-1 px-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Bell, "sm"),
						onClick: () => {
							Alert({
								variant: "default",
								children: html`<div class="text-xs">agentchatbox · LLM calls proxied through the server</div>`,
							});
						},
						title: "About",
					})}
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () => SettingsDialog.open([new ProvidersModelsTab(), new ProxyTab()]),
						title: "Settings",
					})}
				</div>
			</div>
			${chatPanel}
		</div>
	`;
	render(appHtml, app);
};

// =============================================================================
// Init
// =============================================================================

async function initApp() {
	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	render(
		html`
			<div class="w-full h-screen flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading agentchatbox…</div>
			</div>
		`,
		app,
	);

	chatPanel = new ChatPanel();

	await seedProviders();

	const urlParams = new URLSearchParams(window.location.search);
	const sessionIdFromUrl = urlParams.get("session");

	if (sessionIdFromUrl) {
		const loaded = await loadSession(sessionIdFromUrl);
		if (!loaded) {
			newSession();
			return;
		}
	} else {
		await createAgent();
	}

	renderApp();
}

initApp();
