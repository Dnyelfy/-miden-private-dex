// Miden network configuration
export const APP_NAME = "Miden Privacy Suite";

export const MIDEN_RPC_URL =
  import.meta.env.VITE_MIDEN_RPC_URL ?? "testnet";

export const MIDEN_PROVER =
  (import.meta.env.VITE_MIDEN_PROVER as "devnet" | "testnet" | "local") ?? "testnet";

export const EXPLORER_BASE_URL = "https://testnet.midenscan.com";

// ─── Agglayer bridge ────────────────────────────────────────────────────────
// The bridge account consumes the B2AGG note and burns the asset so it can be
// claimed on the destination network. Set VITE_MIDEN_BRIDGE_ACCOUNT to the
// Miden testnet bridge account id before enabling the Bridge tab.
export const BRIDGE_ACCOUNT_ID: string =
  import.meta.env.VITE_MIDEN_BRIDGE_ACCOUNT ?? "";

// Agglayer-assigned network ids for bridge-out destinations.
export const BRIDGE_NETWORKS: { id: number; name: string }[] = [
  { id: 0, name: "Ethereum" },
  { id: 1, name: "Polygon zkEVM" },
];

export const BRIDGE_MONITOR_URL =
  "https://gateway-fm.github.io/miden-agglayer/bridge-monitor/bali/";
