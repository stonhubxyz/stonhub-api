// src/whales.ts — recent large-flow detection via Helius enriched txns
const HELIUS = process.env.HELIUS_API_KEY!;

export type WhaleEvent = {
  wallet: string;
  direction: "in" | "out";
  amountSol: number;
  ts: number;
  sig: string;
  read: "signal" | "noise";
};

const WHALE_MIN_SOL = Number(process.env.WHALE_MIN_SOL ?? 1000);

// Scan a token mint's recent activity for large native moves.
// In practice you'd subscribe to a stream; here we sample enriched txns.
export async function whaleEventsForAddress(address: string, limit = 30): Promise<WhaleEvent[]> {
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS}&limit=${limit}`;
  const r = await fetch(url);
  const txs: any[] = await r.json().catch(() => []);
  if (!Array.isArray(txs)) return [];

  const events: WhaleEvent[] = [];
  for (const t of txs) {
    for (const nt of t.nativeTransfers || []) {
      const sol = (nt.amount || 0) / 1e9;
      if (sol < WHALE_MIN_SOL) continue;
      const isIn = nt.toUserAccount === address;
      const isOut = nt.fromUserAccount === address;
      if (!isIn && !isOut) continue;
      events.push({
        wallet: isIn ? nt.fromUserAccount : nt.toUserAccount,
        direction: isIn ? "in" : "out",
        amountSol: Math.round(sol),
        ts: t.timestamp,
        sig: t.signature,
        // heuristic read: very large single move during many txns = signal
        read: sol >= WHALE_MIN_SOL * 5 ? "signal" : "noise",
      });
    }
  }
  return events.sort((a, b) => b.ts - a.ts).slice(0, 20);
}
