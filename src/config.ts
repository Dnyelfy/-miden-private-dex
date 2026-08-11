// Miden network configuration
//
// Everything network-specific lives here. To move the whole dApp to another
// network, set VITE_MIDEN_NETWORK in Vercel and redeploy — no code changes.
export const APP_NAME = "Miden Privacy Suite";

export type Network = "devnet" | "testnet" | "mainnet";

const RAW = (import.meta.env.VITE_MIDEN_NETWORK ?? "testnet")
  .toString()
  .toLowerCase();

export const NETWORK: Network =
  RAW === "mainnet" || RAW === "devnet" ? (RAW as Network) : "testnet";

export const IS_MAINNET = NETWORK === "mainnet";

/** Human label shown in the header / share text. */
export const NETWORK_LABEL = NETWORK;

// RPC accepts either a shorthand ("testnet") or a full URL. On mainnet the
// shorthand may not be recognised by the SDK yet, so a full URL can be passed
// through VITE_MIDEN_RPC_URL.
export const MIDEN_RPC_URL: string =
  import.meta.env.VITE_MIDEN_RPC_URL ?? NETWORK;

export const MIDEN_PROVER: string =
  import.meta.env.VITE_MIDEN_PROVER ?? NETWORK;

// Private notes travel peer-to-peer over the note transport service. Without
// this the client refuses to send them: "note transport is disabled".
const TRANSPORTS: Record<Network, string> = {
  devnet: "https://transport.devnet.miden.io",
  testnet: "https://transport.miden.io",
  mainnet: "https://transport.miden.io",
};

export const NOTE_TRANSPORT_URL: string =
  import.meta.env.VITE_NOTE_TRANSPORT_URL ?? TRANSPORTS[NETWORK];

const EXPLORERS: Record<Network, string> = {
  devnet: "https://devnet.midenscan.com",
  testnet: "https://testnet.midenscan.com",
  mainnet: "https://midenscan.com",
};

export const EXPLORER_BASE_URL: string =
  import.meta.env.VITE_EXPLORER_URL ?? EXPLORERS[NETWORK];
