// src/server.ts — STONHUB API (full)
import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { getWalletSnapshot } from "./chain.js";
import { buildDossier } from "./agent.js";
import { resolveHolder, scanLimitFor, canUseSkill, type Tier } from "./holder.js";
import { whaleEventsForAddress } from "./whales.js";

const app = Fastify({ logger: true, trustProxy: true });
// Node 20 has no native WebSocket. Supabase realtime needs one even though we
// never use realtime, so provide the `ws` polyfill to stop the boot crash.
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: { persistSession: false },
    realtime: { transport: WebSocket as any },
  }
);

await app.register(cors, {
  origin: (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim()),
});

// ---- helpers ----
const isSolAddr = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
const clientIp = (req: any) =>
  (req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "0.0.0.0").trim();
const today = () => new Date().toISOString().slice(0, 10);

// in-memory scan cache (address -> {data, exp}); cuts Helius+Claude cost
const CACHE = new Map<string, { data: any; exp: number }>();
const CACHE_TTL = Number(process.env.SCAN_CACHE_TTL_MS ?? 5 * 60 * 1000); // 5 min

function cacheGet(key: string) {
  const hit = CACHE.get(key);
  if (hit && hit.exp > Date.now()) return hit.data;
  if (hit) CACHE.delete(key);
  return null;
}
function cacheSet(key: string, data: any) {
  CACHE.set(key, { data, exp: Date.now() + CACHE_TTL });
  if (CACHE.size > 500) { // simple cap
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].exp - b[1].exp)[0];
    if (oldest) CACHE.delete(oldest[0]);
  }
}

// daily IP rate limit (tier-aware)
async function consumeQuota(ip: string, limit: number): Promise<{ ok: boolean; used: number }> {
  const day = today();
  const { data } = await supabase
    .from("scan_usage").select("count").eq("ip", ip).eq("day", day).maybeSingle();
  const used = data?.count ?? 0;
  if (used >= limit) return { ok: false, used };
  await supabase.from("scan_usage").upsert({ ip, day, count: used + 1 }, { onConflict: "ip,day" });
  return { ok: true, used: used + 1 };
}

// ---- health ----
app.get("/health", async () => ({ ok: true, service: "stonhub-api", ts: Date.now() }));

// ---- waitlist ----
app.post("/api/waitlist", async (req, reply) => {
  const { email } = (req.body as any) || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return reply.code(400).send({ error: "Valid email required." });
  const { error } = await supabase
    .from("waitlist").upsert({ email: email.toLowerCase() }, { onConflict: "email" });
  if (error) return reply.code(500).send({ error: "Could not save. Try again." });
  return { ok: true };
});

// ---- holder check (dashboard calls this to unlock skills) ----
app.post("/api/holder", async (req, reply) => {
  const { wallet } = (req.body as any) || {};
  if (wallet && !isSolAddr(wallet))
    return reply.code(400).send({ error: "Invalid wallet address." });
  const info = await resolveHolder(wallet);
  return {
    ...info,
    scanLimit: scanLimitFor(info.tier),
    skills: {
      scan: true,
      whales: canUseSkill(info.tier, "whales"),
      watchlist: canUseSkill(info.tier, "watchlist"),
      smartmoney: canUseSkill(info.tier, "smartmoney"),
      alerts: canUseSkill(info.tier, "alerts"),
    },
  };
});

// ---- scan a wallet -> dossier ----
app.post("/api/scan", async (req, reply) => {
  const { address, wallet } = (req.body as any) || {};   // wallet = the *viewer* (for tier)
  if (!address || !isSolAddr(address))
    return reply.code(400).send({ error: "Enter a valid Solana address." });

  // resolve viewer tier -> limit
  const holder = await resolveHolder(wallet);
  const limit = scanLimitFor(holder.tier);

  const ip = clientIp(req);
  const quota = await consumeQuota(ip, limit);
  if (!quota.ok)
    return reply.code(429).send({
      error: `Daily scan limit reached (${limit}). ${holder.tier === "free" ? "Hold $STON for more." : ""}`.trim(),
      tier: holder.tier,
    });

  // cache
  const cached = cacheGet(address);
  if (cached) return { ...cached, cached: true, tier: holder.tier, scansLeft: limit - quota.used };

  try {
    const snap = await getWalletSnapshot(address);
    const dossier = await buildDossier(snap);
    const receipt = createHash("sha256")
      .update(JSON.stringify({ snap, dossier })).digest("hex");

    await supabase.from("scans").insert({
      address, archetype: dossier.archetype, score: dossier.score, receipt,
    });

    const out = { address, snapshot: snap, dossier, receipt, ts: Date.now() };
    cacheSet(address, out);
    return { ...out, cached: false, tier: holder.tier, scansLeft: limit - quota.used };
  } catch (e: any) {
    req.log.error(e);
    return reply.code(500).send({ error: "Scan failed. Chain or agent unavailable." });
  }
});

// ---- whale watch (holder-gated) ----
app.post("/api/whales", async (req, reply) => {
  const { wallet, address } = (req.body as any) || {};
  const holder = await resolveHolder(wallet);
  if (!canUseSkill(holder.tier, "whales"))
    return reply.code(403).send({ error: "Whale watch is holder-only. Hold $STON to unlock.", tier: holder.tier });

  // address optional: which token/wallet to watch. fall back to a tracked default.
  const target = address || process.env.DEFAULT_WHALE_TARGET || "";
  if (!isSolAddr(target))
    return reply.code(400).send({ error: "Provide a token mint or wallet to watch." });

  try {
    const events = await whaleEventsForAddress(target);
    return { target, events, ts: Date.now() };
  } catch (e: any) {
    req.log.error(e);
    return reply.code(500).send({ error: "Could not load whale activity." });
  }
});

// ---- watchlist (holder-gated): pin / list / unpin ----
app.post("/api/watchlist", async (req, reply) => {
  const { wallet, action, target, label } = (req.body as any) || {};
  if (!wallet || !isSolAddr(wallet))
    return reply.code(400).send({ error: "Connect a wallet to use the watchlist." });
  const holder = await resolveHolder(wallet);
  if (!canUseSkill(holder.tier, "watchlist"))
    return reply.code(403).send({ error: "Watchlist is holder-only. Hold $STON to unlock.", tier: holder.tier });

  if (action === "list") {
    const { data } = await supabase.from("watchlist")
      .select("target,label,created_at").eq("wallet", wallet).order("created_at", { ascending: false });
    return { items: data || [] };
  }
  if (action === "add") {
    if (!isSolAddr(target)) return reply.code(400).send({ error: "Invalid target address." });
    const { error } = await supabase.from("watchlist")
      .upsert({ wallet, target, label: label || null }, { onConflict: "wallet,target" });
    if (error) return reply.code(500).send({ error: "Could not pin." });
    return { ok: true };
  }
  if (action === "remove") {
    await supabase.from("watchlist").delete().eq("wallet", wallet).eq("target", target);
    return { ok: true };
  }
  return reply.code(400).send({ error: "Unknown action." });
});

// ---- boot ----
export { app };
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  app.listen({ port, host: "0.0.0.0" })
    .then(() => app.log.info(`STONHUB API on :${port}`))
    .catch((e) => { app.log.error(e); process.exit(1); });
}
