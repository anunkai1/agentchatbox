import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROMPT_MESSAGE_TYPE } from "../extensions/claude-delegate/lib.js";
import type { RecoverySnapshot } from "../extensions/delegate/recovery.js";
import register from "../extensions/session-recovery/index.js";
import {
	listRecovery,
	RECOVERY_INSTRUCTION,
	readRecovery,
	type SessionRecovery,
	sessionRecoveryRequestId,
	writeRecovery,
} from "../extensions/session-recovery/lib.js";
import { recoverSessions } from "../extensions/session-recovery/recovery.js";
import { recordTransportStop } from "../src/shared/transport-state.js";

vi.mock("../extensions/delegate/index.js", () => ({ sendTelegram: vi.fn() }));

const origin = "http://127.0.0.1:3599";
const model = { provider: "test", modelId: "test-model", thinkingLevel: "high" as const };
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "acb-session-recovery-"));
	vi.stubEnv("ACB_SESSION_RECOVERY_DIR", join(root, "sessions"));
	vi.stubEnv("ACB_TRANSPORT_STATE_DIR", join(root, "transport"));
	vi.stubEnv("ACB_INTERNAL_URL", origin);
	vi.stubEnv("ACB_BOOT_ID", "boot-2");
	vi.stubEnv("ACB_SESSION_RECOVERY", "1");
	vi.stubEnv("ACB_DELEGATIONS_DIR", root);
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});
function record(overrides: Partial<SessionRecovery> = {}): SessionRecovery {
	return {
		version: 1,
		id: "chat-1",
		origin,
		cwd: root,
		enabled: true,
		status: "running",
		requestId: "owner-request-1",
		anchorId: "entry-1",
		bootId: "boot-1",
		startedAt: Date.now() - 1000,
		model,
		used: false,
		...overrides,
	};
}
function harness() {
	type Handler = (data: unknown, ctx: unknown) => unknown;
	const hooks = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const bus = new Map<string, ((data: unknown) => unknown)[]>();
	const branch: {
		id: string;
		type?: string;
		customType?: string;
		content?: unknown;
		message?: unknown;
		details?: unknown;
	}[] = [];
	let timestamp = 0;
	const notify = vi.fn();
	const ctx = {
		cwd: root,
		model: { provider: "test", id: "test-model" },
		isIdle: vi.fn(() => true),
		sessionManager: { getSessionId: () => "chat-1", getBranch: () => branch },
		ui: { notify: vi.fn() },
	};
	const pi = {
		on: (name: string, handler: Handler) => hooks.set(name, handler),
		registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
		getThinkingLevel: () => "high",
		sendMessage: vi.fn(
			(
				message: Parameters<ExtensionAPI["sendMessage"]>[0],
				_options: Parameters<ExtensionAPI["sendMessage"]>[1],
			) => {
				branch.push({ type: "custom_message", id: `custom-${branch.length}`, ...message });
			},
		),
		events: {
			on: (name: string, handler: (data: unknown) => unknown) =>
				bus.set(name, [...(bus.get(name) ?? []), handler]),
			emit: (name: string, data: unknown) => {
				for (const handler of bus.get(name) ?? []) handler(data);
			},
		},
	};
	register(pi as unknown as ExtensionAPI, notify);
	const event = async (name: string, data: unknown = {}) => hooks.get(name)?.(data, ctx);
	const command = (args: string) => commands.get("recovery")!.handler(args, ctx);
	async function user(text = "do the task", source = "rpc", expanded = text) {
		await event("input", { text, source });
		await event("before_agent_start", { messageType: "user", prompt: expanded });
		const message = {
			role: "user",
			content: [{ type: "text", text: expanded }],
			timestamp: ++timestamp,
		};
		await event("message_end", { message });
		const before = readRecovery("chat-1");
		branch.push({ type: "message", id: `entry-${branch.length + 1}`, message });
		await event("context");
		return before;
	}
	return { pi, ctx, event, command, user, branch, notify, saved: () => readRecovery("chat-1")! };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("normal request lifecycle extension", () => {
	it("enrols only an actual saved owner request, at the pre-model boundary", async () => {
		const h = harness();
		expect(await h.user()).toBeNull();
		expect(h.saved()).toMatchObject({
			status: "running",
			bootId: "boot-2",
			anchorId: "entry-1",
			model,
			used: false,
		});
		const request = h.saved().requestId;
		await h.event("context");
		expect(h.saved().requestId).toBe(request);
	});
	it("tracks expanded skill/template prompts without confusing promptless custom runs", async () => {
		const h = harness();
		await h.event("before_agent_start", { messageType: "custom" });
		await h.user("/skill:inspect", "rpc", "expanded skill: inspect the workspace");
		expect(h.saved().status).toBe("running");
	});
	it("does not enrol idle legacy chats or synthetic-only runs", async () => {
		const h = harness();
		await h.event("session_start");
		await h.event("context");
		await h.user("synthetic report", "extension");
		expect(h.saved()).toBeNull();
		await h.event("session_shutdown", { reason: "quit" });
	});
	it("clears a completed or explicitly aborted request, but not service shutdown", async () => {
		const h = harness();
		await h.user();
		await h.event("agent_settled", { aborted: false });
		await flush();
		expect(h.saved().status).toBe("idle");
		await h.user("another task");
		await h.event("agent_settled", { aborted: true });
		await flush();
		expect(h.saved().status).toBe("stopped");
		await h.user("deploy");
		await h.event("session_shutdown", { reason: "quit" });
		await h.event("agent_settled", { aborted: true });
		await flush();
		expect(h.saved().status).toBe("running");
	});
	it("honours durable Stop even when the settle event does not say aborted", async () => {
		const h = harness();
		await h.user();
		recordTransportStop(origin, "chat-1");
		await h.event("agent_settled", {});
		await flush();
		expect(h.saved().status).toBe("stopped");
	});
	it("preserves approval waits across shutdown and does not revive explicit session navigation", async () => {
		const h = harness();
		await h.user();
		await h.event("ui_prompt_start");
		await h.event("session_shutdown", { reason: "quit" });
		await h.event("ui_prompt_end");
		expect(h.saved().waitingForInput).toBe(true);
		const next = harness();
		await next.event("session_shutdown", { reason: "new" });
		expect(next.saved().status).toBe("stopped");
	});
	it("does not settle over an automatic continuation or a newer owner request", async () => {
		const h = harness();
		await h.user();
		await h.event("agent_settled", {});
		h.pi.events.emit("auto-continue:resume", {});
		await flush();
		expect(h.saved().status).toBe("running");
		await h.event("agent_settled", {});
		await h.user("new request");
		await flush();
		expect(h.saved().status).toBe("running");
	});
	it("consumes the allowance durably before injecting safe continuation, never twice", async () => {
		writeRecovery(record());
		const h = harness();
		h.branch.push({ id: "entry-1" });
		await h.command("resume owner-request-1");
		expect(h.saved()).toMatchObject({ used: true, bootId: "boot-2", requestId: "owner-request-1" });
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: RECOVERY_INSTRUCTION }),
			{ triggerTurn: true },
		);
		await h.command("resume owner-request-1");
		expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
	});
	it("rearms only on a new real owner request, not synthetic followups", async () => {
		const h = harness();
		await h.user();
		const first = h.saved();
		writeRecovery({ ...first, used: true });
		await h.user("automatic continuation", "extension");
		expect(h.saved()).toMatchObject({ used: true, requestId: first.requestId });
		await h.user("please continue");
		expect(h.saved().used).toBe(false);
		expect(h.saved().requestId).not.toBe(first.requestId);
	});
	it.each([
		{ status: "idle" },
		{ status: "stopped" },
		{ waitingForInput: true },
		{ enabled: false },
		{ used: true },
		{ bootId: "boot-2" },
	] as Partial<SessionRecovery>[])("refuses an ineligible continuation: %o", async (override) => {
		writeRecovery(record(override));
		const h = harness();
		h.branch.push({ id: "entry-1" });
		await h.command("resume owner-request-1");
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});
	it("will not race an owner input, a busy execution, or a cancellation", async () => {
		writeRecovery(record());
		const h = harness();
		h.branch.push({ id: "entry-1" });
		h.ctx.isIdle.mockReturnValue(false);
		await h.command("resume owner-request-1");
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		h.ctx.isIdle.mockReturnValue(true);
		await h.event("input", { text: "new task", source: "rpc" });
		await h.command("resume owner-request-1");
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		const other = harness();
		recordTransportStop(origin, "chat-1");
		await other.command("resume owner-request-1");
		expect(other.pi.sendMessage).not.toHaveBeenCalled();
	});
	it("fails closed when the active transcript branch no longer contains the request", async () => {
		writeRecovery(record());
		const h = harness();
		await h.command("resume owner-request-1");
		expect(h.saved().status).toBe("needs_input");
		expect(h.notify).toHaveBeenCalledOnce();
		expect(h.pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "session-recovery-notice" }),
			{ triggerTurn: false },
		);
	});
	it("persists per-chat opt-out; on applies only to subsequent owner requests", async () => {
		const h = harness();
		await h.command("off");
		await h.user();
		expect(h.saved()).toMatchObject({ enabled: false, status: "idle", requestId: null });
		await h.command("on");
		expect(h.saved().requestId).toBeNull();
		await h.user("new task");
		expect(h.saved()).toMatchObject({ enabled: true, status: "running" });
	});
	it("never rearms from an ambiguous mixture of owner and synthetic queued input", async () => {
		const h = harness();
		await h.user();
		const first = h.saved();
		writeRecovery({ ...first, used: true });
		h.ctx.isIdle.mockReturnValue(false);
		await h.event("input", {
			text: "owner followup",
			source: "rpc",
			streamingBehavior: "followUp",
		});
		await h.event("input", {
			text: "/skill:synthetic",
			source: "extension",
			streamingBehavior: "steer",
		});
		const message = { role: "user", content: "expanded synthetic text", timestamp: 101 };
		await h.event("message_end", { message });
		h.branch.push({ type: "message", id: "queued-1", message });
		await h.event("context");
		expect(h.saved()).toMatchObject({ used: true, requestId: first.requestId });
		await h.event("message_end", { message: { ...message, timestamp: 102 } });
		await h.event("context");
		expect(h.saved().used).toBe(true);
		h.ctx.isIdle.mockReturnValue(true);
		await h.event("agent_settled", {});
		await flush();
		await h.user("fresh explicit request");
		expect(h.saved().used).toBe(false);
	});
	it("disarms an older native request when overlapping Claude input is not saved", async () => {
		const h = harness();
		await h.user();
		h.pi.events.emit("claude-delegate:run-start", {
			ctx: h.ctx,
			mode: "opus",
			task: "not saved yet",
			ownerRequest: true,
		});
		expect(h.saved().status).toBe("needs_input");
	});
	it("does not crash Pi from a deferred completion hook if transport metadata is corrupt", async () => {
		const h = harness();
		await h.user();
		recordTransportStop(origin, "chat-1");
		writeFileSync(join(root, "transport", "3599", "stops", "chat-1.json"), "{");
		await h.event("agent_settled", {});
		await flush();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Could not save"),
			"warning",
		);
	});
	it("never overlaps delegated-worker recovery, even with a corrupt worker record", async () => {
		writeFileSync(join(root, "chat-1.json"), "{");
		const h = harness();
		await h.user();
		await h.command("on");
		expect(h.saved()).toBeNull();
	});
	it("records visible attention notices once, without starting a model", async () => {
		writeRecovery(
			record({ status: "needs_input", notice: "Please inspect the interrupted request." }),
		);
		const h = harness();
		await h.command("notice owner-request-1");
		await h.command("notice owner-request-1");
		expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.anything(), { triggerTurn: false });
	});
	it("tracks real Claude requests/followups, but does not rearm synthetic Claude runs", () => {
		const h = harness();
		const task = "inspect the repo";
		h.branch.push({
			type: "custom_message",
			id: "entry-1",
			customType: PROMPT_MESSAGE_TYPE,
			content: task,
		});
		h.pi.events.emit("claude-delegate:run-start", {
			ctx: h.ctx,
			mode: "opus",
			task,
			ownerRequest: true,
		});
		const first = h.saved();
		expect(first).toMatchObject({ claude: "opus", status: "running" });
		writeRecovery({ ...first, used: true });
		h.pi.events.emit("claude-delegate:run-start", {
			ctx: h.ctx,
			mode: "opus",
			task: "resume",
			ownerRequest: false,
		});
		expect(h.saved()).toMatchObject({ used: true, requestId: first.requestId });
		h.branch.push({
			type: "custom_message",
			id: "entry-2",
			customType: PROMPT_MESSAGE_TYPE,
			content: "followup",
		});
		h.pi.events.emit("claude-delegate:follow-up", {
			ctx: h.ctx,
			mode: "opus",
			task: "followup",
			ownerRequest: true,
		});
		expect(h.saved().requestId).not.toBe(first.requestId);
		expect(h.saved().used).toBe(false);
		h.pi.events.emit("claude-delegate:run-end", { ctx: h.ctx, cancelled: false });
		expect(h.saved().status).toBe("idle");
	});
	it("resumes Claude in the same engine, or asks for input if that engine is unavailable", async () => {
		writeRecovery(record({ claude: "opus" }));
		const h = harness();
		h.branch.push({ id: "entry-1" });
		const accept = vi.fn((event: unknown) => (event as { accept: () => void }).accept());
		h.pi.events.on("claude-delegate:start", accept);
		await h.command("resume owner-request-1");
		expect(accept).toHaveBeenCalledOnce();
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		writeRecovery(record({ claude: "opus" }));
		const other = harness();
		other.branch.push({ id: "entry-1" });
		await other.command("resume owner-request-1");
		expect(other.saved().status).toBe("needs_input");
		expect(other.notify).toHaveBeenCalledOnce();
	});
});

describe("bounded normal-session startup policy", () => {
	function client() {
		return {
			snapshot: vi.fn(async (): Promise<RecoverySnapshot> => ({ bootId: "boot-2", sessions: [] })),
			resume: vi.fn(async () => ({
				bootId: "boot-2",
				delivery: "submitted" as "submitted" | "uncertain",
			})),
			notice: vi.fn(async () => {}),
			notify: vi.fn(),
		};
	}
	it("submits a stable per-request ID for interrupted active work; a new request has a different ID", async () => {
		const c = client(),
			saved = record();
		writeRecovery(saved);
		expect(await recoverSessions(c, origin, c.notify)).toBe(0);
		expect(c.resume).toHaveBeenCalledWith(saved, sessionRecoveryRequestId(saved));
		expect(sessionRecoveryRequestId(record({ requestId: "next" }))).not.toBe(
			sessionRecoveryRequestId(saved),
		);
	});
	it.each([
		{ status: "idle" },
		{ status: "stopped" },
		{ enabled: false },
		{ requestId: null },
		{ anchorId: null },
		{ model: null },
		{ bootId: "boot-2" },
		{ origin: "http://other" },
	] as Partial<SessionRecovery>[])("does not wake an ineligible chat: %o", async (override) => {
		writeRecovery(record(override));
		const c = client();
		await recoverSessions(c, origin, c.notify);
		expect(c.resume).not.toHaveBeenCalled();
		expect(c.notify).not.toHaveBeenCalled();
	});
	it("allows idle browser reattachments but not active native/Claude/compaction work", async () => {
		const c = client();
		writeRecovery(record());
		c.snapshot.mockResolvedValue({
			bootId: "boot-2",
			sessions: [{ sessionId: "chat-1", busy: false }],
		});
		await recoverSessions(c, origin, c.notify);
		expect(c.resume).toHaveBeenCalledOnce();
		for (const activity of [
			{ busy: true },
			{ streaming: true },
			{ claude: true },
			{ compaction: "manual" },
		]) {
			c.resume.mockClear();
			c.snapshot.mockResolvedValue({
				bootId: "boot-2",
				sessions: [{ sessionId: "chat-1", ...activity }],
			});
			await recoverSessions(c, origin, c.notify);
			expect(c.resume).not.toHaveBeenCalled();
		}
	});
	it("never processes a delegated worker through the normal-session policy", async () => {
		writeRecovery(record());
		writeFileSync(join(root, "chat-1.json"), "{");
		const c = client();
		await recoverSessions(c, origin, c.notify);
		expect(c.resume).not.toHaveBeenCalled();
	});
	it.each([
		{ waitingForInput: true },
		{ used: true },
	])("asks for input instead of bypassing an approval/second recovery: %o", async (override) => {
		writeRecovery(record(override));
		const c = client();
		await recoverSessions(c, origin, c.notify);
		expect(c.resume).not.toHaveBeenCalled();
		expect(readRecovery("chat-1")?.status).toBe("needs_input");
		expect(c.notify).toHaveBeenCalledOnce();
		expect(c.notice).toHaveBeenCalledOnce();
		await recoverSessions(c, origin, c.notify);
		expect(c.notify).toHaveBeenCalledOnce();
	});
	it("never recovers an explicit Stop", async () => {
		writeRecovery(record());
		recordTransportStop(origin, "chat-1");
		const c = client();
		await recoverSessions(c, origin, c.notify);
		expect(readRecovery("chat-1")?.status).toBe("stopped");
		expect(c.resume).not.toHaveBeenCalled();
		expect(c.notify).not.toHaveBeenCalled();
	});
	it("fails closed on uncertain or previous-boot receipts", async () => {
		const c = client();
		writeRecovery(record());
		c.resume.mockResolvedValue({ bootId: "boot-2", delivery: "uncertain" });
		await recoverSessions(c, origin, c.notify);
		expect(readRecovery("chat-1")?.status).toBe("needs_input");
		writeRecovery(record());
		c.resume.mockResolvedValue({ bootId: "boot-1", delivery: "submitted" });
		await recoverSessions(c, origin, c.notify);
		expect(readRecovery("chat-1")?.status).toBe("needs_input");
	});
	it("rechecks user activity before finalising an interruption", async () => {
		writeRecovery(record({ used: true }));
		const c = client();
		c.snapshot.mockImplementation(async () => {
			if (c.snapshot.mock.calls.length === 2)
				writeRecovery(record({ requestId: "new-owner-request", bootId: "boot-2" }));
			return { bootId: "boot-2", sessions: [] };
		});
		await recoverSessions(c, origin, c.notify);
		expect(c.notify).not.toHaveBeenCalled();
		expect(readRecovery("chat-1")?.requestId).toBe("new-owner-request");
	});
	it("retries transport unavailability without assuming failure; final pass requests input", async () => {
		writeRecovery(record());
		const c = client();
		c.resume.mockRejectedValue(new Error("transport unavailable"));
		expect(await recoverSessions(c, origin, c.notify)).toBe(1);
		expect(readRecovery("chat-1")?.status).toBe("running");
		expect(await recoverSessions(c, origin, c.notify, { final: true })).toBe(0);
		expect(readRecovery("chat-1")?.status).toBe("needs_input");
	});
	it("does not treat an absent snapshot as evidence that sessions are dead", async () => {
		writeRecovery(record());
		const c = client();
		c.snapshot.mockRejectedValue(new Error("offline"));
		await expect(recoverSessions(c, origin, c.notify)).rejects.toThrow("offline");
		expect(readRecovery("chat-1")?.status).toBe("running");
		expect(c.notify).not.toHaveBeenCalled();
	});
	it("isolates corrupt durable records and honours the global opt-out", async () => {
		writeRecovery(record());
		writeFileSync(join(root, "sessions", "corrupt.json"), "{");
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(listRecovery()).toHaveLength(1);
		writeFileSync(
			join(root, "sessions", "schema.json"),
			JSON.stringify({ ...record({ id: "schema" }), used: "false" }),
		);
		expect(() => readRecovery("schema")).toThrow("invalid session recovery record");
		expect(listRecovery()).toHaveLength(1);
		expect(log).toHaveBeenCalled();
		log.mockRestore();
		vi.stubEnv("ACB_SESSION_RECOVERY", "0");
		const c = client();
		await recoverSessions(c, origin, c.notify);
		expect(c.snapshot).not.toHaveBeenCalled();
	});
});
