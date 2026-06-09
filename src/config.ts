// Miden network configuration
export const APP_NAME = "Miden Private DEX";

export const MIDEN_RPC_URL =
  import.meta.env.VITE_MIDEN_RPC_URL ?? "testnet";

export const MIDEN_PROVER =
  (import.meta.env.VITE_MIDEN_PROVER as "devnet" | "testnet" | "local") ?? "testnet";

export const EXPLORER_BASE_URL = "https://testnet.midenscan.com";
