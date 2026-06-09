import { useState, useEffect, useCallback, useMemo } from "react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import type { Asset } from "@miden-sdk/miden-wallet-adapter-base";
import { EXPLORER_BASE_URL } from "@/config";
import "./AppContent.css";

// ─── Constants & helpers ───────────────────────────────────────────────────

const DECIMALS = 6;
const FACTOR = 10 ** DECIMALS;
const GITHUB_URL = "https://github.com/Dnyelfy/-miden-private-dex";

// Miden testnet block time ~5s (approximate)
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
const SWAPS_KEY = "miden_dex_swaps_v1";
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

type SwapStatus = "you_sent" | "completed";

interface Swap {
  id: string;
  counterparty: string;
  sendFaucetId: string;
  sendAmount: string;
  recvFaucetId: string;
  recvAmount: string;
  status: SwapStatus;
  ourTxId?: string;
  ts: number;
}

interface VaultEntry {
  id: string;
  recipient: string;
  faucetId: string;
  amount: string;
  recallSeconds: number;
  txId: string;
  ts: number;
  recalled?: boolean;
}

interface TxLogEntry {
  txId: string;
  type: "send" | "swap" | "airdrop" | "vault";
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
}

// ─── Main ──────────────────────────────────────────────────────────────────

type Tab = "send" | "swap" | "airdrop" | "vault" | "privacy";

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
    requestAssets,
  } = wallet;

  const [tab, setTab] = useState<Tab>("send");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [aliases, setAliases] = useState<Record<string, string>>(() =>
    lsLoad(ALIAS_KEY, {} as Record<string, string>),
  );
  const [editingAlias, setEditingAlias] = useState<string | null>(null);
  const [txLog, setTxLog] = useState<TxLogEntry[]>(() => lsLoad(TX_LOG_KEY, [] as TxLogEntry[]));

  // auto-pick first wallet
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
      const next = [entry, ...prev].slice(0, 500); // cap
      lsSave(TX_LOG_KEY, next);
      return next;
    });
  }, []);

  const shareOnTwitter = () => {
    const text = encodeURIComponent(
      `🔒 Built a private dApp on @0xMiden testnet — send, swap, bulk-airdrop, time-locked vault & a privacy dashboard, all ZK. Try it 👇`,
    );
    const url = encodeURIComponent("https://miden-private-dex.vercel.app/");
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, "_blank");
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
            <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="icon-btn">
              ★ GitHub
            </a>
            <button className="icon-btn twitter-btn" onClick={shareOnTwitter}>
              𝕏 Share
            </button>
          </div>
        </div>
        <p className="subtitle">
          Private send · OTC swap · bulk airdrop · time-locked vault · privacy analytics on{" "}
          <span className="badge-net">Miden Testnet</span>
        </p>
      </header>

      {!connected ? (
        <div className="wallet-info-disconnected">
          {wallets.length === 0 ? (
            <>
              <p>
                <strong>MidenFi Wallet</strong> extension not found.
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
            <button className="disconnect-btn" onClick={() => disconnect()}>
              ×
            </button>
          </div>

          <div className="tabs">
            <TabBtn label="💸 Send" active={tab === "send"} onClick={() => setTab("send")} />
            <TabBtn label="🔄 Swap" active={tab === "swap"} onClick={() => setTab("swap")} />
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
              onSent={loadAssets}
              logTx={logTx}
            />
          )}
          {tab === "swap" && (
            <SwapTab
              address={address!}
              assets={assets}
              labelFor={labelFor}
              requestSend={requestSend}
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
              onSent={loadAssets}
              logTx={logTx}
            />
          )}
          {tab === "vault" && (
            <VaultTab labelFor={labelFor} />
          )}
          {tab === "privacy" && (
            <PrivacyTab txLog={txLog} aliases={aliases} labelFor={labelFor} />
          )}
        </>
      )}

      <footer className="footer">
        <a href={EXPLORER_BASE_URL} target="_blank" rel="noreferrer" className="tx-link">
          midenscan.com
        </a>
        <span>·</span>
        <a href={GITHUB_URL} target="_blank" rel="noreferrer" className="tx-link">
          source
        </a>
        <span>·</span>
        <span className="muted">Built on Miden ⚡</span>
      </footer>
    </div>
  );
}

// ─── Small helpers ─────────────────────────────────────────────────────────

function TabBtn({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
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

// ─── Tab props ─────────────────────────────────────────────────────────────

interface TabProps {
  address: string;
  assets: Asset[];
  labelFor: (faucetId: string) => string;
  requestSend: ReturnType<typeof useMidenFiWallet>["requestSend"];
  onSent: () => void;
  logTx: (entry: TxLogEntry) => void;
}

// ─── SEND TAB ──────────────────────────────────────────────────────────────

function SendTab({ address, assets, labelFor, requestSend, onSent, logTx }: TabProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [faucetId, setFaucetId] = useState("");
  const [noteType, setNoteType] = useState<"public" | "private">("private");
  const [recallable, setRecallable] = useState(false);
  const [recallPreset, setRecallPreset] = useState(RECALL_PRESETS[1]); // 24h default
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTxId, setLastTxId] = useState<string | null>(null);

  useEffect(() => {
    if (assets.length > 0 && !faucetId) setFaucetId(assets[0].faucetId);
  }, [assets, faucetId]);

  const selectedAsset = assets.find((a) => a.faucetId === faucetId);
  const selectedBalance = selectedAsset ? formatBalance(selectedAsset.amount) : "0";

  const handleSend = async () => {
    setError(null);
    setLastTxId(null);
    if (!requestSend) return setError("Wallet does not support requestSend");
    if (!recipient.trim()) return setError("Enter a recipient address");
    if (!faucetId) return setError("Select an asset");
    const baseAmount = toBaseUnits(amount);
    if (baseAmount <= 0) return setError("Enter a valid amount");

    setIsSending(true);
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

      logTx({
        txId,
        type: "send",
        recipient: recipient.trim(),
        faucetId,
        amount,
        noteType,
        ts: Date.now(),
      });

      // If recallable, save to vault
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

      setLastTxId(txId);
      setRecipient("");
      setAmount("");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSending(false);
    }
  };

  return (
    <>
      <div className="card">
        <h2>Send</h2>
        <label>Recipient address</label>
        <input
          type="text"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="mtst1…"
          spellCheck={false}
        />

        <div style={{ display: "grid", gap: "0.8rem", marginTop: "0.8rem" }}>
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
            />
          </div>

          <div>
            <label>Note type</label>
            <div className="radio-row">
              <label className="radio">
                <input
                  type="radio"
                  checked={noteType === "private"}
                  onChange={() => setNoteType("private")}
                />
                <span>Private 🔒</span>
              </label>
              <label className="radio">
                <input
                  type="radio"
                  checked={noteType === "public"}
                  onChange={() => setNoteType("public")}
                />
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
              />
              <span>🔐 Recallable — recover if not claimed</span>
            </label>
            {recallable && (
              <div className="recall-presets">
                {RECALL_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`preset ${recallPreset.label === p.label ? "active" : ""}`}
                    onClick={() => setRecallPreset(p)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}
            <p className="hint">
              {recallable
                ? `If unclaimed in ${recallPreset.label}, you can recover via wallet. Tracked in Vault tab.`
                : noteType === "private"
                  ? "🔒 Hidden on midenscan. Recipient claims in their wallet."
                  : "🌐 Visible on midenscan. Auto-credited."}
            </p>
          </div>
        </div>

        <button
          onClick={handleSend}
          disabled={isSending || assets.length === 0}
          style={{ width: "100%", marginTop: "1rem" }}
        >
          {isSending ? "Signing & broadcasting…" : "🚀 Send on-chain"}
        </button>
        {error && <div className="error-box">{error}</div>}
        {lastTxId && (
          <div className="success-box">
            ✅ Sent! Tx:{" "}
            <a
              href={`${EXPLORER_BASE_URL}/tx/${lastTxId}`}
              target="_blank"
              rel="noreferrer"
              className="tx-link"
            >
              {shortAddr(lastTxId, 8, 6)} ↗
            </a>
          </div>
        )}
      </div>
    </>
  );
}

// ─── SWAP TAB ──────────────────────────────────────────────────────────────

function SwapTab({ address, assets, labelFor, requestSend, onSent, logTx }: TabProps) {
  const [counterparty, setCounterparty] = useState("");
  const [sendFaucet, setSendFaucet] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [recvFaucet, setRecvFaucet] = useState("");
  const [recvAmount, setRecvAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swaps, setSwaps] = useState<Swap[]>(() => lsLoad(SWAPS_KEY, [] as Swap[]));

  useEffect(() => {
    if (assets.length > 0 && !sendFaucet) {
      setSendFaucet(assets[0].faucetId);
      setRecvFaucet(assets.length > 1 ? assets[1].faucetId : assets[0].faucetId);
    }
  }, [assets, sendFaucet]);

  useEffect(() => {
    lsSave(SWAPS_KEY, swaps);
  }, [swaps]);

  const handleStartSwap = async () => {
    setError(null);
    if (!requestSend) return setError("Wallet not ready");
    if (!counterparty.trim()) return setError("Enter counterparty address");
    if (counterparty.trim() === address)
      return setError("Counterparty must be different");
    if (!sendFaucet || !recvFaucet) return setError("Select both assets");
    const baseSend = toBaseUnits(sendAmount);
    if (baseSend <= 0) return setError("Enter the amount you're sending");
    if (toBaseUnits(recvAmount) <= 0) return setError("Enter expected amount");

    setSubmitting(true);
    try {
      const txId = await requestSend({
        senderAddress: address,
        recipientAddress: counterparty.trim(),
        faucetId: sendFaucet,
        noteType: "private",
        amount: baseSend,
      });
      logTx({
        txId,
        type: "swap",
        recipient: counterparty.trim(),
        faucetId: sendFaucet,
        amount: sendAmount,
        noteType: "private",
        ts: Date.now(),
      });
      setSwaps((s) => [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          counterparty: counterparty.trim(),
          sendFaucetId: sendFaucet,
          sendAmount,
          recvFaucetId: recvFaucet,
          recvAmount,
          status: "you_sent",
          ourTxId: txId,
          ts: Date.now(),
        },
        ...s,
      ]);
      setCounterparty("");
      setSendAmount("");
      setRecvAmount("");
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const markCompleted = (id: string) =>
    setSwaps((arr) => arr.map((s) => (s.id === id ? { ...s, status: "completed" } : s)));

  const removeSwap = (id: string) => {
    if (!confirm("Remove from list? On-chain tx is NOT reversed.")) return;
    setSwaps((arr) => arr.filter((s) => s.id !== id));
  };

  const sendBalance = assets.find((a) => a.faucetId === sendFaucet);

  return (
    <>
      <div className="card">
        <h2>OTC Swap</h2>
        <p className="hint" style={{ marginBottom: "0.8rem" }}>
          ⚠️ Trust-based: you send first. Atomic version coming.
        </p>
        <label>Counterparty address</label>
        <input
          type="text"
          value={counterparty}
          onChange={(e) => setCounterparty(e.target.value)}
          placeholder="mtst1…"
          spellCheck={false}
        />

        <div className="swap-grid">
          <div className="swap-side">
            <div className="swap-side-label">You send ↑</div>
            <select value={sendFaucet} onChange={(e) => setSendFaucet(e.target.value)}>
              {assets.map((a) => (
                <option key={a.faucetId} value={a.faucetId}>{labelFor(a.faucetId)}</option>
              ))}
            </select>
            <input
              type="number" min="0" step="any"
              value={sendAmount}
              onChange={(e) => setSendAmount(e.target.value)}
              placeholder="10"
            />
            {sendBalance && (
              <p className="hint">Balance: {formatBalance(sendBalance.amount)}</p>
            )}
          </div>
          <div className="swap-arrow">⇄</div>
          <div className="swap-side">
            <div className="swap-side-label">You receive ↓</div>
            <select value={recvFaucet} onChange={(e) => setRecvFaucet(e.target.value)}>
              {assets.map((a) => (
                <option key={a.faucetId} value={a.faucetId}>{labelFor(a.faucetId)}</option>
              ))}
            </select>
            <input
              type="number" min="0" step="any"
              value={recvAmount}
              onChange={(e) => setRecvAmount(e.target.value)}
              placeholder="9"
            />
            <p className="hint">Expected back</p>
          </div>
        </div>

        <button
          onClick={handleStartSwap}
          disabled={submitting || assets.length === 0}
          style={{ width: "100%", marginTop: "1rem" }}
        >
          {submitting ? "Sending your side…" : "🔄 Start Swap"}
        </button>
        {error && <div className="error-box">{error}</div>}
      </div>

      {swaps.length > 0 && (
        <div className="card">
          <h2>Your Swaps ({swaps.length})</h2>
          {swaps.map((s) => (
            <div key={s.id} className={`swap-row status-${s.status}`}>
              <div className="swap-row-top">
                <span className="mono">{shortAddr(s.counterparty, 8, 6)}</span>
                <span className={`badge badge-${s.status}`}>
                  {s.status === "you_sent" ? "⏳ Waiting" : "✅ Completed"}
                </span>
              </div>
              <div className="swap-row-body">
                Sent {s.sendAmount} {labelFor(s.sendFaucetId)} ·
                Expect {s.recvAmount} {labelFor(s.recvFaucetId)}
              </div>
              {s.ourTxId && (
                <div className="swap-row-meta">
                  Tx:{" "}
                  <a
                    href={`${EXPLORER_BASE_URL}/tx/${s.ourTxId}`}
                    target="_blank" rel="noreferrer" className="tx-link"
                  >
                    {shortAddr(s.ourTxId, 8, 6)} ↗
                  </a>
                </div>
              )}
              <div className="swap-actions">
                {s.status === "you_sent" && (
                  <button className="small primary" onClick={() => markCompleted(s.id)}>
                    ✓ Mark completed
                  </button>
                )}
                <button className="ghost small" onClick={() => removeSwap(s.id)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── AIRDROP TAB ───────────────────────────────────────────────────────────

function AirdropTab({ address, assets, labelFor, requestSend, onSent, logTx }: TabProps) {
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

  // Parse "address,amount" or "address amount" lines; if no amount → use defaultAmount
  const parsedRecipients = useMemo(() => {
    const lines = recipientList
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.map((line) => {
      const parts = line.split(/[,\s]+/).filter(Boolean);
      const recipient = parts[0];
      const amount = parts[1] || defaultAmount;
      return { recipient, amount };
    });
  }, [recipientList, defaultAmount]);

  const valid = parsedRecipients.filter(
    (r) => r.recipient.startsWith("mtst1") && toBaseUnits(r.amount) > 0,
  );

  const totalAmount = useMemo(
    () => valid.reduce((sum, r) => sum + parseFloat(r.amount), 0),
    [valid],
  );

  const handleAirdrop = async () => {
    if (!requestSend) return;
    if (valid.length === 0) return;

    setRunning(true);
    setProgress({ done: 0, total: valid.length });
    setResults([]);

    for (const r of valid) {
      try {
        const txId = await requestSend({
          senderAddress: address,
          recipientAddress: r.recipient,
          faucetId,
          noteType,
          amount: toBaseUnits(r.amount),
        });
        setResults((prev) => [...prev, { recipient: r.recipient, amount: r.amount, ok: true, txId }]);
        logTx({
          txId,
          type: "airdrop",
          recipient: r.recipient,
          faucetId,
          amount: r.amount,
          noteType,
          ts: Date.now(),
        });
      } catch (e) {
        setResults((prev) => [
          ...prev,
          {
            recipient: r.recipient,
            amount: r.amount,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          },
        ]);
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }

    setRunning(false);
    onSent();
  };

  const okCount = results.filter((r) => r.ok).length;
  const errCount = results.filter((r) => !r.ok).length;

  return (
    <>
      <div className="card">
        <h2>🪂 Bulk Private Airdrop</h2>
        <p className="hint" style={{ marginBottom: "0.8rem" }}>
          Send to many recipients in one go. One line per recipient — paste{" "}
          <code>address</code> or <code>address,amount</code>.
        </p>

        <label>Asset</label>
        <select value={faucetId} onChange={(e) => setFaucetId(e.target.value)}>
          {assets.length === 0 && <option value="">— no assets —</option>}
          {assets.map((a) => (
            <option key={a.faucetId} value={a.faucetId}>
              {labelFor(a.faucetId)} · {formatBalance(a.amount)}
            </option>
          ))}
        </select>

        <div style={{ marginTop: "0.8rem" }}>
          <label>Default amount (used when line has no amount)</label>
          <input
            type="number" min="0" step="any"
            value={defaultAmount}
            onChange={(e) => setDefaultAmount(e.target.value)}
            placeholder="1"
          />
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
          />
        </div>

        <div style={{ marginTop: "0.8rem" }}>
          <label>Note type</label>
          <div className="radio-row">
            <label className="radio">
              <input type="radio" checked={noteType === "private"} onChange={() => setNoteType("private")} />
              <span>Private 🔒</span>
            </label>
            <label className="radio">
              <input type="radio" checked={noteType === "public"} onChange={() => setNoteType("public")} />
              <span>Public 🌐</span>
            </label>
          </div>
        </div>

        <div className="airdrop-summary">
          <div><strong>{valid.length}</strong> valid recipients</div>
          <div>Total: <strong>{totalAmount} {labelFor(faucetId)}</strong></div>
        </div>

        <button
          onClick={handleAirdrop}
          disabled={running || valid.length === 0 || !faucetId}
          style={{ width: "100%", marginTop: "0.8rem" }}
        >
          {running
            ? `Sending… ${progress.done}/${progress.total}`
            : `🪂 Airdrop to ${valid.length} addresses`}
        </button>

        {running && (
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }}
            />
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
                  {r.ok ? "✅" : "❌"} {shortAddr(r.recipient, 10, 6)} · {r.amount}
                </span>
                {r.txId && (
                  <a
                    href={`${EXPLORER_BASE_URL}/tx/${r.txId}`}
                    target="_blank" rel="noreferrer" className="tx-link"
                  >
                    view ↗
                  </a>
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

function VaultTab({ labelFor }: { labelFor: (faucetId: string) => string }) {
  const [vault, setVault] = useState<VaultEntry[]>(() => lsLoad(VAULT_KEY, [] as VaultEntry[]));
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const removeEntry = (id: string) => {
    if (!confirm("Remove from vault?")) return;
    const next = vault.filter((v) => v.id !== id);
    setVault(next);
    lsSave(VAULT_KEY, next);
  };

  const markRecalled = (id: string) => {
    const next = vault.map((v) => (v.id === id ? { ...v, recalled: true } : v));
    setVault(next);
    lsSave(VAULT_KEY, next);
  };

  if (vault.length === 0) {
    return (
      <div className="card">
        <h2>🔐 Vault</h2>
        <p className="empty">
          No recallable transfers yet. Send something from the Send tab with{" "}
          <strong>Recallable</strong> toggled on.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>🔐 Vault — Recallable Transfers</h2>
        <p className="hint" style={{ marginBottom: "0.5rem" }}>
          Sent with a recall window. If the recipient doesn't claim before the window
          ends, you can reclaim the note in your wallet.
        </p>
      </div>
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
                    ? "⚡ Ready to recall"
                    : `⏳ ${formatDuration(remaining)}`}
              </span>
            </div>

            {!v.recalled && !expired && (
              <div className="countdown-bar">
                <div
                  className="countdown-fill"
                  style={{ width: `${(elapsed / v.recallSeconds) * 100}%` }}
                />
              </div>
            )}

            <div className="vault-meta">
              Tx:{" "}
              <a
                href={`${EXPLORER_BASE_URL}/tx/${v.txId}`}
                target="_blank" rel="noreferrer" className="tx-link"
              >
                {shortAddr(v.txId, 8, 6)} ↗
              </a>
            </div>

            <div className="swap-actions">
              {expired && !v.recalled && (
                <button className="small primary" onClick={() => markRecalled(v.id)}>
                  ✓ Mark as recalled
                </button>
              )}
              <button className="ghost small" onClick={() => removeEntry(v.id)}>
                Remove
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}

// ─── PRIVACY TAB ───────────────────────────────────────────────────────────

function PrivacyTab({
  txLog,
  labelFor,
}: {
  txLog: TxLogEntry[];
  aliases: Record<string, string>;
  labelFor: (faucetId: string) => string;
}) {
  const stats = useMemo(() => {
    const total = txLog.length;
    const priv = txLog.filter((t) => t.noteType === "private").length;
    const pub = total - priv;
    const uniqueRecipients = new Set(txLog.map((t) => t.recipient)).size;
    const uniqueAssets = new Set(txLog.map((t) => t.faucetId)).size;
    const last7days = txLog.filter((t) => t.ts > Date.now() - 7 * 86400_000).length;

    // Privacy score (0-100): privacy ratio + diversity bonuses
    const ratio = total > 0 ? priv / total : 0;
    const base = ratio * 60;
    const diversityBonus = Math.min(uniqueRecipients * 2, 20);
    const volumeBonus = Math.min(total * 1, 20);
    const score = Math.round(base + diversityBonus + volumeBonus);

    return { total, priv, pub, uniqueRecipients, uniqueAssets, last7days, score, ratio };
  }, [txLog]);

  const typeCount = useMemo(() => {
    const c: Record<string, number> = { send: 0, swap: 0, airdrop: 0 };
    txLog.forEach((t) => {
      c[t.type] = (c[t.type] || 0) + 1;
    });
    return c;
  }, [txLog]);

  // Asset breakdown
  const assetBreakdown = useMemo(() => {
    const map: Record<string, number> = {};
    txLog.forEach((t) => {
      map[t.faucetId] = (map[t.faucetId] || 0) + 1;
    });
    return Object.entries(map)
      .map(([fid, count]) => ({ fid, count, label: labelFor(fid) }))
      .sort((a, b) => b.count - a.count);
  }, [txLog, labelFor]);

  const scoreColor =
    stats.score >= 80 ? "#4ade80" : stats.score >= 50 ? "#fbbf24" : "#fca5a5";
  const scoreLabel =
    stats.score >= 80 ? "Excellent" : stats.score >= 50 ? "Good" : "Room to improve";

  if (stats.total === 0) {
    return (
      <div className="card">
        <h2>📊 Privacy Dashboard</h2>
        <p className="empty">
          Send a few transactions first — your privacy metrics will appear here.
        </p>
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
            <div className="privacy-value" style={{ color: scoreColor }}>
              {stats.score}/100
            </div>
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
          {Math.round(stats.ratio * 100)}% of your transactions use private notes —
          hidden from chain explorers.
        </p>
      </div>

      <div className="card">
        <h2>Activity by type</h2>
        <BarChart data={[
          { label: "💸 Send", value: typeCount.send, color: "#6366f1" },
          { label: "🔄 Swap", value: typeCount.swap, color: "#8b5cf6" },
          { label: "🪂 Airdrop", value: typeCount.airdrop, color: "#ec4899" },
        ]} />
      </div>

      {assetBreakdown.length > 0 && (
        <div className="card">
          <h2>Top assets</h2>
          {assetBreakdown.slice(0, 5).map((a) => (
            <div key={a.fid} className="asset">
              <span className={a.label.length <= 8 ? "asset-symbol" : "mono"}>
                {a.label}
              </span>
              <span className="amount">{a.count} tx</span>
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <h2>Tips to improve privacy</h2>
        <ul className="tips">
          {stats.ratio < 0.8 && (
            <li>Use <strong>Private</strong> notes by default — toggle in Send tab.</li>
          )}
          {stats.uniqueRecipients < 5 && (
            <li>Send to more distinct addresses to grow your anonymity set.</li>
          )}
          {stats.uniqueAssets < 2 && (
            <li>Try using multiple assets — diversity increases unlinkability.</li>
          )}
          {stats.total < 10 && (
            <li>Reach 10+ transactions for stronger privacy heuristics.</li>
          )}
          <li>Enable <strong>Recallable</strong> on large transfers to mitigate typo risk.</li>
        </ul>
      </div>
    </>
  );
}

// ─── Small visual primitives ───────────────────────────────────────────────

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-value" style={color ? { color } : undefined}>
        {value}
      </div>
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
      <circle
        cx="48" cy="48" r={radius}
        stroke="rgba(255,255,255,0.08)" strokeWidth="8" fill="none"
      />
      <circle
        cx="48" cy="48" r={radius}
        stroke={color} strokeWidth="8" fill="none"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 48 48)"
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
      <text
        x="48" y="55" textAnchor="middle"
        fontSize="20" fontWeight="700" fill={color}
      >
        {value}
      </text>
    </svg>
  );
}

function RatioBar({ priv, pub }: { priv: number; pub: number }) {
  const total = priv + pub;
  if (total === 0) return null;
  const privPct = (priv / total) * 100;
  return (
    <div className="ratio-bar">
      <div
        className="ratio-priv"
        style={{ width: `${privPct}%` }}
        title={`${priv} private`}
      >
        🔒 {priv}
      </div>
      <div
        className="ratio-pub"
        style={{ width: `${100 - privPct}%` }}
        title={`${pub} public`}
      >
        🌐 {pub}
      </div>
    </div>
  );
}

function BarChart({
  data,
}: {
  data: { label: string; value: number; color: string }[];
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="barchart">
      {data.map((d) => (
        <div key={d.label} className="bar-row">
          <div className="bar-label">{d.label}</div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: `${(d.value / max) * 100}%`,
                background: d.color,
              }}
            />
          </div>
          <div className="bar-value">{d.value}</div>
        </div>
      ))}
    </div>
  );
}
