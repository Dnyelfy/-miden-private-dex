# Miden Private DEX

Private order book + matching demo on Miden testnet.

## Local development

```bash
npm install
npm run dev
```

## Deploy

Push to GitHub, import in Vercel. `vercel.json` sets the COOP/COEP headers
required for Miden WASM. No env vars are required for a default testnet build.

Optional env vars (in Vercel project → Settings → Environment Variables):

- `VITE_MIDEN_RPC_URL` — defaults to `testnet`
- `VITE_MIDEN_PROVER` — `testnet` | `devnet` | `local`, defaults to `testnet`

## Roadmap

- [x] Wallet connect (MidenFi)
- [x] Local order book + matching
- [ ] On-chain P2ID swap-note submission via Miden SDK
- [ ] Matchmaker backend service
- [ ] Atomic swap notes (Rust contract under `dex-contract/`)
