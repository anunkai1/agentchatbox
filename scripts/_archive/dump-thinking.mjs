// Dump the AgentEvent stream — focus on whether thinking blocks are in messages.
import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:3500/api/chat");
const events = [];
const assistantSnapshots = [];
let lastAssistantContent = null;

ws.on("open", () => console.log("[open]"));

ws.on("message", (raw) => {
	const msg = JSON.parse(raw.toString());
	if (msg.type === "ready") {
		console.log("[ready]", JSON.stringify(msg));
		setTimeout(() => {
			console.log("[sending prompt]");
			ws.send(JSON.stringify({
				type: "prompt",
				text: "Think step by step about why the sky is blue, then give a one-sentence answer. Make sure to think out loud in your thinking block before answering."
			}));
		}, 100);
	} else if (msg.type === "event") {
		const e = msg.event;
		events.push(e.type);
		if (e.type === "message_update" || e.type === "message_end") {
			const m = e.message;
			if (m && m.role === "assistant") {
				lastAssistantContent = m.content;
			}
		}
		if (e.type === "agent_end") {
			console.log("=== events seen ===");
			console.log([...new Set(events)].join(" "));
			console.log("=== final assistant content blocks ===");
			if (lastAssistantContent) {
				for (const b of lastAssistantContent) {
					console.log(JSON.stringify({
						type: b.type,
						textLen: typeof b.text === "string" ? b.text.length : 0,
						thinkingLen: typeof b.thinking === "string" ? b.thinking.length : 0,
						sampleText: typeof b.text === "string" ? b.text.slice(0, 200) : null,
						sampleThinking: typeof b.thinking === "string" ? b.thinking.slice(0, 200) : null,
					}));
				}
			} else {
				console.log("(no assistant content captured)");
			}
			setTimeout(() => process.exit(0), 200);
		}
	} else if (msg.type === "error") {
		console.log("[ERROR]", msg.message);
	}
});

ws.on("error", (e) => console.log("[ws error]", e.message));

setTimeout(() => { console.log("[timeout]"); process.exit(1); }, 45000);
