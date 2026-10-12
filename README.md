# Miden Privacy Suite

A private payments dApp on Miden. Send, pay many people at once, schedule
recurring pay, lock transfers you can pull back, swap peer-to-peer, bridge out
to Ethereum through the AggLayer, and see how much of your activity stayed private — all from the browser, with proofs
generated client-side.

Live: https://miden-private-dex.vercel.app

## What it does

| Tab | What it's for |
| --- | --- |
| **Send** | One private transfer. Optionally recallable, so you can pull it back. |
| **Bulk Pay** | Pay a list of addresses in one run. |
| **Payroll** | Fund several future payments at once. Each period unlocks on its own date and lands in the recipient's wallet with no further signing. |
| **Vault** | Reclaim transfers that were sent as recallable and never collected. |
| **Swap** | Send someone a swap offer as a link. They open it and settle in one click — no order book, no waiting for a counterparty to appear. |
| **Bridge** | Move a token from Miden to an Ethereum address (Sepolia on testnet) through the AggLayer. Claimed on the other side automatically. |
| **Privacy** | A breakdown of how much of your activity was private vs public. |

### How Payroll works

Miden has no allowance model — nobody can move your funds without your
signature. So a schedule is funded up front: the app creates one note per
period, each with a `timelockHeight` set to its own unlock block. Period one is
payable immediately, period two a full interval later, and so on.

Every note also carries a `recallHeight` one interval past its unlock, so
anything the recipient never collects can be reclaimed from the Vault tab. The
recipient always has first claim.

The trade-off is explicit in the UI: the full funded amount leaves your wallet
when you set the schedule. Fund one period or twelve — that choice is yours.

## Stack

React 19 · TypeScript · Vite · `@miden-sdk` 0.17.3 · MidenFi wallet adapter

## Local development

```bash
npm install
npm run dev
```

## Deploy

Push to GitHub and import the repo in Vercel. `vercel.json` sets the COOP/COEP
headers that Miden's WASM requires. A default testnet build needs no env vars.

### Configuration

Everything network-specific lives in `src/config.ts` and is driven by env vars,
so moving networks is a settings change rather than a code change.

| Variable | Default | Notes |
| --- | --- | --- |
| `VITE_MIDEN_NETWORK` | `testnet` | `testnet` · `devnet` · `mainnet`. Drives every default below. |
| `VITE_MIDEN_RPC_URL` | follows network | Shorthand or a full RPC URL. |
| `VITE_MIDEN_PROVER` | follows network | `testnet` · `devnet` · `local` or a URL. |
| `VITE_NOTE_TRANSPORT_URL` | follows network | Private notes travel peer-to-peer over this service. Without it the client rejects private sends. |
| `VITE_EXPLORER_URL` | follows network | Where transaction links point. |
| `VITE_AGGLAYER_CONFIG_URL` | Miden wallet config for the network | Where the bridge account is read from at runtime. |
| `VITE_AGGLAYER_BRIDGE_ACCOUNT` | from the config above | Pin a bridge account instead of reading it at runtime. |
| `VITE_AGGLAYER_DEST_NETWORK` | `0` | AggLayer network id of the destination chain (0 = Ethereum L1). |

To move to mainnet, set `VITE_MIDEN_NETWORK=mainnet` and redeploy.

> Note: as of `@miden-sdk` 0.17.3 the wallet adapter recognises `devnet`,
> `testnet` and `localnet` only. Mainnet support lands with a future SDK
> release; the configuration above is already in place for it.
>
> The Bridge tab only appears when a bridge account is available for the
> current network. If the config can't be loaded, the tab stays hidden.

## License

MIT
