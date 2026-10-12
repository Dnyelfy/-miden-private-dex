import { useState, useEffect, useCallback, useMemo } from "react";
import { useBridge, useAssetMetadata, useSyncState } from "@miden-sdk/react";
import type { Asset } from "@miden-sdk/miden-wallet-adapter-base";
import {
  AGGLAYER_CONFIG_URL,
  AGGLAYER_BRIDGE_OVERRIDE,
  AGGLAYER_DEST_NETWORK,
  EXPLORER_BASE_URL,
} from "@/config";

// ─── Bridge configuration ──────────────────────────────────────────────────
//
// The Miden bridge account is not hard-coded. It is read at runtime from the
// public wallet config the Miden wallet itself uses, so if the bridge account
// is rotated this tab follows it without a redeploy. If the config cannot be
// loaded, or it says bridge-out is off, the tab is simply not shown.

export interface BridgeConfig {
  bridgeAccount: string;
  destinationNetwork: number;
  evmChainId: number;
}

const EVM_EXPLORERS: Record<number, { name: string; url: string }> = {
  1: { name: "Ethereum", url: "https://etherscan.io" },
  11155111: { name: "Sepolia", url: "https://sepolia.etherscan.io" },
};

function evmChain(chainId: number) {
  return EVM_EXPLORERS[chainId] ?? { name: `chain ${chainId}`, url: "" };
}

export function useBridgeConfig(): {
  config: BridgeConfig | null;
  loading: boolean;
} {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        let remoteBridge = "";
        let chainId = 11155111;
        let enabled = true;
        if (AGGLAYER_CONFIG_URL) {
          const res = await fetch(AGGLAYER_CONFIG_URL, { cache: "no-store" });
          if (res.ok) {
            const json = await res.json();
            remoteBridge = String(json?.agglayer?.midenBridge ?? "");
            chainId = Number(json?.evm?.chainId ?? chainId);
            if (json?.features && json.features.bridgeOut === false) enabled = false;
          }
        }
        const bridgeAccount = (AGGLAYER_BRIDGE_OVERRIDE || remoteBridge).trim();
        if (alive) {
          setConfig(
            enabled && bridgeAccount
              ? {
                  bridgeAccount,
                  destinationNetwork: AGGLAYER_DEST_NETWORK,
                  evmChainId: chainId,
                }
              : null,
          );
        }
      } catch {
        if (alive) {
          const bridgeAccount = AGGLAYER_BRIDGE_OVERRIDE.trim();
          setConfig(
            bridgeAccount
              ? {
                  bridgeAccount,
                  destinationNetwork: AGGLAYER_DEST_NETWORK,
                  evmChainId: 11155111,
                }
              : null,
          );
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return { config, loading };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const DEFAULT_DECIMALS = 6;
const LOG_KEY = "miden_bridge_log_v1";
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

const ERROR_HINTS: [RegExp, string][] = [
  [/insufficient|not enough|exceeds balance/i, "You do not have enough of that asset."],
  [/rejected|denied|cancell?ed by user|user rejected/i, "You cancelled the request in your wallet."],
  [/not connected|no wallet|wallet not found/i, "Your wallet is not connected."],
  [/timeout|timed out|deadline/i, "The network took too long to answer. Try again."],
  [/network|fetch|rpc|connection|offline/i, "Cannot reach the Miden network right now."],
  [/address/i, "That destination address does not look right."],
  [/faucet|asset/i, "That token cannot be bridged right now."],
];

function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  for (const [re, msg] of ERROR_HINTS) if (re.test(raw)) return msg;
  return "Something went wrong. Please try again.";
}

/** Parse a decimal string into base units without floating-point drift. */
function toBaseUnits(display: string, decimals: number): bigint {
  const s = display.trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") return 0n;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return -1n;
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

function fromBaseUnits(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function short(s: string, head = 8, tail = 6): string {
  if (!s || s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

interface BridgeLogEntry {
  txId: string;
  faucetId: string;
  amount: string; // base units
  decimals: number;
  destination: string;
  chainId: number;
  ts: number;
}

function loadLog(account: string): BridgeLogEntry[] {
  try {
    const raw = localStorage.getItem(`${LOG_KEY}:${account.toLowerCase()}`);
    return raw ? (JSON.parse(raw) as BridgeLogEntry[]) : [];
  } catch {
    return [];
  }
}

function saveLog(account: string, entries: BridgeLogEntry[]) {
  try {
    localStorage.setItem(`${LOG_KEY}:${account.toLowerCase()}`, JSON.stringify(entries));
  } catch {
    /* quota / private mode */
  }
}

const STAGE_LABEL: Record<string, string> = {
  idle: "",
  executing: "Building the bridge note…",
  proving: "Generating the proof…",
  submitting: "Submitting to Miden…",
  complete: "Done",
};

// ─── Component ─────────────────────────────────────────────────────────────

export function BridgeTab({
  accountId,
  assets,
  labelFor,
  config,
  onBridged,
  logTx,
}: {
  accountId: string;
  assets: Asset[];
  labelFor: (faucetId: string) => string;
  config: BridgeConfig;
  onBridged: () => void;
  logTx: (entry: {
    txId: string;
    type: "bridge";
    recipient: string;
    faucetId: string;
    amount: string;
    noteType: "public";
    ts: number;
  }) => void;
}) {
  const [faucetId, setFaucetId] = useState("");
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [rawErr, setRawErr] = useState<string | null>(null);
  const [doneTx, setDoneTx] = useState<string | null>(null);
  const [log, setLog] = useState<BridgeLogEntry[]>(() => loadLog(accountId));

  const { bridge, isLoading, stage, reset } = useBridge();
  const { sync } = useSyncState();

  useEffect(() => {
    setLog(loadLog(accountId));
  }, [accountId]);

  const assetIds = useMemo(() => assets.map((a) => a.faucetId), [assets]);
  const { assetMetadata } = useAssetMetadata(assetIds);

  const decimalsFor = useCallback(
    (id: string) => assetMetadata.get(id)?.decimals ?? DEFAULT_DECIMALS,
    [assetMetadata],
  );
  const symbolFor = useCallback(
    (id: string) => assetMetadata.get(id)?.symbol || labelFor(id),
    [assetMetadata, labelFor],
  );

  const chain = evmChain(config.evmChainId);
  const selected = assets.find((a) => a.faucetId === faucetId);
  const decimals = faucetId ? decimalsFor(faucetId) : DEFAULT_DECIMALS;
  const held = selected ? BigInt(selected.amount) : 0n;
  const baseAmount = toBaseUnits(amount, decimals);

  const handleMax = () => {
    if (selected) setAmount(fromBaseUnits(held, decimals));
  };

  const handleBridge = useCallback(async () => {
    setFormErr(null);
    setRawErr(null);
    setDoneTx(null);

    const dest = destination.trim();
    if (!faucetId) return setFormErr("Pick the token you want to bridge.");
    if (baseAmount === -1n)
      return setFormErr(`This token supports at most ${decimals} decimal places.`);
    if (baseAmount <= 0n) return setFormErr("Enter how much you want to bridge.");
    if (baseAmount > held)
      return setFormErr(`You only hold ${fromBaseUnits(held, decimals)} of that token.`);
    if (!EVM_ADDR.test(dest))
      return setFormErr(`Enter a valid ${chain.name} address (0x followed by 40 hex characters).`);
    if (!understood) return setFormErr("Please confirm you understand how bridging works.");

    try {
      const result = await bridge({
        from: accountId,
        bridgeAccount: config.bridgeAccount,
        assetId: faucetId,
        amount: baseAmount,
        destinationNetwork: config.destinationNetwork,
        destinationAddress: dest,
      });
      const txId = result.transactionId;
      setDoneTx(txId);

      const entry: BridgeLogEntry = {
        txId,
        faucetId,
        amount: baseAmount.toString(),
        decimals,
        destination: dest,
        chainId: config.evmChainId,
        ts: Date.now(),
      };
      const next = [entry, ...log].slice(0, 100);
      setLog(next);
      saveLog(accountId, next);

      logTx({
        txId,
        type: "bridge",
        recipient: dest,
        faucetId,
        amount: baseAmount.toString(),
        noteType: "public",
        ts: entry.ts,
      });

      setAmount("");
      setUnderstood(false);
      try {
        await sync?.();
      } catch {
        /* best effort */
      }
      onBridged();
    } catch (e) {
      const raw =
        e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
      setRawErr(raw);
      // eslint-disable-next-line no-console
      console.error("[bridge]", e);
      setFormErr(humanError(e));
    }
  }, [
    accountId, baseAmount, bridge, chain.name, config, decimals, destination,
    faucetId, held, log, logTx, onBridged, sync, understood,
  ]);

  const stageText = isLoading ? STAGE_LABEL[stage as string] ?? "Working…" : "";

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Bridge to {chain.name}</h2>
        </div>
        <p className="hint">
          Move a token from Miden to an address on {chain.name} through the
          AggLayer. The token is burned here and released to your{" "}
          {chain.name} address — no second signature needed on that side.
        </p>

        <div className="swap-form">
          <label className="swap-field">
            <span>Token</span>
            <div className="swap-row">
              <select
                value={faucetId}
                onChange={(e) => {
                  setFaucetId(e.target.value);
                  setAmount("");
                }}
                disabled={isLoading}
              >
                <option value="">select token</option>
                {assets.map((a) => (
                  <option key={a.faucetId} value={a.faucetId}>
                    {symbolFor(a.faucetId)} ·{" "}
                    {fromBaseUnits(BigInt(a.amount), decimalsFor(a.faucetId))}
                  </option>
                ))}
              </select>
            </div>
          </label>

          <label className="swap-field">
            <span>Amount</span>
            <div className="swap-row">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0"
                inputMode="decimal"
                disabled={isLoading || !faucetId}
              />
              <button
                type="button"
                className="ghost"
                onClick={handleMax}
                disabled={isLoading || !selected}
              >
                Max
              </button>
            </div>
          </label>

          <label className="swap-field">
            <span>Destination address on {chain.name}</span>
            <div className="swap-row">
              <input
                className="mono"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                disabled={isLoading}
              />
            </div>
          </label>

          <label className="bridge-ack">
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
              disabled={isLoading}
            />
            <span style={{ fontSize: ".85rem" }}>
              I understand a bridge note is public, the transfer cannot be
              undone, and arrival on {chain.name} can take up to an hour or more.
            </span>
          </label>
        </div>

        {formErr && (
          <div className="error-box">
            {formErr}
            {rawErr && (
              <details style={{ marginTop: "0.5rem", fontSize: "0.75rem", opacity: 0.8 }}>
                <summary style={{ cursor: "pointer" }}>Technical details</summary>
                <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all",
                  maxHeight: "12rem", overflow: "auto", margin: "0.4rem 0 0" }}>{rawErr}</pre>
              </details>
            )}
          </div>
        )}

        <button
          className="primary"
          onClick={handleBridge}
          disabled={isLoading || assets.length === 0}
          style={{ width: "100%", marginTop: ".5rem" }}
        >
          {isLoading ? stageText : `Bridge to ${chain.name}`}
        </button>

        {doneTx && (
          <div className="success-box" style={{ marginTop: "1rem" }}>
            Bridge note submitted.{" "}
            <a
              className="tx-link"
              href={`${EXPLORER_BASE_URL}/tx/${doneTx}`}
              target="_blank"
              rel="noreferrer"
            >
              View on Miden
            </a>
            <div style={{ fontSize: ".8rem", marginTop: ".4rem", opacity: 0.85 }}>
              The AggLayer claims it on {chain.name} automatically. Watch the
              destination address to see it arrive.
            </div>
            <button
              className="ghost"
              style={{ marginTop: ".5rem" }}
              onClick={() => {
                setDoneTx(null);
                reset();
              }}
            >
              Bridge again
            </button>
          </div>
        )}

        {assets.length === 0 && (
          <p className="empty">You need a token balance on Miden to bridge.</p>
        )}
      </div>

      {log.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Your bridge history</h2>
          </div>
          {log.map((b) => {
            const c = evmChain(b.chainId);
            return (
              <div key={b.txId} className="swap-offer">
                <div className="swap-offer-main">
                  <strong>
                    {fromBaseUnits(BigInt(b.amount), b.decimals)} {symbolFor(b.faucetId)}
                  </strong>
                  <span className="swap-offer-terms">
                    → <span className="mono">{short(b.destination, 8, 6)}</span> on {c.name} ·{" "}
                    {new Date(b.ts).toLocaleString()}
                  </span>
                </div>
                <div className="swap-offer-actions">
                  <a
                    className="tx-link"
                    href={`${EXPLORER_BASE_URL}/tx/${b.txId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Miden tx
                  </a>
                  {c.url && (
                    <a
                      className="tx-link"
                      href={`${c.url}/address/${b.destination}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {c.name}
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
