// src/chain.ts — Solana on-chain data via Helius
const HELIUS = process.env.HELIUS_API_KEY!;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS}`;

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

export type WalletSnapshot = {
  address: string;
  solBalance: number;
  txCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  uniqueTokens: number;
  recentTxns: { sig: string; ts: number; type: string }[];
  netSolFlow: number; // rough, from parsed txns sampled
};

// Lamports -> SOL
const toSol = (l: number) => l / 1e9;

export async function getWalletSnapshot(address: string): Promise<WalletSnapshot> {
  // balance
  const bal = await rpc("getBalance", [address]);
  const solBalance = toSol(bal?.value ?? 0);

  // signatures (most recent 100)
  const sigs: any[] = await rpc("getSignaturesForAddress", [address, { limit: 100 }]);
  const txCount = sigs.length;
  const lastSeen = sigs[0]?.blockTime ? new Date(sigs[0].blockTime * 1000).toISOString() : null;
  const firstSeen = sigs.at(-1)?.blockTime ? new Date(sigs.at(-1).blockTime * 1000).toISOString() : null;

  // enriched parse via Helius API (sample last 25)
  let recentTxns: WalletSnapshot["recentTxns"] = [];
  let netSolFlow = 0;
  try {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS}&limit=25`;
    const txr = await fetch(url);
    const txs: any[] = await txr.json();
    if (Array.isArray(txs)) {
      recentTxns = txs.map((t) => ({ sig: t.signature, ts: t.timestamp, type: t.type || "UNKNOWN" }));
      for (const t of txs) {
        for (const nt of t.nativeTransfers || []) {
          const amt = toSol(nt.amount || 0);
          if (nt.toUserAccount === address) netSolFlow += amt;
          if (nt.fromUserAccount === address) netSolFlow -= amt;
        }
      }
    }
  } catch { /* enriched optional */ }

  // token holdings count via DAS
  let uniqueTokens = 0;
  try {
    const assets = await rpc("getTokenAccountsByOwner", [
      address,
      { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
      { encoding: "jsonParsed" },
    ]);
    uniqueTokens = (assets?.value || []).filter(
      (a: any) => Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount) > 0
    ).length;
  } catch { /* optional */ }

  return {
    address, solBalance, txCount, firstSeen, lastSeen,
    uniqueTokens, recentTxns, netSolFlow: Math.round(netSolFlow * 100) / 100,
  };
}
