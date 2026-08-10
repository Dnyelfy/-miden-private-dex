import { type ReactNode } from "react";
import { MidenProvider } from "@miden-sdk/react";
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter-react";
import { WalletAdapterNetwork } from "@miden-sdk/miden-wallet-adapter-base";
import { APP_NAME, MIDEN_RPC_URL, MIDEN_PROVER, NETWORK } from "@/config";

// The adapter enum does not list mainnet yet (SDK 0.15.x). Passing the plain
// string keeps this forward-compatible: the day the adapter adds it, this
// resolves without a code change.
const ADAPTER_NETWORK =
  NETWORK === "devnet"
    ? WalletAdapterNetwork.Devnet
    : NETWORK === "mainnet"
      ? ("mainnet" as WalletAdapterNetwork)
      : WalletAdapterNetwork.Testnet;

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <MidenFiSignerProvider
      appName={APP_NAME}
      network={ADAPTER_NETWORK}
      autoConnect
    >
      <MidenProvider
        config={{ rpcUrl: MIDEN_RPC_URL, prover: MIDEN_PROVER }}
        loadingComponent={
          <div style={{padding:"2rem",textAlign:"center",color:"#888"}}>
            Loading Miden WASM...
          </div>
        }
      >
        {children}
      </MidenProvider>
    </MidenFiSignerProvider>
  );
}
