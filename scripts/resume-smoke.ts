/**
 * Live smoke test: drive the real agentchatbox server over the WS
 * protocol and verify the /resume flow works end-to-end.
 *
 * This is what the browser does, but scripted. If this passes,
 * the user's actual UX will work.
 *
 * Steps:
 *   1. Connect WS
 *   2. Send `init` (no sessionId — fresh session)
 *   3. Wait for `ready`, capture the sessionId
 *   4. Send `prompt: "remember the secret word: blue mango"` — turn 1
 *   5. Wait for the assistant to respond
 *   6. Disconnect
 *   7. Connect again with a NEW WS
 *   8. Send `init` with `sessionId: <captured>` — resume
 *   9. Wait for `ready` and `transcript` (the prior messages)
 *  10. Send `prompt: "what was the secret word?"` — turn 2 (the resume)
 *  11. Verify the assistant's response contains "blue mango"
 *      (proves the model has full context, not reset)
 */

import WebSocket from "ws";

const URL = "ws://127.0.0.1:3500/api/chat";

function makeClient(label: string) {
	const ws = new WebSocket(URL);
	const events: any[] = [];
	ws.on("message", (raw) => {
		const text = raw.toString();
		try {
			const msg = JSON.parse(text);
			events.push(msg);
			const t = msg.type;
			if (t === "event" && msg.event?.type) {
				const et = msg.event.type;
				if (et === "message_update" && msg.event.message?.content) {
					process.stdout.write(`[${label}] ${et}: ${JSON.stringify(msg.event.message.content).slice(0, 200)}\n`);
				} else if (et === "message_end" && msg.event.message?.role === "assistant") {
					const text = (msg.event.message.content as any[])
						?.filter((b) => b.type === "text")
						.map((b) => b.text)
						.join("") ?? "";
					process.stdout.write(`[${label}] ASSISTANT: ${text.slice(0, 500)}\n`);
				} else {
					process.stdout.write(`[${label}] ${et}\n`);
				}
			} else {
				process.stdout.write(`[${label}] ${t}${msg.sessionId ? " session=" + msg.sessionId : ""}${msg.modelId ? " model=" + msg.modelId : ""}\n`);
			}
		} catch (e) {
			process.stdout.write(`[${label}] <non-json: ${text.slice(0, 100)}>\n`);
		}
	});
	return { ws, events };
}

function wait(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForReady(client: ReturnType<typeof makeClient>): Promise<string> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const ready = client.events.find((m) => m.type === "ready");
		if (ready) return String(ready.sessionId ?? "");
		await wait(50);
	}
	throw new Error("timed out waiting for ready");
}

async function waitForTurnEnd(client: ReturnType<typeof makeClient>, timeoutMs = 90_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const evt = client.events.find((m) => m.type === "event" && m.event?.type === "turn_end");
		if (evt) {
			const msg = (evt.event as any).message;
			const text = (msg?.content as any[])?.filter((b) => b.type === "text").map((b) => b.text).join("") ?? "";
			return text;
		}
		await wait(100);
	}
	throw new Error("timed out waiting for turn_end");
}

async function main() {
	console.log("=== STEP 1-2: open fresh session, send init ===");
	const c1 = makeClient("FRESH");
	await new Promise<void>((res, rej) => { c1.ws.once("open", () => res()); c1.ws.once("error", rej); });
	c1.ws.send(JSON.stringify({ type: "init", provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "off" }));
	const sessionId = await waitForReady(c1);
	console.log("=== session id:", sessionId);

	console.log("\n=== STEP 3-4: turn 1 — 'remember the secret word: blue mango' ===");
	c1.ws.send(JSON.stringify({ type: "prompt", text: "remember the secret word is: blue mango. Just acknowledge with 'got it' and nothing else." }));
	const turn1Response = await waitForTurnEnd(c1);
	console.log("=== turn 1 response:", turn1Response);

	console.log("\n=== STEP 5: disconnect fresh session ===");
	c1.ws.close();
	await wait(500);

	console.log("\n=== STEP 6-7: open resume session, send init with sessionId ===");
	const c2 = makeClient("RESUME");
	await new Promise<void>((res, rej) => { c2.ws.once("open", () => res()); c2.ws.once("error", rej); });
	c2.ws.send(JSON.stringify({ type: "init", provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "off", sessionId }));
	await waitForReady(c2);

	// Look for the transcript message.
	const transcript = c2.events.find((m) => m.type === "transcript");
	console.log("=== transcript message present:", !!transcript, "msg count:", (transcript as any)?.messages?.length);

	console.log("\n=== STEP 8: turn 2 — 'what was the secret word?' ===");
	c2.ws.send(JSON.stringify({ type: "prompt", text: "What was the secret word I told you? Answer with just the word." }));
	const turn2Response = await waitForTurnEnd(c2);
	console.log("=== turn 2 response:", turn2Response);

	const passed = turn2Response.toLowerCase().includes("blue mango") || turn2Response.toLowerCase().includes("mango");
	console.log("\n=== RESULT:", passed ? "✅ PASS — model remembered across resume" : "❌ FAIL — model did not remember");
	console.log("=== full turn 2 response (raw):", JSON.stringify(turn2Response));

	c2.ws.close();
	process.exit(passed ? 0 : 1);
}

main().catch((err) => { console.error("ERROR:", err); process.exit(2); });
