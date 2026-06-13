// End-to-end WS smoke test for /api/chat.
// Connects, sends a prompt, prints every event the server sends.
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:3500/api/chat");
let events = 0;
let ready = null;
const t0 = Date.now();

ws.on("open", () => {
	console.log(`[+${Date.now() - t0}ms] WS open`);
});

ws.on("message", (data) => {
	events++;
	const msg = JSON.parse(data.toString());
	if (msg.type === "ready") {
		ready = msg;
		console.log(`[+${Date.now() - t0}ms] ready: model=${msg.modelId} provider=${msg.provider} thinking=${msg.thinkingLevel}`);
		// Send a simple prompt after ready.
		setTimeout(() => {
			console.log(`[+${Date.now() - t0}ms] sending prompt`);
			ws.send(JSON.stringify({ type: "prompt", text: "Use the read tool to read /home/architect/agentchatbox/package.json. Show me the dependencies. Do not use bash, do not use cat, only use the read tool." }));
		}, 100);
	} else if (msg.type === "event") {
		const e = msg.event;
		if (e.type === "message_update") {
			const text = (e.message.content.find((c) => c.type === "text") || {}).text || "";
			process.stdout.write(`[update] ${JSON.stringify(text)}\n`);
		} else if (e.type === "message_end") {
			const text = (e.message.content.find((c) => c.type === "text") || {}).text || "";
			console.log(`[+${Date.now() - t0}ms] message_end: text=${JSON.stringify(text)} usage=${JSON.stringify(e.message.usage)}`);
		} else if (e.type === "agent_end") {
			console.log(`[+${Date.now() - t0}ms] agent_end: ${e.messages.length} messages`);
			setTimeout(() => {
				console.log(`done — ${events} events total`);
				ws.close();
				process.exit(0);
			}, 100);
		} else if (e.type === "tool_execution_start") {
			console.log(`[tool] ${e.toolName} ${JSON.stringify(e.args).slice(0, 100)}`);
		} else if (e.type === "tool_execution_end") {
			console.log(`[tool done] ${e.toolName} isError=${e.isError}`);
		} else if (e.type === "agent_start" || e.type === "turn_start") {
			console.log(`[event] ${e.type}`);
		}
	} else if (msg.type === "error") {
		console.log(`[ERROR] ${msg.message}`);
	}
});

ws.on("error", (e) => {
	console.log("WS error:", e.message);
	process.exit(1);
});

setTimeout(() => {
	console.log("timeout");
	process.exit(2);
}, 60000);
