// src/agent.ts — the STONHUB agent (Claude Haiku 4.5 via OpenRouter)
import type { WalletSnapshot } from "./chain.js";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY!;
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-3.5-haiku";
const REFERER = process.env.OPENROUTER_REFERER || "https://stonhub.xyz";

export const ARCHETYPES = [
  "Smart Accumulator", "Diamond Holder", "Rotation Trader", "Sniper",
  "Bot Farmer", "Bridge Hopper", "LP Provider", "Airdrop Hunter",
  "Whale", "Dust Collector", "Fresh Wallet", "Serial Flipper",
  "Insider Pattern", "Ghost",
];

export type Dossier = {
  archetype: string;
  score: number;          // conviction 0-100
  confidence: number;     // 0-1
  summary: string;        // 1-2 sentence analyst read
  signals: string[];      // bullet evidence
  risk: "none" | "low" | "medium" | "high";
};

const SYSTEM = `You are STONHUB, an autonomous on-chain intelligence agent for Solana.
You receive a verified wallet snapshot and produce a concise analyst dossier.
Be sharp and evidence-based. Never give financial advice. Never invent data not in the snapshot.
Pick exactly ONE archetype from this list: ${ARCHETYPES.join(", ")}.
Respond ONLY with raw JSON, no markdown, no backticks, matching:
{"archetype": string, "score": number 0-100, "confidence": number 0-1, "summary": string, "signals": string[3-5], "risk": "none"|"low"|"medium"|"high"}`;

export async function buildDossier(snap: WalletSnapshot): Promise<Dossier> {
  let text = "";
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": REFERER,
        "X-Title": "STONHUB",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        temperature: 0.6,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Snapshot:\n${JSON.stringify(snap, null, 2)}` },
        ],
      }),
    });
    const j = await r.json();
    text = (j?.choices?.[0]?.message?.content || "").trim();
  } catch {
    text = "";
  }

  const clean = text.replace(/```json|```/g, "").trim();

  let parsed: Dossier;
  try {
    parsed = JSON.parse(clean);
  } catch {
    // fallback so the endpoint never hard-fails
    parsed = {
      archetype: snap.txCount < 5 ? "Fresh Wallet" : "Ghost",
      score: 50, confidence: 0.4,
      summary: "Insufficient signal to classify with high confidence.",
      signals: [`${snap.txCount} recent txns`, `${snap.solBalance} SOL balance`, `${snap.uniqueTokens} tokens held`],
      risk: "low",
    };
  }

  // clamp + guard
  if (!ARCHETYPES.includes(parsed.archetype)) parsed.archetype = "Ghost";
  parsed.score = Math.max(0, Math.min(100, Math.round(parsed.score)));
  parsed.confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.5));
  if (!Array.isArray(parsed.signals)) parsed.signals = [];
  return parsed;
}
