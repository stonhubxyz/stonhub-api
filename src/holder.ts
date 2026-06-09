// src/holder.ts — $STON holder verification + tier resolution
const HELIUS = process.env.HELIUS_API_KEY!;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS}`;

// $STON mint — set at launch via env (CA). Until then gating is effectively off.
const STON_MINT = process.env.STON_MINT || "";

// tier thresholds (UI-amount of $STON)
const TIERS = {
  free:   Number(process.env.TIER_FREE_MAX   ?? 0),       // < holder min
  holder: Number(process.env.TIER_HOLDER_MIN ?? 50000),   // basic holder
  pro:    Number(process.env.TIER_PRO_MIN    ?? 500000),  // pro holder
};

export type Tier = "free" | "holder" | "pro";
export type HolderInfo = { tier: Tier; balance: number; gated: boolean };

const isSolAddr = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

async function rpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

// returns the wallet's $STON UI balance (0 if none / mint not set)
export async function getStonBalance(wallet: string): Promise<number> {
  if (!STON_MINT || !isSolAddr(wallet)) return 0;
  try {
    const res = await rpc("getTokenAccountsByOwner", [
      wallet,
      { mint: STON_MINT },
      { encoding: "jsonParsed" },
    ]);
    let total = 0;
    for (const acc of res?.value || []) {
      const ui = acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
      if (typeof ui === "number") total += ui;
    }
    return total;
  } catch {
    return 0;
  }
}

export function tierFor(balance: number): Tier {
  if (balance >= TIERS.pro) return "pro";
  if (balance >= TIERS.holder) return "holder";
  return "free";
}

// resolve a wallet to its tier. gated=false means $STON mint not configured yet
// (pre-launch) — in that case everyone is treated as "free" but not blocked by mint errors.
export async function resolveHolder(wallet?: string): Promise<HolderInfo> {
  const gated = !!STON_MINT;
  if (!wallet || !gated) return { tier: "free", balance: 0, gated };
  const balance = await getStonBalance(wallet);
  return { tier: tierFor(balance), balance, gated };
}

// daily scan limit per tier
export function scanLimitFor(tier: Tier): number {
  if (tier === "pro") return Number(process.env.PRO_SCAN_LIMIT ?? 1000);
  if (tier === "holder") return Number(process.env.HOLDER_SCAN_LIMIT ?? 100);
  return Number(process.env.FREE_SCAN_LIMIT ?? 5);
}

// which skills a tier can use
export function canUseSkill(tier: Tier, skill: "scan" | "whales" | "watchlist" | "smartmoney" | "alerts"): boolean {
  if (skill === "scan") return true;            // everyone
  return tier !== "free";                        // holder/pro only
}

export const TIER_INFO = TIERS;
