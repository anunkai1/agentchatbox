import type { ClientMessage, PromptImage, ThinkingLevel } from "../shared/protocol.js";

const MAX_PROMPT_CHARS = 1_000_000;
const MAX_INSTRUCTIONS_CHARS = 256_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_IMAGES = 8;
const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_RE = /^[^\s\p{Cc}]{1,256}$/u;
const MIME_RE = /^image\/[A-Za-z0-9.+-]{1,64}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class ProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProtocolError";
	}
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ProtocolError("message must be a JSON object");
	}
	return value as Record<string, unknown>;
}

function string(value: unknown, field: string, max: number, allowEmpty = false): string {
	if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0)) {
		throw new ProtocolError(`${field} must be a string of at most ${max} characters`);
	}
	return value;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
	return value === undefined ? undefined : string(value, field, max, true);
}

function identifier(value: unknown, field: string): string {
	const result = string(value, field, 128);
	if (!ID_RE.test(result)) throw new ProtocolError(`${field} has an invalid format`);
	return result;
}

function thinking(value: unknown): ThinkingLevel {
	if (typeof value !== "string" || !THINKING_LEVELS.has(value as ThinkingLevel)) {
		throw new ProtocolError("invalid thinking level");
	}
	return value as ThinkingLevel;
}

function nullableModel(value: unknown, field: string): string | null | undefined {
	if (value === undefined || value === null) return value;
	const result = string(value, field, 256);
	if (!MODEL_RE.test(result)) throw new ProtocolError(`${field} has an invalid format`);
	return result;
}

function nullableProvider(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return value;
	const result = string(value, "defaultProvider", 64);
	if (!PROVIDER_RE.test(result)) throw new ProtocolError("defaultProvider has an invalid format");
	return result;
}

function nullableThinking(value: unknown): ThinkingLevel | null | undefined {
	return value === undefined || value === null ? value : thinking(value);
}

function images(value: unknown): PromptImage[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length > MAX_IMAGES) {
		throw new ProtocolError(`images must be an array of at most ${MAX_IMAGES} entries`);
	}
	return value.map((entry, index) => {
		const img = object(entry);
		const data = string(img.data, `images[${index}].data`, MAX_IMAGE_BASE64_CHARS);
		const mimeType = string(img.mimeType, `images[${index}].mimeType`, 70);
		if (!MIME_RE.test(mimeType) || mimeType.toLowerCase() === "image/svg+xml") {
			throw new ProtocolError(`images[${index}].mimeType is not supported`);
		}
		if (!BASE64_RE.test(data) || Buffer.byteLength(data, "base64") > MAX_IMAGE_BYTES) {
			throw new ProtocolError(`images[${index}].data is not valid bounded base64`);
		}
		return { data, mimeType };
	});
}

function projectDefaults(msg: Record<string, unknown>) {
	return {
		defaultModelId: nullableModel(msg.defaultModelId, "defaultModelId"),
		defaultProvider: nullableProvider(msg.defaultProvider),
		defaultThinkingLevel: nullableThinking(msg.defaultThinkingLevel),
	};
}

/** Parse, bound, and clone an untrusted browser message. */
export function parseClientMessage(value: unknown): ClientMessage {
	const msg = object(value);
	const type = string(msg.type, "type", 64);
	switch (type) {
		case "init": {
			const provider = string(msg.provider, "provider", 64);
			const modelId = string(msg.modelId, "modelId", 256);
			if (!PROVIDER_RE.test(provider)) throw new ProtocolError("provider has an invalid format");
			if (!MODEL_RE.test(modelId)) throw new ProtocolError("modelId has an invalid format");
			return {
				type,
				provider,
				modelId,
				thinkingLevel: thinking(msg.thinkingLevel),
				...(msg.sessionId === undefined
					? {}
					: { sessionId: identifier(msg.sessionId, "sessionId") }),
			};
		}
		case "prompt":
		case "steer":
			return {
				type,
				text: string(msg.text, "text", MAX_PROMPT_CHARS, true),
				...(msg.images === undefined ? {} : { images: images(msg.images) }),
			};
		case "abort":
		case "abortRetry":
		case "listSessions":
		case "newSession":
		case "getCapabilities":
		case "getSessionStats":
		case "listProjects":
			return type === "newSession" && msg.projectId !== undefined
				? { type, projectId: identifier(msg.projectId, "projectId") }
				: ({ type } as ClientMessage);
		case "setModel": {
			const provider = string(msg.provider, "provider", 64);
			const modelId = string(msg.modelId, "modelId", 256);
			if (!PROVIDER_RE.test(provider) || !MODEL_RE.test(modelId)) {
				throw new ProtocolError("invalid provider or modelId");
			}
			return { type, provider, modelId };
		}
		case "compact":
			return {
				type,
				...(msg.customInstructions === undefined
					? {}
					: {
							customInstructions: string(msg.customInstructions, "customInstructions", 2000, true),
						}),
			};
		case "setThinking":
			return { type, level: thinking(msg.level) };
		case "extensionUiResponse":
			if (msg.confirmed !== undefined && typeof msg.confirmed !== "boolean") {
				throw new ProtocolError("confirmed must be boolean");
			}
			if (msg.cancelled !== undefined && typeof msg.cancelled !== "boolean") {
				throw new ProtocolError("cancelled must be boolean");
			}
			return {
				type,
				id: identifier(msg.id, "id"),
				...(msg.value === undefined
					? {}
					: { value: string(msg.value, "value", MAX_PROMPT_CHARS, true) }),
				...(typeof msg.confirmed === "boolean" ? { confirmed: msg.confirmed } : {}),
				...(typeof msg.cancelled === "boolean" ? { cancelled: msg.cancelled } : {}),
			};
		case "renameSession":
			return { type, name: string(msg.name, "name", 500, true) };
		case "renameSessionById":
			return {
				type,
				sessionId: identifier(msg.sessionId, "sessionId"),
				name: string(msg.name, "name", 500, true),
			};
		case "setSessionPinned":
			if (typeof msg.pinned !== "boolean") throw new ProtocolError("pinned must be boolean");
			return { type, sessionId: identifier(msg.sessionId, "sessionId"), pinned: msg.pinned };
		case "deleteSession":
		case "resumeSession":
			return { type, sessionId: identifier(msg.sessionId, "sessionId") };
		case "forkSession": {
			const messageCount = msg.messageCount;
			if (
				!Number.isSafeInteger(messageCount) ||
				(messageCount as number) < 0 ||
				(messageCount as number) > 1_000_000
			) {
				throw new ProtocolError("messageCount must be an integer between 0 and 1000000");
			}
			return {
				type,
				sessionId: identifier(msg.sessionId, "sessionId"),
				messageCount: messageCount as number,
			};
		}
		case "createProject":
			return {
				type,
				name: string(msg.name, "name", 200, true),
				...(msg.icon === undefined ? {} : { icon: optionalString(msg.icon, "icon", 16) }),
				...(msg.instructions === undefined
					? {}
					: {
							instructions: optionalString(
								msg.instructions,
								"instructions",
								MAX_INSTRUCTIONS_CHARS,
							),
						}),
				...projectDefaults(msg),
			};
		case "updateProject":
			return {
				type,
				id: identifier(msg.id, "id"),
				...(msg.name === undefined ? {} : { name: optionalString(msg.name, "name", 200) }),
				...(msg.icon === undefined ? {} : { icon: optionalString(msg.icon, "icon", 16) }),
				...(msg.instructions === undefined
					? {}
					: {
							instructions: optionalString(
								msg.instructions,
								"instructions",
								MAX_INSTRUCTIONS_CHARS,
							),
						}),
				...projectDefaults(msg),
			};
		case "deleteProject":
			return { type, id: identifier(msg.id, "id") };
		case "reorderProjects": {
			if (!Array.isArray(msg.order) || msg.order.length > 100) {
				throw new ProtocolError("order must be an array of at most 100 project ids");
			}
			return { type, order: msg.order.map((id) => identifier(id, "project id")) };
		}
		default:
			throw new ProtocolError(`unsupported message type: ${type}`);
	}
}
