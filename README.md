# STONHUB API

Fastify + TypeScript backend for STONHUB. Reads Solana on-chain data (Helius), interprets with Claude Haiku 4.5, gates skills by $STON balance.

## Endpoints
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | — | Railway healthcheck |
| POST | `/api/waitlist` | — | `{ email }` |
| POST | `/api/holder` | — | `{ wallet }` → `{ tier, balance, scanLimit, skills{} }` |
| POST | `/api/scan` | — | `{ address, wallet? }` → `{ snapshot, dossier, receipt, tier, scansLeft }` |
| POST | `/api/whales` | holder | `{ wallet, address? }` → `{ events[] }` |
| POST | `/api/watchlist` | holder | `{ wallet, action: list\|add\|remove, target?, label? }` |

`wallet` is the *viewer* (for tier + limits). `address` is what you're scanning.

## Tiers (env-configurable)
- **free**: 5 scans/day, scanner only
- **holder** (≥ `TIER_HOLDER_MIN` $STON): 100 scans/day + whales/watchlist/smartmoney/alerts
- **pro** (≥ `TIER_PRO_MIN`): 1000 scans/day

Pre-launch: leave `STON_MINT` empty → gating off, everyone = free, no RPC errors. At launch set `STON_MINT` to the CA to turn gating on.

## Deploy (Railway)
1. Push `backend/` to a GitHub repo.
2. Railway → New Project → Deploy from repo. Root dir `backend/`.
3. `railway.json` + `nixpacks.toml` handle build/start/healthcheck (Node 20).
4. Add env vars from `.env.example`:
   - `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` (default `anthropic/claude-3.5-haiku`)
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `HELIUS_API_KEY`
   - `CORS_ORIGIN=https://stonhub.xyz`
   - launch: `STON_MINT=<CA>` (leave empty until launch)
5. Run `schema.sql` in the Supabase SQL editor first.
6. Confirm `https://<your-app>.up.railway.app/health` → `{ ok: true }`.

## Wire to frontend
In `assets/app.js` set `API` to the Railway URL. The dashboard's `/api/holder`, `/api/scan`, `/api/whales`, `/api/watchlist` calls light up automatically. Empty `API` → demo mode.

## Cost control
- 5-min in-memory scan cache (`SCAN_CACHE_TTL_MS`) — repeat scans of the same address don't re-hit Helius/Claude.
- Tier-aware daily IP rate limit via `scan_usage` table.

## Local dev
```bash
cp .env.example .env   # fill keys
npm install
npm run dev            # tsx watch
```

## Files
```
src/
  server.ts   routes, caching, rate limit, gating wiring
  chain.ts    Helius wallet snapshot (balance, txns, tokens, net flow)
  agent.ts    Claude Haiku → dossier (archetype, score, signals, risk)
  holder.ts   $STON balance → tier → limits + skill access
  whales.ts   large native-flow detection via Helius enriched txns
schema.sql    Supabase tables (waitlist, scans, scan_usage, watchlist)
railway.json / nixpacks.toml   deploy config (Node 20)
```
