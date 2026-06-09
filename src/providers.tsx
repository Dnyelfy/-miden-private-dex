import { type ReactNode } from "react";
import { MidenProvider } from "@miden-sdk/react";
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter-react";
import { WalletAdapterNetwork } from "@miden-sdk/miden-wallet-adapter-base";
import { APP_NAME, MIDEN_RPC_URL, MIDEN_PROVER } from "@/config";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <MidenFiSignerProvider
      appName={APP_NAME}
      network={WalletAdapterNetwork.Testnet}
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
