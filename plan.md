# agentchatbox

agentchatbox is just a shell. The actual coding-agent logic runs inside
the `pi` subprocess; the agentchatbox server is the transport layer,
nothing more. (See `src/server/chat.ts`.)

## Locked-in decisions

| # | Decision | Value |
|---|----------|-------|
| 8 | Server bind | `0.0.0.0:3500` (code default is `3000`, overridden via `PORT=3500` in `.env` because grafana already owns 3000 on this host) |
