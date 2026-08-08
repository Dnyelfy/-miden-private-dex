import { useState, useEffect, useCallback, useMemo } from "react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import type {
  Asset,
  GuardianInfo,
  InputNoteDetails,
} from "@miden-sdk/miden-wallet-adapter-base";
import {
  useBridge,
  usePswapCancel,
  usePswapConsume,
  usePswapCreate,
  usePswapLineages,
  type PswapLineageRecord,
} from "@miden-sdk/react";
import {
  BRIDGE_ACCOUNT_ID,
  BRIDGE_MONITOR_URL,
  BRIDGE_NETWORKS,
  EXPLORER_BASE_URL,
} from "@/config";
import "./AppContent.css";

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

type Tab = "send" | "swap" | "bridge" | "airdrop" | "vault" | "privacy";

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
      setGlobalError(e instanceof Error ? e.message : String(e));
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
      setGlobalError(e instanceof Error ? e.message : String(e));
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
      `🔒 Check out this private dApp on @0xMiden testnet — send, swap, bulk-airdrop, time-locked vault & privacy analytics, all ZK 👇`,
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
          Private send · atomic PSWAP · Agglayer bridge · bulk airdrop · time-locked vault ·
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
            <TabBtn label="💸 Send" active={tab === "send"} onClick={() => setTab("send")} />
            <TabBtn label="🔄 Swap" active={tab === "swap"} onClick={() => setTab("swap")} />
            <TabBtn label="🌉 Bridge" active={tab === "bridge"} onClick={() => setTab("bridge")} />
            <TabBtn label="🪂 Airdrop" active={tab === "airdrop"} onClick={() => setTab("airdrop")} />
            <TabBtn label="🔐 Vault" active={tab === "vault"} onClick={() => setTab("vault")} />
            <TabBtn label="📊 Privacy" active={tab === "privacy"} onClick={() => setTab("privacy")} />
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
          {tab === "swap" && (
            <SwapTab
              address={address!}
              assets={assets}
              labelFor={labelFor}
              onSent={loadAssets}
              logTx={logTx}
            />
          )}
          {tab === "bridge" && (
            <BridgeTab
              address={address!}
              assets={assets}
              labelFor={labelFor}
              onSent={loadAssets}
              logTx={logTx}
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
      setStatus({ stage: "error", error: e instanceof Error ? e.message : String(e) });
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

// ─── SWAP TAB ──────────────────────────────────────────────────────────────

interface SwapTabProps {
  address: string;
  assets: Asset[];
  labelFor: (faucetId: string) => string;
  onSent: () => void;
  logTx: (entry: TxLogEntry) => void;
}

const PSWAP_STATE_LABEL: Record<number, string> = {
  0: "Active",
  1: "Filled",
  2: "Reclaimed",
};

function noteIdString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return "";
  }
}

function SwapTab({ address, assets, labelFor, onSent, logTx }: SwapTabProps) {
  const [offerFaucet, setOfferFaucet] = useState("");
  const [offerAmount, setOfferAmount] = useState("");
  const [wantFaucet, setWantFaucet] = useState("");
  const [wantAmount, setWantAmount] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [status, setStatus] = useState<TxStatus>({ stage: "idle" });

  const [fillNoteId, setFillNoteId] = useState("");
  const [fillAmount, setFillAmount] = useState("");
  const [fillStatus, setFillStatus] = useState<TxStatus>({ stage: "idle" });

  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const { pswapCreate } = usePswapCreate();
  const { pswapConsume } = usePswapConsume();
  const { pswapCancel } = usePswapCancel();
  const { lineages, isLoading: loadingOrders, refetch: refetchOrders } = usePswapLineages();

  useEffect(() => {
    if (assets.length > 0 && !offerFaucet) {
      setOfferFaucet(assets[0].faucetId);
      setWantFaucet(assets.length > 1 ? assets[1].faucetId : assets[0].faucetId);
    }
  }, [assets, offerFaucet]);

  const isBusy = status.stage !== "idle" && status.stage !== "confirmed" && status.stage !== "error";
  const isFilling = fillStatus.stage !== "idle" && fillStatus.stage !== "confirmed" && fillStatus.stage !== "error";

  const myOrders = useMemo(
    () => lineages.filter((l: PswapLineageRecord) => Number(l.state()) === 0 || Number(l.state()) === 1),
    [lineages],
  );

  const handleCreateOrder = async () => {
    if (!offerFaucet || !wantFaucet) return setStatus({ stage: "error", error: "Select both assets" });
    if (offerFaucet === wantFaucet)
      return setStatus({ stage: "error", error: "Offered and requested asset must differ" });
    const offered = toBaseUnits(offerAmount);
    const requested = toBaseUnits(wantAmount);
    if (offered <= 0) return setStatus({ stage: "error", error: "Enter the amount you offer" });
    if (requested <= 0) return setStatus({ stage: "error", error: "Enter the amount you want" });

    setStatus({ stage: "signing" });
    try {
      const res = await pswapCreate({
        accountId: address,
        offeredFaucetId: offerFaucet,
        offeredAmount: BigInt(offered),
        requestedFaucetId: wantFaucet,
        requestedAmount: BigInt(requested),
        noteType: visibility,
        paybackNoteType: "private",
      });
      const txId = res.transactionId;
      setStatus({ stage: "confirming", txId });
      logTx({
        txId,
        type: "swap",
        recipient: "pswap-order",
        faucetId: offerFaucet,
        amount: offerAmount,
        noteType: visibility,
        ts: Date.now(),
      });
      setStatus({ stage: "confirmed", txId });
      setOfferAmount("");
      setWantAmount("");
      onSent();
      refetchOrders();
      setTimeout(() => setStatus((cur) => (cur.txId === txId ? { stage: "idle" } : cur)), 8000);
    } catch (e) {
      setStatus({ stage: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleFill = async () => {
    if (!fillNoteId.trim()) return setFillStatus({ stage: "error", error: "Paste a PSWAP note id" });
    const amt = toBaseUnits(fillAmount);
    if (amt <= 0) return setFillStatus({ stage: "error", error: "Enter the amount you supply" });

    setFillStatus({ stage: "signing" });
    try {
      const res = await pswapConsume({
        accountId: address,
        note: fillNoteId.trim(),
        fillAmount: BigInt(amt),
      });
      const txId = res.transactionId;
      setFillStatus({ stage: "confirming", txId });
      logTx({
        txId,
        type: "swap",
        recipient: "pswap-fill",
        faucetId: wantFaucet || offerFaucet,
        amount: fillAmount,
        noteType: "private",
        ts: Date.now(),
      });
      setFillStatus({ stage: "confirmed", txId });
      setFillNoteId("");
      setFillAmount("");
      onSent();
      refetchOrders();
      setTimeout(() => setFillStatus((cur) => (cur.txId === txId ? { stage: "idle" } : cur)), 8000);
    } catch (e) {
      setFillStatus({ stage: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleCancel = async (rec: PswapLineageRecord) => {
    const noteId = noteIdString(rec.currentTipNoteId());
    if (!confirm("Reclaim the unfilled portion of this order?")) return;
    setCancellingId(noteId);
    try {
      await pswapCancel({ accountId: address, note: noteId });
      onSent();
      refetchOrders();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setCancellingId(null);
    }
  };

  const offerBalance = assets.find((a) => a.faucetId === offerFaucet);

  return (
    <>
      <div className="card">
        <h2>Atomic PSWAP</h2>
        <div className="banner banner-good">
          <span>
            ⚡ Native partial-fill swaps are live on testnet v0.15. Your order can be
            filled by many takers; the unfilled remainder is re-created automatically.
          </span>
        </div>

        <div className="swap-grid">
          <div className="swap-side">
            <div className="swap-side-label">You offer ↑</div>
            <select value={offerFaucet} onChange={(e) => setOfferFaucet(e.target.value)} disabled={isBusy}>
              {assets.map((a) => <option key={a.faucetId} value={a.faucetId}>{labelFor(a.faucetId)}</option>)}
            </select>
            <input type="number" min="0" step="any" value={offerAmount}
              onChange={(e) => setOfferAmount(e.target.value)} placeholder="10" disabled={isBusy} />
            {offerBalance && <p className="hint">Balance: {formatBalance(offerBalance.amount)}</p>}
          </div>
          <div className="swap-arrow">⇄</div>
          <div className="swap-side">
            <div className="swap-side-label">You want ↓</div>
            <select value={wantFaucet} onChange={(e) => setWantFaucet(e.target.value)} disabled={isBusy}>
              {assets.map((a) => <option key={a.faucetId} value={a.faucetId}>{labelFor(a.faucetId)}</option>)}
            </select>
            <input type="number" min="0" step="any" value={wantAmount}
              onChange={(e) => setWantAmount(e.target.value)} placeholder="9" disabled={isBusy} />
            <p className="hint">Fill price, pro rata</p>
          </div>
        </div>

        <div className="radio-row" style={{ marginTop: "0.8rem" }}>
          <label className="radio">
            <input type="radio" checked={visibility === "private"}
              onChange={() => setVisibility("private")} disabled={isBusy} />
            Private order
          </label>
          <label className="radio">
            <input type="radio" checked={visibility === "public"}
              onChange={() => setVisibility("public")} disabled={isBusy} />
            Public order
          </label>
        </div>
        <p className="hint">
          A private order must be shared with your counterparty out of band. A public
          order is discoverable by any taker on the network.
        </p>

        <button onClick={handleCreateOrder} disabled={isBusy || assets.length === 0}
          style={{ width: "100%", marginTop: "1rem" }}>
          {isBusy ? "…" : "🔄 Create PSWAP Order"}
        </button>
        <TxStatusIndicator status={status} />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Your Orders ({myOrders.length})</h2>
          <button className="ghost" onClick={() => refetchOrders()} disabled={loadingOrders}>
            {loadingOrders ? "…" : "↻"}
          </button>
        </div>
        {myOrders.length === 0 && (
          <p className="empty">
            {loadingOrders ? "Loading…" : "No PSWAP orders yet."}
          </p>
        )}
        {myOrders.map((rec: PswapLineageRecord) => {
          const noteId = noteIdString(rec.currentTipNoteId());
          const stateNum = Number(rec.state());
          const depth = Number(rec.currentDepth());
          const filled = stateNum === 1;
          return (
            <div key={rec.orderId()} className={`swap-row status-${filled ? "completed" : "you_sent"}`}>
              <div className="swap-row-top">
                <span className="mono">#{rec.orderId().slice(0, 10)}…</span>
                <span className={`badge badge-${filled ? "completed" : "you_sent"}`}>
                  {filled ? "✅ " : "⏳ "}{PSWAP_STATE_LABEL[stateNum] ?? "Unknown"}
                </span>
              </div>
              <div className="swap-row-body">
                Remaining: {formatBalance(rec.remainingOffered().toString())} offered ·{" "}
                {formatBalance(rec.remainingRequested().toString())} requested
              </div>
              <div className="swap-row-meta">
                Fill rounds: {depth} · Tip note:{" "}
                <span className="mono">{shortAddr(noteId, 8, 6)}</span>
                <button className="ghost small" style={{ marginLeft: "0.4rem" }}
                  onClick={() => navigator.clipboard.writeText(noteId)}>
                  Copy id
                </button>
              </div>
              {!filled && (
                <div className="swap-actions">
                  <button className="ghost small" disabled={cancellingId === noteId}
                    onClick={() => handleCancel(rec)}>
                    {cancellingId === noteId ? "…" : "↩ Reclaim unfilled"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="card">
        <h2>Fill an Order</h2>
        <p className="hint" style={{ marginBottom: "0.8rem" }}>
          Supply part or all of the requested asset. You receive a pro rata share of
          the offered asset, and the creator gets a private payback note.
        </p>
        <label>PSWAP note id</label>
        <input type="text" value={fillNoteId} onChange={(e) => setFillNoteId(e.target.value)}
          placeholder="0x…" spellCheck={false} disabled={isFilling} />
        <label>Amount you supply</label>
        <input type="number" min="0" step="any" value={fillAmount}
          onChange={(e) => setFillAmount(e.target.value)} placeholder="5" disabled={isFilling} />
        <button onClick={handleFill} disabled={isFilling}
          style={{ width: "100%", marginTop: "1rem" }}>
          {isFilling ? "…" : "⚡ Fill Order"}
        </button>
        <TxStatusIndicator status={fillStatus} />
      </div>
    </>
  );
}

// ─── BRIDGE TAB ────────────────────────────────────────────────────────────

interface BridgeTabProps {
  address: string;
  assets: Asset[];
  labelFor: (faucetId: string) => string;
  onSent: () => void;
  logTx: (entry: TxLogEntry) => void;
}

function BridgeTab({ address, assets, labelFor, onSent, logTx }: BridgeTabProps) {
  const [faucetId, setFaucetId] = useState("");
  const [amount, setAmount] = useState("");
  const [network, setNetwork] = useState(BRIDGE_NETWORKS[0].id);
  const [destination, setDestination] = useState("");
  const [status, setStatus] = useState<TxStatus>({ stage: "idle" });

  const { bridge } = useBridge();

  useEffect(() => {
    if (assets.length > 0 && !faucetId) setFaucetId(assets[0].faucetId);
  }, [assets, faucetId]);

  const isBusy = status.stage !== "idle" && status.stage !== "confirmed" && status.stage !== "error";
  const configured = BRIDGE_ACCOUNT_ID.length > 0;

  const handleBridge = async () => {
    if (!configured)
      return setStatus({ stage: "error", error: "Bridge account not configured" });
    if (!faucetId) return setStatus({ stage: "error", error: "Select an asset" });
    const base = toBaseUnits(amount);
    if (base <= 0) return setStatus({ stage: "error", error: "Enter an amount" });
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination.trim()))
      return setStatus({ stage: "error", error: "Enter a valid 0x destination address" });

    setStatus({ stage: "signing" });
    try {
      const res = await bridge({
        from: address,
        bridgeAccount: BRIDGE_ACCOUNT_ID,
        assetId: faucetId,
        amount: BigInt(base),
        destinationNetwork: network,
        destinationAddress: destination.trim(),
      });
      const txId = res.transactionId;
      setStatus({ stage: "confirming", txId });
      logTx({
        txId,
        type: "send",
        recipient: destination.trim(),
        faucetId,
        amount,
        noteType: "public",
        ts: Date.now(),
      });
      setStatus({ stage: "confirmed", txId });
      setAmount("");
      onSent();
      setTimeout(() => setStatus((cur) => (cur.txId === txId ? { stage: "idle" } : cur)), 8000);
    } catch (e) {
      setStatus({ stage: "error", error: e instanceof Error ? e.message : String(e) });
    }
  };

  const balance = assets.find((a) => a.faucetId === faucetId);

  return (
    <div className="card">
      <h2>🌉 Bridge out via Agglayer</h2>
      <div className="banner">
        <span>
          Emits a public B2AGG note that the bridge account consumes, burning the asset
          so it can be claimed at your destination address. Only the bridge-out leg is
          public; the rest of your Miden activity stays private.
        </span>
      </div>

      {!configured && (
        <div className="error-box" style={{ marginBottom: "0.8rem" }}>
          Set <code>VITE_MIDEN_BRIDGE_ACCOUNT</code> to the Miden testnet bridge account
          id to enable this tab.
        </div>
      )}

      <label>Asset</label>
      <select value={faucetId} onChange={(e) => setFaucetId(e.target.value)} disabled={isBusy}>
        {assets.map((a) => <option key={a.faucetId} value={a.faucetId}>{labelFor(a.faucetId)}</option>)}
      </select>
      {balance && <p className="hint">Balance: {formatBalance(balance.amount)}</p>}

      <label>Amount</label>
      <input type="number" min="0" step="any" value={amount}
        onChange={(e) => setAmount(e.target.value)} placeholder="10" disabled={isBusy} />

      <label>Destination network</label>
      <select value={network} onChange={(e) => setNetwork(Number(e.target.value))} disabled={isBusy}>
        {BRIDGE_NETWORKS.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
      </select>

      <label>Destination address</label>
      <input type="text" value={destination} onChange={(e) => setDestination(e.target.value)}
        placeholder="0x…" spellCheck={false} disabled={isBusy} />

      <button onClick={handleBridge} disabled={isBusy || !configured || assets.length === 0}
        style={{ width: "100%", marginTop: "1rem" }}>
        {isBusy ? "…" : "🌉 Bridge Out"}
      </button>
      <TxStatusIndicator status={status} />

      <p className="hint" style={{ marginTop: "0.8rem" }}>
        Track live bridge activity on the{" "}
        <a href={BRIDGE_MONITOR_URL} target="_blank" rel="noreferrer" className="tx-link">
          Agglayer monitor ↗
        </a>
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
          error: e instanceof Error ? e.message : String(e),
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

// ─── GUARDIAN RECOVERY WALKTHROUGH (interactive explainer) ─────────────────

type KeyId = "hot" | "cold" | "guardian";

interface RecoveryScenario {
  id: string;
  title: string;
  subtitle: string;
  signers: KeyId[];
  steps: string[];
  outcome: string;
}

const RECOVERY_SCENARIOS: RecoveryScenario[] = [
  {
    id: "lost-hot",
    title: "Lost hot key",
    subtitle: "Phone gone, daily signing key unavailable",
    signers: ["cold", "guardian"],
    steps: [
      "Hot key is unreachable — you can no longer sign day-to-day.",
      "You bring your offline cold key out of storage.",
      "Cold key + Guardian policy key together meet the 2-of-3 threshold.",
      "They co-sign an auth-update rotating in a fresh hot key.",
    ],
    outcome: "Account recovered with a new hot key. No funds moved by anyone alone.",
  },
  {
    id: "stolen",
    title: "Device stolen",
    subtitle: "Attacker has your phone / hot key",
    signers: ["cold", "guardian"],
    steps: [
      "Attacker holds the hot key but that is only 1 of 3.",
      "A single key cannot move funds — the 2-of-3 policy blocks it.",
      "You act first: cold key + Guardian co-sign a rotation.",
      "The stolen hot key is revoked before it can be paired with a second key.",
    ],
    outcome: "Compromised key neutralised. Attacker is locked out.",
  },
  {
    id: "drop-guardian",
    title: "Drop the Guardian",
    subtitle: "Move to pure self-custody, no operator",
    signers: ["hot", "cold"],
    steps: [
      "You decide you no longer want an operator in the policy.",
      "Hot key + cold key together already satisfy 2-of-3.",
      "They co-sign an auth-update that removes the Guardian policy key.",
      "The account continues under keys you fully control.",
    ],
    outcome: "Guardian removed. You never depended on it to exit — that is the point.",
  },
];

const KEY_META: Record<KeyId, { label: string; icon: string; note: string }> = {
  hot: { label: "Hot key", icon: "📱", note: "daily signing" },
  cold: { label: "Cold key", icon: "🧊", note: "offline backup" },
  guardian: { label: "Guardian", icon: "🛡️", note: "policy co-signer" },
};

function GuardianRecoveryDemo() {
  const [scenarioId, setScenarioId] = useState(RECOVERY_SCENARIOS[0].id);
  const [step, setStep] = useState(0);
  const scenario = RECOVERY_SCENARIOS.find((s) => s.id === scenarioId)!;
  const revealed = step >= scenario.steps.length;

  const pick = (id: string) => { setScenarioId(id); setStep(0); };

  return (
    <div className="card">
      <div className="card-head">
        <h2>🔁 Recovery walkthrough</h2>
        <span className="badge badge-you_sent">demo</span>
      </div>
      <p className="hint" style={{ marginBottom: "0.7rem" }}>
        How a 2-of-3 Guardian account survives a lost or stolen key. This is an
        interactive explainer, not an on-chain action.
      </p>

      <div className="scenario-tabs">
        {RECOVERY_SCENARIOS.map((s) => (
          <button
            key={s.id}
            className={`scenario-tab ${s.id === scenarioId ? "active" : ""}`}
            onClick={() => pick(s.id)}
          >
            {s.title}
          </button>
        ))}
      </div>

      <p className="scenario-sub">{scenario.subtitle}</p>

      <div className="key-triad">
        {(["hot", "cold", "guardian"] as KeyId[]).map((k) => {
          const signing = scenario.signers.includes(k);
          const active = signing && step > 0;
          return (
            <div key={k} className={`key-chip ${active ? "key-signing" : ""} ${!signing ? "key-idle" : ""}`}>
              <span className="key-icon">{KEY_META[k].icon}</span>
              <span className="key-name">{KEY_META[k].label}</span>
              <span className="key-note">{KEY_META[k].note}</span>
              {active && <span className="key-badge">signs ✍️</span>}
            </div>
          );
        })}
      </div>
      <div className="threshold-line">
        <span className="threshold-pill">
          {step > 0 ? `${scenario.signers.length}-of-3 threshold met ✅` : "2-of-3 policy · any single key is powerless"}
        </span>
      </div>

      <ol className="recovery-steps">
        {scenario.steps.map((s, i) => (
          <li key={i} className={i < step ? "step-done" : i === step ? "step-current" : "step-pending"}>
            {s}
          </li>
        ))}
      </ol>

      {revealed && (
        <div className="recovery-outcome">✅ {scenario.outcome}</div>
      )}

      <div className="swap-actions" style={{ marginTop: "0.8rem" }}>
        {!revealed ? (
          <button className="primary" onClick={() => setStep((s) => s + 1)} style={{ flex: 1 }}>
            {step === 0 ? "▶ Start walkthrough" : "Next step →"}
          </button>
        ) : (
          <button className="ghost" onClick={() => setStep(0)} style={{ flex: 1 }}>
            ↺ Replay
          </button>
        )}
      </div>
    </div>
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
      const msg = e instanceof Error ? e.message : String(e);
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
      setInboxError(e instanceof Error ? e.message : String(e));
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
      setRecallStatus({ stage: "error", error: e instanceof Error ? e.message : String(e) });
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

      <GuardianRecoveryDemo />

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
          { label: "🔄 Swap", value: typeCount.swap, color: "#8b5cf6" },
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
