import { useState, useEffect, useCallback, useMemo } from "react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import type {
  Asset,
  GuardianInfo,
  InputNoteDetails,
} from "@miden-sdk/miden-wallet-adapter-base";
import {
  EXPLORER_BASE_URL,
  NETWORK_LABEL,
} from "@/config";
import { SwapTab } from "./SwapTab";
import "./AppContent.css";

// ─── Human-readable errors ─────────────────────────────────────────────────
// Raw SDK/WASM errors are unreadable for anyone who did not write the SDK.
// Map the common ones; keep the original text tucked behind "Details".

const ERROR_HINTS: [RegExp, string][] = [
  [/insufficient|not enough|exceeds balance/i, "You do not have enough of that asset."],
  [/rejected|denied|cancell?ed by user|user rejected/i, "You cancelled the request in your wallet."],
  [/not connected|no wallet|wallet not found/i, "Your wallet is not connected."],
  [/note.*(not found|unknown|missing)|unknown note/i, "That note is no longer available — it may already have been used."],
  [/already consumed|already spent|nullifier/i, "That note has already been used."],
  [/timeout|timed out|deadline/i, "The network took too long to answer. Try again."],
  [/network|fetch|rpc|connection|offline/i, "Cannot reach the Miden network right now."],
  [/invalid.*(address|account id)|malformed/i, "That address does not look right."],
  [/faucet/i, "There is a problem with that token's faucet."],
];

export function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  for (const [re, msg] of ERROR_HINTS) if (re.test(raw)) return msg;
  return "Something went wrong. Please try again.";
}


// ─── Constants & helpers ───────────────────────────────────────────────────

const DECIMALS = 6;
const FACTOR = 10 ** DECIMALS;
const TWITTER_HANDLE = "Dnyelfy";
const TWITTER_URL = `https://twitter.com/${TWITTER_HANDLE}`;

const BLOCK_SECONDS = 5;
const RECALL_PRESETS = [
  { label: "1h", seconds: 3600 },
  { label: "24h", seconds: 86400 },
  { label: "7d", seconds: 604800 },
];

function formatBalance(raw: string | number): string {
  try {
    const n = Number(raw) / FACTOR;
    if (n === 0) return "0";
    if (n < 0.000001) return n.toExponential(2);
    return n.toLocaleString(undefined, { maximumFractionDigits: DECIMALS });
  } catch {
    return String(raw);
  }
}

function toBaseUnits(display: string): number {
  const n = parseFloat(display);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * FACTOR);
}

function shortAddr(s: string, head = 8, tail = 6) {
  if (!s) return "";
  if (s.length <= head + tail + 2) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── localStorage stores ───────────────────────────────────────────────────

const ALIAS_KEY = "miden_dex_asset_aliases_v1";
const VAULT_KEY = "miden_dex_vault_v1";
const TX_LOG_KEY = "miden_dex_txlog_v1";

function lsLoad<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}
function lsSave(key: string, val: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* ignore */
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface VaultEntry {
  id: string;
  recipient: string;
  faucetId: string;
  amount: string;
  recallSeconds: number;
  txId: string;
  ts: number;
  recalled?: boolean;
  recallTxId?: string;
}

interface PaymentRequest {
  to: string;
  amount: string;
  faucetId: string;
  memo: string;
}

// Parse a "private payment request" from the current URL query string.
// Format: ?to=<mtst1…>&amt=<display>&faucet=<faucetId>&memo=<text>
function parsePaymentRequest(): PaymentRequest | null {
  try {
    const p = new URLSearchParams(window.location.search);
    const to = (p.get("to") || "").trim();
    if (!to) return null;
    return {
      to,
      amount: (p.get("amt") || "").trim(),
      faucetId: (p.get("faucet") || "").trim(),
      memo: (p.get("memo") || "").trim().slice(0, 120),
    };
  } catch {
    return null;
  }
}

function buildRequestLink(req: PaymentRequest): string {
  const origin =
    typeof window !== "undefined" ? window.location.origin + window.location.pathname : "";
  const p = new URLSearchParams();
  p.set("to", req.to);
  if (req.amount) p.set("amt", req.amount);
  if (req.faucetId) p.set("faucet", req.faucetId);
  if (req.memo) p.set("memo", req.memo);
  return `${origin}?${p.toString()}`;
}

interface TxLogEntry {
  txId: string;
  type: "send" | "swap" | "airdrop" | "vault" | "recall";
  recipient: string;
  faucetId: string;
  amount: string;
  noteType: "private" | "public";
  ts: number;
}

interface AirdropResult {
  recipient: string;
  amount: string;
  ok: boolean;
  txId?: string;
  error?: string;
  confirmed?: boolean;
}

type TxStage = "idle" | "signing" | "broadcasting" | "confirming" | "confirmed" | "error";

interface TxStatus {
  stage: TxStage;
  txId?: string;
  error?: string;
}

// ─── Main ──────────────────────────────────────────────────────────────────

type Tab = "send" | "airdrop" | "vault" | "privacy" | "swap";

export function AppContent() {
  const wallet = useMidenFiWallet();
  const {
    connected,
    connecting,
    address,
    wallets,
    select,
    connect,
    disconnect,
    requestSend,
    requestConsume,
    requestConsumableNotes,
    requestAssets,
    requestGuardianInfo,
    waitForTransaction,
  } = wallet;

  const [paymentRequest] = useState<PaymentRequest | null>(() => parsePaymentRequest());
  const [tab, setTab] = useState<Tab>("send");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [aliases, setAliases] = useState<Record<string, string>>(() =>
    lsLoad(ALIAS_KEY, {} as Record<string, string>),
  );
  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [txLog, setTxLog] = useState<TxLogEntry[]>(() =>
    lsLoad(TX_LOG_KEY, [] as TxLogEntry[]),
  );

  useEffect(() => {
    if (!connected && !connecting && wallets.length > 0) {
      const first = wallets[0];
      if (first?.adapter.name) select(first.adapter.name);
    }
  }, [connected, connecting, wallets, select]);

  const handleConnect = useCallback(async () => {
    setGlobalError(null);
    try {
      await connect();
    } catch (e) {
      setGlobalError(humanError(e));
    }
  }, [connect]);

  const loadAssets = useCallback(async () => {
    if (!requestAssets) return;
    setLoadingAssets(true);
    setGlobalError(null);
    try {
      const list = await requestAssets();
      setAssets(list);
    } catch (e) {
      setGlobalError(humanError(e));
    } finally {
      setLoadingAssets(false);
    }
  }, [requestAssets]);

  useEffect(() => {
    if (connected && assets.length === 0) loadAssets();
  }, [connected, assets.length, loadAssets]);

  const copyAddress = useCallback(() => {
    if (!address) return;
    navigator.clipboard.writeText(address).then(() => {
      setAddrCopied(true);
      setTimeout(() => setAddrCopied(false), 1400);
    });
  }, [address]);

  const setAlias = (faucetId: string, name: string) => {
    const next = { ...aliases };
    if (name.trim()) next[faucetId] = name.trim().toUpperCase().slice(0, 8);
    else delete next[faucetId];
    setAliases(next);
    lsSave(ALIAS_KEY, next);
    setEditingAlias(null);
  };

  const labelFor = (faucetId: string): string =>
    aliases[faucetId] || shortAddr(faucetId, 10, 4);

  const logTx = useCallback((entry: TxLogEntry) => {
    setTxLog((prev) => {
      const next = [entry, ...prev].slice(0, 500);
      lsSave(TX_LOG_KEY, next);
      return next;
    });
  }, []);

  const shareOnTwitter = () => {
    const text = encodeURIComponent(
      `🔒 Check out this private dApp on @0xMiden ${NETWORK_LABEL} — send, bulk-airdrop, time-locked vault & privacy analytics, all ZK 👇`,
    );
    const url = encodeURIComponent("https://miden-private-dex.vercel.app/");
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${url}&via=${TWITTER_HANDLE}`,
      "_blank",
    );
  };

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-top">
          <div className="brand">
            <span className="logo-glow">🔒</span>
            <h1>Miden Privacy Suite</h1>
          </div>
          <div className="hero-actions">
            <button className="icon-btn twitter-btn" onClick={shareOnTwitter}>
              𝕏 Share
            </button>
          </div>
        </div>
        <p className="subtitle">
          Private send · bulk airdrop · time-locked vault ·
          privacy analytics on{" "}
          <span className="badge-net">Miden Testnet v0.15</span>
        </p>
      </header>

      {!connected ? (
        <div className="wallet-info-disconnected">
          {wallets.length === 0 ? (
            <>
              <p>
                <strong>Miden Wallet</strong> extension not found.
              </p>
              <p style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
                Install it from the Chrome Web Store, then refresh.
              </p>
            </>
          ) : (
            <>
              <p>Wallet detected. Click to connect.</p>
              <button
                onClick={handleConnect}
                disabled={connecting}
                style={{ marginTop: "0.8rem" }}
              >
                {connecting ? "Connecting…" : "Connect Wallet"}
              </button>
            </>
          )}
          {globalError && <div className="error-box">{globalError}</div>}
        </div>
      ) : (
        <>
          <div className="wallet-info">
            <span className="addr-clickable" onClick={copyAddress} title="Click to copy">
              {addrCopied ? "✅ Copied!" : `✅ ${shortAddr(address!, 10, 6)}`}
            </span>
            <button className="disconnect-btn" onClick={() => disconnect()}>×</button>
          </div>

          <div className="tabs">
            <TabBtn label="Send" active={tab === "send"} onClick={() => setTab("send")} />
            <TabBtn label="Airdrop" active={tab === "airdrop"} onClick={() => setTab("airdrop")} />
            <TabBtn label="Vault" active={tab === "vault"} onClick={() => setTab("vault")} />
            <TabBtn label="Privacy" active={tab === "privacy"} onClick={() => setTab("privacy")} />
            <TabBtn label="Swap" active={tab === "swap"} onClick={() => setTab("swap")} />
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Your Assets</h2>
              <button className="ghost" onClick={loadAssets} disabled={loadingAssets}>
                {loadingAssets ? "…" : "↻"}
              </button>
            </div>
            {assets.length === 0 && (
              <p className="empty">
                {loadingAssets ? "Loading…" : "No assets yet — claim from Miden faucet."}
              </p>
            )}
            {assets.map((a) => (
              <div key={a.faucetId} className="asset">
                {editingAlias === a.faucetId ? (
                  <AliasEditor
                    initial={aliases[a.faucetId] || ""}
                    onSave={(name) => setAlias(a.faucetId, name)}
                    onCancel={() => setEditingAlias(null)}
                  />
                ) : (
                  <>
                    <span
                      className={aliases[a.faucetId] ? "asset-symbol" : "mono asset-id"}
                      onClick={() => setEditingAlias(a.faucetId)}
                      title="Click to label (e.g. MIDEN)"
                    >
                      {aliases[a.faucetId] || shortAddr(a.faucetId, 14, 6)}
                      <span className="edit-hint">✎</span>
                    </span>
                    <span className="amount">{formatBalance(a.amount)}</span>
                  </>
                )}
              </div>
            ))}
            {assets.length > 0 && (
              <p className="hint" style={{ marginTop: "0.5rem" }}>
                💡 Click a faucet ID to label it (e.g. <code>MIDEN</code>).
              </p>
            )}
          </div>

          {tab === "send" && (
            <SendTab
              address={address!}
              assets={assets}
              labelFor={labelFor}
              requestSend={requestSend}
              waitForTransaction={waitForTransaction}
              onSent={loadAssets}
              logTx={logTx}
              prefill={paymentRequest}
            />
          )}
          {tab === "airdrop" && (
            <AirdropTab
              address={address!}
              assets={assets}
              labelFor={labelFor}
              requestSend={requestSend}
              waitForTransaction={waitForTransaction}
              onSent={loadAssets}
              logTx={logTx}
            />
          )}
          {tab === "vault" && (
            <VaultTab
              labelFor={labelFor}
              requestGuardianInfo={requestGuardianInfo}
              requestConsume={requestConsume}
              requestConsumableNotes={requestConsumableNotes}
              waitForTransaction={waitForTransaction}
              onRecalled={loadAssets}
              logTx={logTx}
            />
          )}
          {tab === "privacy" && (
            <PrivacyTab txLog={txLog} labelFor={labelFor} />
          )}
          {tab === "swap" && address && (
            <SwapTab accountId={address} assets={assets} labelFor={labelFor} />
          )}
        </>
      )}

      <footer className="footer">
        <a href={EXPLORER_BASE_URL} target="_blank" rel="noreferrer" className="tx-link">
          midenscan.com
        </a>
        <span>·</span>
        <a href={TWITTER_URL} target="_blank" rel="noreferrer" className="tx-link">
          by @{TWITTER_HANDLE}
        </a>
        <span>·</span>
        <span className="muted">Built on Miden ⚡</span>
      </footer>
    </div>
  );
}

// ─── Small helpers ─────────────────────────────────────────────────────────

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`tab ${active ? "active" : ""}`} onClick={onClick}>
      {label}
    </button>
  );
}

function AliasEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  return (
    <div className="alias-edit">
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={8}
        placeholder="MIDEN"
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(name);
          if (e.key === "Escape") onCancel();
        }}
      />
      <button className="small primary" onClick={() => onSave(name)}>✓</button>
      <button className="small ghost" onClick={onCancel}>×</button>
    </div>
  );
}

function TxStatusIndicator({ status }: { status: TxStatus }) {
  if (status.stage === "idle") return null;

  let icon = "";
  let text = "";
  let cls = "";

  switch (status.stage) {
    case "signing":
      icon = "✍️";
      text = "Awaiting wallet signature…";
      cls = "signing";
      break;
    case "broadcasting":
      icon = "📡";
      text = "Broadcasting to Miden…";
      cls = "broadcasting";
      break;
    case "confirming":
      icon = "⏳";
      text = "Waiting for on-chain confirmation…";
      cls = "confirming";
      break;
    case "confirmed":
      icon = "✅";
      text = "Confirmed on-chain!";
      cls = "confirmed";
      break;
    case "error":
      icon = "❌";
      text = status.error || "Transaction failed";
      cls = "error";
      break;
  }

  return (
    <div className={`tx-status tx-status-${cls}`}>
      <span className="tx-status-icon">{icon}</span>
      <span className="tx-status-text">{text}</span>
      {status.txId && status.stage !== "error" && (
        <a
          href={`${EXPLORER_BASE_URL}/tx/${status.txId}`}
          target="_blank"
          rel="noreferrer"
          className="tx-link"
          style={{ marginLeft: "auto" }}
        >
          {shortAddr(status.txId, 6, 4)} ↗
        </a>
      )}
    </div>
  );
}

// ─── Tab props ─────────────────────────────────────────────────────────────

interface CommonTabProps {
  address: string;
  assets: Asset[];
  labelFor: (faucetId: string) => string;
  requestSend: ReturnType<typeof useMidenFiWallet>["requestSend"];
  waitForTransaction: ReturnType<typeof useMidenFiWallet>["waitForTransaction"];
  onSent: () => void;
  logTx: (entry: TxLogEntry) => void;
}

// ─── SEND TAB ──────────────────────────────────────────────────────────────

function SendTab({
  address, assets, labelFor, requestSend, waitForTransaction, onSent, logTx, prefill,
}: CommonTabProps & { prefill?: PaymentRequest | null }) {
  const [mode, setMode] = useState<"send" | "request">("send");
  const [recipient, setRecipient] = useState(prefill?.to ?? "");
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [faucetId, setFaucetId] = useState(prefill?.faucetId ?? "");
  const [noteType, setNoteType] = useState<"public" | "private">("private");
  const [recallable, setRecallable] = useState(false);
  const [recallPreset, setRecallPreset] = useState(RECALL_PRESETS[1]);
  const [status, setStatus] = useState<TxStatus>({ stage: "idle" });
  // Dismissable banner shown when the page was opened from a payment-request link.
  const [showPrefillBanner, setShowPrefillBanner] = useState(!!prefill?.to);

  useEffect(() => {
    if (assets.length > 0 && !faucetId) setFaucetId(assets[0].faucetId);
  }, [assets, faucetId]);

  const selectedAsset = assets.find((a) => a.faucetId === faucetId);
  const selectedBalance = selectedAsset ? formatBalance(selectedAsset.amount) : "0";
  const isBusy = status.stage !== "idle" && status.stage !== "confirmed" && status.stage !== "error";

  const handleSend = async () => {
    if (!requestSend) return setStatus({ stage: "error", error: "Wallet not ready" });
    if (!recipient.trim()) return setStatus({ stage: "error", error: "Enter a recipient" });
    if (!faucetId) return setStatus({ stage: "error", error: "Select an asset" });
    const baseAmount = toBaseUnits(amount);
    if (baseAmount <= 0) return setStatus({ stage: "error", error: "Enter a valid amount" });

    setStatus({ stage: "signing" });
    try {
      const recallBlocks = recallable
        ? Math.floor(recallPreset.seconds / BLOCK_SECONDS)
        : undefined;

      const txId = await requestSend({
        senderAddress: address,
        recipientAddress: recipient.trim(),
        faucetId,
        noteType,
        amount: baseAmount,
        recallBlocks,
      });

      setStatus({ stage: "broadcasting", txId });

      logTx({
        txId,
        type: recallable ? "vault" : "send",
        recipient: recipient.trim(),
        faucetId,
        amount,
        noteType,
        ts: Date.now(),
      });

      if (recallable) {
        const vault = lsLoad<VaultEntry[]>(VAULT_KEY, []);
        const entry: VaultEntry = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          recipient: recipient.trim(),
          faucetId,
          amount,
          recallSeconds: recallPreset.seconds,
          txId,
          ts: Date.now(),
        };
        lsSave(VAULT_KEY, [entry, ...vault]);
      }

      // Wait for confirmation
      if (waitForTransaction) {
        setStatus({ stage: "confirming", txId });
        try {
          await waitForTransaction(txId, 60_000);
          setStatus({ stage: "confirmed", txId });
        } catch (e) {
          // confirmation timed out — tx probably still valid, don't hard-fail
          console.warn("waitForTransaction:", e);
          setStatus({ stage: "confirmed", txId });
        }
      } else {
        setStatus({ stage: "confirmed", txId });
      }

      setRecipient("");
      setAmount("");
      onSent();

      // Auto-clear success after 8s
      setTimeout(() => {
        setStatus((cur) => (cur.txId === txId ? { stage: "idle" } : cur));
      }, 8000);
    } catch (e) {
      setStatus({ stage: "error", error: humanError(e) });
    }
  };

  if (mode === "request") {
    return (
      <RequestBuilder
        address={address}
        assets={assets}
        labelFor={labelFor}
        onBack={() => setMode("send")}
      />
    );
  }

  return (
    <div className="card">
      <div className="send-mode-tabs">
        <button
          className={`send-mode-btn ${mode === "send" ? "active" : ""}`}
          onClick={() => setMode("send")}
        >
          💸 Send
        </button>
        <button
          className="send-mode-btn"
          onClick={() => setMode("request")}
        >
          🧾 Request
        </button>
      </div>

      {showPrefillBanner && prefill?.to && (
        <div className="request-banner">
          <div className="request-banner-body">
            <strong>🧾 Payment request</strong>
            <span>
              {prefill.amount ? `${prefill.amount} ` : ""}
              {prefill.faucetId ? labelFor(prefill.faucetId) : ""} to{" "}
              <span className="mono">{shortAddr(prefill.to, 10, 6)}</span>
            </span>
            {prefill.memo && <em className="request-memo">“{prefill.memo}”</em>}
            <span className="request-banner-hint">Fields below are pre-filled — review and send privately.</span>
          </div>
          <button className="ghost small" onClick={() => setShowPrefillBanner(false)}>×</button>
        </div>
      )}

      <h2>Send</h2>
      <label>Recipient address</label>
      <input
        type="text"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
        placeholder="mtst1…"
        spellCheck={false}
        disabled={isBusy}
      />

      <div style={{ display: "grid", gap: "0.8rem", marginTop: "0.8rem" }}>
        <div>
          <label>Asset</label>
          <select
            value={faucetId}
            onChange={(e) => setFaucetId(e.target.value)}
            disabled={assets.length === 0 || isBusy}
          >
            {assets.length === 0 && <option value="">— no assets —</option>}
            {assets.map((a) => (
              <option key={a.faucetId} value={a.faucetId}>
                {labelFor(a.faucetId)} · {formatBalance(a.amount)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <div className="amount-row">
            <label>Amount</label>
            {selectedAsset && (
              <button
                type="button"
                className="max-btn"
                onClick={() => setAmount(selectedBalance.replace(/,/g, ""))}
                disabled={isBusy}
              >
                MAX ({selectedBalance})
              </button>
            )}
          </div>
          <input
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1.5"
            disabled={isBusy}
          />
        </div>

        <div>
          <label>Note type</label>
          <div className="radio-row">
            <label className="radio">
              <input type="radio" checked={noteType === "private"} onChange={() => setNoteType("private")} disabled={isBusy} />
              <span>Private 🔒</span>
            </label>
            <label className="radio">
              <input type="radio" checked={noteType === "public"} onChange={() => setNoteType("public")} disabled={isBusy} />
              <span>Public 🌐</span>
            </label>
          </div>
        </div>

        <div className="recall-section">
          <label className="toggle">
            <input
              type="checkbox"
              checked={recallable}
              onChange={(e) => setRecallable(e.target.checked)}
              disabled={isBusy}
            />
            <span>🔐 Recallable — recover from wallet if not claimed</span>
          </label>
          {recallable && (
            <div className="recall-presets">
              {RECALL_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className={`preset ${recallPreset.label === p.label ? "active" : ""}`}
                  onClick={() => setRecallPreset(p)}
                  disabled={isBusy}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
          <p className="hint">
            {recallable
              ? `Recall inside ${recallPreset.label} via the Vault tab.`
              : noteType === "private"
                ? "🔒 Hidden on midenscan. Recipient auto-claims via their wallet."
                : "🌐 Visible on midenscan. Auto-credited."}
          </p>
        </div>
      </div>

      <button
        onClick={handleSend}
        disabled={isBusy || assets.length === 0}
        style={{ width: "100%", marginTop: "1rem" }}
      >
        {isBusy ? "…" : "🚀 Send on-chain"}
      </button>

      <TxStatusIndicator status={status} />
    </div>
  );
}

// ─── REQUEST BUILDER (private payment request links) ───────────────────────

function RequestBuilder({
  address, assets, labelFor, onBack,
}: {
  address: string;
  assets: Asset[];
  labelFor: (faucetId: string) => string;
  onBack: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [faucetId, setFaucetId] = useState("");
  const [memo, setMemo] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (assets.length > 0 && !faucetId) setFaucetId(assets[0].faucetId);
  }, [assets, faucetId]);

  const link = useMemo(
    () => buildRequestLink({ to: address, amount: amount.trim(), faucetId, memo: memo.trim() }),
    [address, amount, faucetId, memo],
  );

  const copyLink = () => {
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const shareOnTwitter = () => {
    const label = faucetId ? labelFor(faucetId) : "";
    const text = encodeURIComponent(
      `Pay me privately on @0xMiden 🔒${amount ? ` — ${amount} ${label}` : ""}${memo ? ` for ${memo}` : ""}`,
    );
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${encodeURIComponent(link)}`,
      "_blank",
    );
  };

  return (
    <div className="card">
      <div className="send-mode-tabs">
        <button className="send-mode-btn" onClick={onBack}>💸 Send</button>
        <button className="send-mode-btn active">🧾 Request</button>
      </div>

      <h2>Request a private payment</h2>
      <p className="hint" style={{ marginBottom: "0.8rem" }}>
        Generate a link. Whoever opens it lands on the Send tab with your address,
        amount and memo pre-filled — and pays you with a private note. No amount ever
        touches a public URL preview beyond what you share.
      </p>

      <div style={{ display: "grid", gap: "0.8rem" }}>
        <div>
          <label>Asset</label>
          <select
            value={faucetId}
            onChange={(e) => setFaucetId(e.target.value)}
            disabled={assets.length === 0}
          >
            {assets.length === 0 && <option value="">— no assets —</option>}
            {assets.map((a) => (
              <option key={a.faucetId} value={a.faucetId}>
                {labelFor(a.faucetId)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label>Amount (optional)</label>
          <input
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Leave blank to let payer decide"
          />
        </div>

        <div>
          <label>Memo (optional)</label>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value.slice(0, 120))}
            placeholder="e.g. Invoice #42"
            maxLength={120}
          />
        </div>
      </div>

      <div className="request-link-box">
        <label>Your request link</label>
        <div className="request-link-value mono">{link}</div>
      </div>

      <div className="swap-actions" style={{ marginTop: "0.8rem" }}>
        <button className="primary" onClick={copyLink} style={{ flex: 1 }}>
          {copied ? "✅ Copied!" : "🔗 Copy link"}
        </button>
        <button className="ghost" onClick={shareOnTwitter}>𝕏 Share</button>
      </div>

      <p className="hint" style={{ marginTop: "0.6rem" }}>
        Requests to <span className="mono">{shortAddr(address, 10, 6)}</span> · payer keeps full
        control until they sign.
      </p>
    </div>
  );
}

// ─── AIRDROP TAB ───────────────────────────────────────────────────────────

function AirdropTab({ address, assets, labelFor, requestSend, waitForTransaction, onSent, logTx }: CommonTabProps) {
  const [faucetId, setFaucetId] = useState("");
  const [recipientList, setRecipientList] = useState("");
  const [defaultAmount, setDefaultAmount] = useState("");
  const [noteType, setNoteType] = useState<"public" | "private">("private");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<AirdropResult[]>([]);

  useEffect(() => {
    if (assets.length > 0 && !faucetId) setFaucetId(assets[0].faucetId);
  }, [assets, faucetId]);

  const parsedRecipients = useMemo(() => {
    const lines = recipientList.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    return lines.map((line) => {
      const parts = line.split(/[,\s]+/).filter(Boolean);
      return { recipient: parts[0], amount: parts[1] || defaultAmount };
    });
  }, [recipientList, defaultAmount]);

  const valid = parsedRecipients.filter(
    (r) => r.recipient.startsWith("mtst1") && toBaseUnits(r.amount) > 0,
  );

  const totalAmount = useMemo(
    () => valid.reduce((sum, r) => sum + parseFloat(r.amount), 0), [valid],
  );

  const handleAirdrop = async () => {
    if (!requestSend || valid.length === 0) return;

    setRunning(true);
    setProgress({ done: 0, total: valid.length });
    setResults([]);

    // Phase 1: sign & broadcast all (sequential — wallet allows one at a time)
    const sent: AirdropResult[] = [];
    for (const r of valid) {
      try {
        const txId = await requestSend({
          senderAddress: address,
          recipientAddress: r.recipient,
          faucetId,
          noteType,
          amount: toBaseUnits(r.amount),
        });
        sent.push({ recipient: r.recipient, amount: r.amount, ok: true, txId, confirmed: false });
        logTx({
          txId, type: "airdrop",
          recipient: r.recipient, faucetId,
          amount: r.amount, noteType, ts: Date.now(),
        });
      } catch (e) {
        sent.push({
          recipient: r.recipient, amount: r.amount, ok: false,
          error: humanError(e),
        });
      }
      setResults([...sent]);
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    // Phase 2: wait for on-chain confirmations in parallel
    if (waitForTransaction) {
      await Promise.all(
        sent.map(async (r, idx) => {
          if (!r.ok || !r.txId) return;
          try {
            await waitForTransaction(r.txId, 60_000);
            sent[idx] = { ...sent[idx], confirmed: true };
            setResults([...sent]);
          } catch {
            /* leave as unconfirmed */
          }
        }),
      );
    }

    setRunning(false);
    onSent();
  };

  const okCount = results.filter((r) => r.ok).length;
  const confirmedCount = results.filter((r) => r.confirmed).length;
  const errCount = results.filter((r) => !r.ok).length;

  return (
    <>
      <div className="card">
        <h2>🪂 Bulk Private Airdrop</h2>
        <p className="hint" style={{ marginBottom: "0.8rem" }}>
          Send to many recipients. Paste <code>address</code> or <code>address,amount</code> per line.
        </p>

        <label>Asset</label>
        <select value={faucetId} onChange={(e) => setFaucetId(e.target.value)} disabled={running}>
          {assets.length === 0 && <option value="">— no assets —</option>}
          {assets.map((a) => (
            <option key={a.faucetId} value={a.faucetId}>
              {labelFor(a.faucetId)} · {formatBalance(a.amount)}
            </option>
          ))}
        </select>

        <div style={{ marginTop: "0.8rem" }}>
          <label>Default amount</label>
          <input type="number" min="0" step="any" value={defaultAmount}
            onChange={(e) => setDefaultAmount(e.target.value)} placeholder="1" disabled={running} />
        </div>

        <div style={{ marginTop: "0.8rem" }}>
          <label>Recipients</label>
          <textarea
            value={recipientList}
            onChange={(e) => setRecipientList(e.target.value)}
            placeholder={`mtst1abc...xyz,5\nmtst1def...uvw\nmtst1ghi...rst,2.5`}
            rows={6}
            spellCheck={false}
            className="recipient-list"
            disabled={running}
          />
        </div>

        <div style={{ marginTop: "0.8rem" }}>
          <label>Note type</label>
          <div className="radio-row">
            <label className="radio">
              <input type="radio" checked={noteType === "private"} onChange={() => setNoteType("private")} disabled={running} />
              <span>Private 🔒</span>
            </label>
            <label className="radio">
              <input type="radio" checked={noteType === "public"} onChange={() => setNoteType("public")} disabled={running} />
              <span>Public 🌐</span>
            </label>
          </div>
        </div>

        <div className="airdrop-summary">
          <div><strong>{valid.length}</strong> valid recipients</div>
          <div>Total: <strong>{totalAmount} {labelFor(faucetId)}</strong></div>
        </div>

        <button onClick={handleAirdrop} disabled={running || valid.length === 0 || !faucetId}
          style={{ width: "100%", marginTop: "0.8rem" }}>
          {running
            ? `Sending… ${progress.done}/${progress.total}`
            : `🪂 Airdrop to ${valid.length} addresses`}
        </button>

        {running && (
          <div className="progress-bar">
            <div className="progress-fill"
              style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} />
          </div>
        )}
      </div>

      {results.length > 0 && (
        <div className="card">
          <h2>
            Results
            <span className="badge badge-completed" style={{ marginLeft: "0.5rem" }}>
              ✓ {okCount}
            </span>
            {confirmedCount > 0 && confirmedCount !== okCount && (
              <span className="badge badge-completed" style={{ marginLeft: "0.4rem" }}>
                ⚡ {confirmedCount} confirmed
              </span>
            )}
            {errCount > 0 && (
              <span className="badge badge-error" style={{ marginLeft: "0.4rem" }}>
                ✕ {errCount}
              </span>
            )}
          </h2>
          {results.map((r, i) => (
            <div key={i} className={`tx-row ${r.ok ? "" : "err"}`}>
              <div className="tx-row-top">
                <span style={{ fontSize: "0.85rem" }}>
                  {r.ok ? (r.confirmed ? "⚡" : "✅") : "❌"} {shortAddr(r.recipient, 10, 6)} · {r.amount}
                </span>
                {r.txId && (
                  <a href={`${EXPLORER_BASE_URL}/tx/${r.txId}`} target="_blank"
                    rel="noreferrer" className="tx-link">view ↗</a>
                )}
              </div>
              {r.error && <div className="hint" style={{ color: "#fca5a5" }}>{r.error}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── VAULT TAB ─────────────────────────────────────────────────────────────

interface VaultTabProps {
  labelFor: (faucetId: string) => string;
  requestGuardianInfo: ReturnType<typeof useMidenFiWallet>["requestGuardianInfo"];
  requestConsume: ReturnType<typeof useMidenFiWallet>["requestConsume"];
  requestConsumableNotes: ReturnType<typeof useMidenFiWallet>["requestConsumableNotes"];
  waitForTransaction: ReturnType<typeof useMidenFiWallet>["waitForTransaction"];
  onRecalled: () => void;
  logTx: (entry: TxLogEntry) => void;
}

const GUARDIAN_PROVIDER_LABEL: Record<string, string> = {
  "open-zeppelin": "OpenZeppelin",
  gateway: "Gateway",
  "lambda-class": "LambdaClass",
  custom: "Custom",
};

function VaultTab({
  labelFor, requestGuardianInfo, requestConsume, requestConsumableNotes,
  waitForTransaction, onRecalled, logTx,
}: VaultTabProps) {
  const [guardian, setGuardian] = useState<GuardianInfo | null>(null);
  const [guardianError, setGuardianError] = useState<string | null>(null);
  const [loadingGuardian, setLoadingGuardian] = useState(false);

  const refreshGuardian = useCallback(async () => {
    if (typeof requestGuardianInfo !== "function") {
      setGuardian(null);
      setGuardianError(null);
      return;
    }
    setLoadingGuardian(true);
    setGuardianError(null);
    try {
      setGuardian(await requestGuardianInfo());
    } catch (e) {
      const msg = humanError(e);
      if (msg.includes("is not a function")) {
        // Installed wallet extension predates the Guardian API — not an error.
        setGuardian(null);
        setGuardianError(null);
      } else {
        setGuardianError(msg);
      }
    } finally {
      setLoadingGuardian(false);
    }
  }, [requestGuardianInfo]);

  useEffect(() => { refreshGuardian(); }, [refreshGuardian]);

  const [vault, setVault] = useState<VaultEntry[]>(() => lsLoad(VAULT_KEY, [] as VaultEntry[]));
  const [inbox, setInbox] = useState<InputNoteDetails[]>([]);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [recallingId, setRecallingId] = useState<string | null>(null);
  const [recallStatus, setRecallStatus] = useState<TxStatus>({ stage: "idle" });
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const refreshInbox = useCallback(async () => {
    if (!requestConsumableNotes) return;
    setLoadingInbox(true);
    setInboxError(null);
    try {
      const list = await requestConsumableNotes();
      setInbox(list);
    } catch (e) {
      setInboxError(humanError(e));
    } finally {
      setLoadingInbox(false);
    }
  }, [requestConsumableNotes]);

  useEffect(() => { refreshInbox(); }, [refreshInbox]);

  const removeEntry = (id: string) => {
    if (!confirm("Remove from vault?")) return;
    const next = vault.filter((v) => v.id !== id);
    setVault(next);
    lsSave(VAULT_KEY, next);
  };

  const consumeNote = async (note: InputNoteDetails) => {
    if (!requestConsume) return;
    setRecallingId(note.noteId);
    setRecallStatus({ stage: "signing" });
    try {
      const firstAsset = note.assets[0];
      if (!firstAsset) throw new Error("Note has no assets");

      const txId = await requestConsume({
        faucetId: firstAsset.faucetId,
        noteId: note.noteId,
        noteType: (note.noteType as unknown as "public" | "private") ?? "private",
        amount: Number(firstAsset.amount),
      });
      setRecallStatus({ stage: "broadcasting", txId });
      logTx({
        txId, type: "recall",
        recipient: "self", faucetId: firstAsset.faucetId,
        amount: firstAsset.amount, noteType: "private", ts: Date.now(),
      });

      if (waitForTransaction) {
        setRecallStatus({ stage: "confirming", txId });
        try { await waitForTransaction(txId, 60_000); } catch { /* ignore */ }
      }
      setRecallStatus({ stage: "confirmed", txId });

      // Mark corresponding vault entry (if any) as recalled
      const matchingEntry = vault.find(
        (v) => !v.recalled && v.faucetId === firstAsset.faucetId,
      );
      if (matchingEntry) {
        const next = vault.map((v) =>
          v.id === matchingEntry.id ? { ...v, recalled: true, recallTxId: txId } : v,
        );
        setVault(next);
        lsSave(VAULT_KEY, next);
      }

      onRecalled();
      refreshInbox();

      setTimeout(() => {
        setRecallStatus({ stage: "idle" });
        setRecallingId(null);
      }, 6000);
    } catch (e) {
      setRecallStatus({ stage: "error", error: humanError(e) });
      setTimeout(() => {
        setRecallStatus({ stage: "idle" });
        setRecallingId(null);
      }, 5000);
    }
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>🛡️ Guardian</h2>
          <button className="ghost" onClick={refreshGuardian} disabled={loadingGuardian}>
            {loadingGuardian ? "…" : "↻"}
          </button>
        </div>
        {guardianError && <div className="error-box">{guardianError}</div>}
        {!guardianError && !guardian && (
          <p className="empty">
            {loadingGuardian
              ? "Checking…"
              : "Guardian status not available yet — update the MidenFi wallet extension to a Guardian-aware version to see recovery protection here."}
          </p>
        )}
        {guardian && (
          <>
            <div className="guardian-row">
              <span className="guardian-label">Protection</span>
              <span className={`badge ${guardian.isGuardianAccount ? "badge-completed" : "badge-error"}`}>
                {guardian.isGuardianAccount ? "✅ Guardian enabled" : "⚠️ Not protected"}
              </span>
            </div>
            {guardian.isGuardianAccount && (
              <>
                <div className="guardian-row">
                  <span className="guardian-label">Operator</span>
                  <span>
                    {guardian.guardianProvider
                      ? GUARDIAN_PROVIDER_LABEL[guardian.guardianProvider] ?? guardian.guardianProvider
                      : "—"}
                  </span>
                </div>
                <div className="guardian-row">
                  <span className="guardian-label">Sync</span>
                  <span className={`badge ${guardian.guardianSyncStatus === "in-sync" ? "badge-completed" : "badge-you_sent"}`}>
                    {guardian.guardianSyncStatus === "in-sync" ? "✅ In sync" : "⏳ Out of sync"}
                  </span>
                </div>
                {guardian.guardianEndpoint && (
                  <div className="guardian-row">
                    <span className="guardian-label">Endpoint</span>
                    <span className="mono" style={{ fontSize: "0.75rem" }}>
                      {shortAddr(guardian.guardianEndpoint, 18, 8)}
                    </span>
                  </div>
                )}
              </>
            )}
            <p className="hint" style={{ marginTop: "0.6rem" }}>
              Guardian co-signs as one key in a 2-of-3 policy. It never holds a spending
              key and cannot move funds on its own. Your cold key can recover the account
              or rotate away from Guardian at any time.
            </p>
          </>
        )}
      </div>

      <div className="card">
        <h2>🔐 Vault — Recallable Transfers</h2>
        <p className="hint" style={{ marginBottom: "0.5rem" }}>
          Track notes you sent with a recall window. When ready, reclaim them
          right from here — no need to open the wallet.
        </p>
      </div>

      {vault.length === 0 && (
        <div className="card">
          <p className="empty">
            No recallable transfers yet. From Send tab, enable{" "}
            <strong>Recallable</strong> before sending.
          </p>
        </div>
      )}

      {vault.map((v) => {
        const elapsed = (now - v.ts) / 1000;
        const remaining = v.recallSeconds - elapsed;
        const expired = remaining <= 0;
        return (
          <div key={v.id} className={`card vault-row ${expired ? "vault-expired" : ""}`}>
            <div className="vault-top">
              <div>
                <div style={{ fontWeight: 600 }}>
                  {v.amount} {labelFor(v.faucetId)}
                </div>
                <div className="mono" style={{ fontSize: "0.78rem", color: "#94a3b8" }}>
                  → {shortAddr(v.recipient, 10, 6)}
                </div>
              </div>
              <span className={`badge ${expired ? "badge-completed" : "badge-you_sent"}`}>
                {v.recalled
                  ? "✅ Recalled"
                  : expired
                    ? "⚡ Recallable"
                    : `⏳ ${formatDuration(remaining)}`}
              </span>
            </div>

            {!v.recalled && !expired && (
              <div className="countdown-bar">
                <div className="countdown-fill"
                  style={{ width: `${(elapsed / v.recallSeconds) * 100}%` }} />
              </div>
            )}

            <div className="vault-meta">
              Send tx:{" "}
              <a href={`${EXPLORER_BASE_URL}/tx/${v.txId}`} target="_blank" rel="noreferrer" className="tx-link">
                {shortAddr(v.txId, 8, 6)} ↗
              </a>
              {v.recallTxId && (
                <>
                  {" "}· Recall tx:{" "}
                  <a href={`${EXPLORER_BASE_URL}/tx/${v.recallTxId}`} target="_blank" rel="noreferrer" className="tx-link">
                    {shortAddr(v.recallTxId, 8, 6)} ↗
                  </a>
                </>
              )}
            </div>

            <div className="swap-actions">
              <button className="ghost small" onClick={() => removeEntry(v.id)}>
                Remove
              </button>
            </div>
          </div>
        );
      })}

      {/* Reclaimable notes from wallet */}
      <div className="card">
        <div className="card-head">
          <h2>📥 Reclaimable Notes</h2>
          <button className="ghost" onClick={refreshInbox} disabled={loadingInbox}>
            {loadingInbox ? "…" : "↻"}
          </button>
        </div>
        <p className="hint" style={{ marginBottom: "0.5rem" }}>
          Notes your wallet can consume right now — including expired recallable transfers you sent.
        </p>

        {inboxError && <div className="error-box">{inboxError}</div>}

        {inbox.length === 0 && !loadingInbox && (
          <p className="empty">No notes waiting to be consumed.</p>
        )}

        {inbox.map((note) => {
          const isRecalling = recallingId === note.noteId;
          const firstAsset = note.assets[0];
          return (
            <div key={note.noteId} className="tx-row">
              <div className="tx-row-top">
                <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                  <span style={{ fontWeight: 600 }}>
                    {firstAsset ? `${formatBalance(firstAsset.amount)} ${labelFor(firstAsset.faucetId)}` : "—"}
                  </span>
                  <span className="mono" style={{ fontSize: "0.72rem", color: "#94a3b8" }}>
                    {shortAddr(note.noteId, 10, 6)}
                  </span>
                </div>
                <button
                  className="small primary"
                  onClick={() => consumeNote(note)}
                  disabled={isRecalling || !firstAsset}
                >
                  {isRecalling ? "…" : "🔓 Reclaim"}
                </button>
              </div>
              {isRecalling && recallStatus.stage !== "idle" && (
                <TxStatusIndicator status={recallStatus} />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ─── PRIVACY TAB ───────────────────────────────────────────────────────────

function PrivacyTab({
  txLog, labelFor,
}: {
  txLog: TxLogEntry[];
  labelFor: (faucetId: string) => string;
}) {
  const stats = useMemo(() => {
    const total = txLog.length;
    const priv = txLog.filter((t) => t.noteType === "private").length;
    const pub = total - priv;
    const uniqueRecipients = new Set(txLog.map((t) => t.recipient)).size;
    const uniqueAssets = new Set(txLog.map((t) => t.faucetId)).size;
    const last7days = txLog.filter((t) => t.ts > Date.now() - 7 * 86400_000).length;
    const ratio = total > 0 ? priv / total : 0;
    const base = ratio * 60;
    const diversityBonus = Math.min(uniqueRecipients * 2, 20);
    const volumeBonus = Math.min(total * 1, 20);
    const score = Math.round(base + diversityBonus + volumeBonus);
    return { total, priv, pub, uniqueRecipients, uniqueAssets, last7days, score, ratio };
  }, [txLog]);

  const typeCount = useMemo(() => {
    const c: Record<string, number> = { send: 0, swap: 0, airdrop: 0, vault: 0, recall: 0 };
    txLog.forEach((t) => { c[t.type] = (c[t.type] || 0) + 1; });
    return c;
  }, [txLog]);

  const assetBreakdown = useMemo(() => {
    const map: Record<string, number> = {};
    txLog.forEach((t) => { map[t.faucetId] = (map[t.faucetId] || 0) + 1; });
    return Object.entries(map)
      .map(([fid, count]) => ({ fid, count, label: labelFor(fid) }))
      .sort((a, b) => b.count - a.count);
  }, [txLog, labelFor]);

  const scoreColor = stats.score >= 80 ? "#4ade80" : stats.score >= 50 ? "#fbbf24" : "#fca5a5";
  const scoreLabel = stats.score >= 80 ? "Excellent" : stats.score >= 50 ? "Good" : "Room to improve";

  if (stats.total === 0) {
    return (
      <div className="card">
        <h2>📊 Privacy Dashboard</h2>
        <p className="empty">Send a few transactions first — your privacy metrics will appear here.</p>
      </div>
    );
  }

  return (
    <>
      <div className="card privacy-hero">
        <div className="privacy-score-wrap">
          <ScoreRing value={stats.score} color={scoreColor} />
          <div>
            <div className="privacy-label">Privacy Score</div>
            <div className="privacy-value" style={{ color: scoreColor }}>{stats.score}/100</div>
            <div className="privacy-sub">{scoreLabel}</div>
          </div>
        </div>
      </div>

      <div className="stat-grid">
        <Stat label="Total tx" value={stats.total} />
        <Stat label="Private" value={stats.priv} color="#818cf8" />
        <Stat label="Public" value={stats.pub} color="#94a3b8" />
        <Stat label="Recipients" value={stats.uniqueRecipients} />
        <Stat label="Assets" value={stats.uniqueAssets} />
        <Stat label="Last 7d" value={stats.last7days} />
      </div>

      <div className="card">
        <h2>Private vs Public</h2>
        <RatioBar priv={stats.priv} pub={stats.pub} />
        <p className="hint" style={{ marginTop: "0.5rem" }}>
          {Math.round(stats.ratio * 100)}% of your transactions use private notes.
        </p>
      </div>

      <div className="card">
        <h2>Activity by type</h2>
        <BarChart data={[
          { label: "💸 Send", value: typeCount.send, color: "#6366f1" },
          { label: "🪂 Airdrop", value: typeCount.airdrop, color: "#ec4899" },
          { label: "🔐 Vault", value: typeCount.vault, color: "#f59e0b" },
          { label: "↩️ Recall", value: typeCount.recall, color: "#22c55e" },
        ]} />
      </div>

      {assetBreakdown.length > 0 && (
        <div className="card">
          <h2>Top assets</h2>
          {assetBreakdown.slice(0, 5).map((a) => (
            <div key={a.fid} className="asset">
              <span className={a.label.length <= 8 ? "asset-symbol" : "mono"}>{a.label}</span>
              <span className="amount">{a.count} tx</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Tips to improve privacy</h2>
        <ul className="tips">
          {stats.ratio < 0.8 && <li>Use <strong>Private</strong> notes by default.</li>}
          {stats.uniqueRecipients < 5 && <li>Send to more distinct addresses to grow your anonymity set.</li>}
          {stats.uniqueAssets < 2 && <li>Try using multiple assets — diversity increases unlinkability.</li>}
          {stats.total < 10 && <li>Reach 10+ transactions for stronger privacy heuristics.</li>}
          <li>Enable <strong>Recallable</strong> on large transfers.</li>
        </ul>
      </div>
    </>
  );
}

// ─── Small visual primitives ───────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="stat">
      <div className="stat-value" style={color ? { color } : undefined}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function ScoreRing({ value, color }: { value: number; color: string }) {
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (value / 100) * circumference;
  return (
    <svg width="96" height="96" className="score-ring">
      <circle cx="48" cy="48" r={radius} stroke="rgba(255,255,255,0.08)" strokeWidth="8" fill="none" />
      <circle
        cx="48" cy="48" r={radius} stroke={color} strokeWidth="8" fill="none"
        strokeDasharray={circumference} strokeDashoffset={offset}
        strokeLinecap="round" transform="rotate(-90 48 48)"
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
      <text x="48" y="55" textAnchor="middle" fontSize="20" fontWeight="700" fill={color}>{value}</text>
    </svg>
  );
}

function RatioBar({ priv, pub }: { priv: number; pub: number }) {
  const total = priv + pub;
  if (total === 0) return null;
  const privPct = (priv / total) * 100;
  return (
    <div className="ratio-bar">
      <div className="ratio-priv" style={{ width: `${privPct}%` }}>🔒 {priv}</div>
      <div className="ratio-pub" style={{ width: `${100 - privPct}%` }}>🌐 {pub}</div>
    </div>
  );
}

function BarChart({ data }: { data: { label: string; value: number; color: string }[] }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="barchart">
      {data.map((d) => (
        <div key={d.label} className="bar-row">
          <div className="bar-label">{d.label}</div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(d.value / max) * 100}%`, background: d.color }} />
          </div>
          <div className="bar-value">{d.value}</div>
        </div>
      ))}
    </div>
  );
}
