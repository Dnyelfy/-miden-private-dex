import { useState, useEffect, useCallback } from "react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import type { Asset } from "@miden-sdk/miden-wallet-adapter-base";
import { EXPLORER_BASE_URL } from "@/config";
import "./AppContent.css";

// Miden testnet faucets use 6 decimals. 1 token = 1_000_000 base units.
const DECIMALS = 6;
const FACTOR = 10 ** DECIMALS;

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

// ─── Types ──────────────────────────────────────────────────────────────────

interface SendResult {
  txId: string;
  recipient: string;
  amount: string;
  faucetId: string;
  noteType: "public" | "private";
  ts: number;
}

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

const SWAPS_KEY = "miden_dex_swaps_v1";

function loadSwaps(): Swap[] {
  try {
    const raw = localStorage.getItem(SWAPS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSwaps(swaps: Swap[]) {
  try {
    localStorage.setItem(SWAPS_KEY, JSON.stringify(swaps));
  } catch {
    /* ignore */
  }
}

// ─── Main component ─────────────────────────────────────────────────────────

type Tab = "send" | "swap";

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

  return (
    <div className="app">
      <h1>🔒 Miden Private DEX</h1>
      <p className="subtitle">
        Send and swap on Miden testnet · private notes by default
      </p>

      {!connected ? (
        <div className="wallet-info-disconnected">
          {wallets.length === 0 ? (
            <>
              <p>
                <strong>MidenFi Wallet</strong> extension not found.
              </p>
              <p style={{ fontSize: "0.85rem", marginTop: "0.5rem" }}>
                Install it, then refresh this page.
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
            <span
              className="addr-clickable"
              onClick={copyAddress}
              title="Click to copy"
            >
              {addrCopied ? "✅ Copied!" : `✅ ${shortAddr(address!, 10, 6)}`}
            </span>
            <button
              className="disconnect-btn"
              onClick={() => disconnect()}
              title="Disconnect"
            >
              ×
            </button>
          </div>

          <div className="tabs">
            <button
              className={`tab ${tab === "send" ? "active" : ""}`}
              onClick={() => setTab("send")}
            >
              💸 Send
            </button>
            <button
              className={`tab ${tab === "swap" ? "active" : ""}`}
              onClick={() => setTab("swap")}
            >
              🔄 Swap
            </button>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Your Assets</h2>
              <button
                className="ghost"
                onClick={loadAssets}
                disabled={loadingAssets}
                title="Refresh"
              >
                {loadingAssets ? "…" : "↻"}
              </button>
            </div>
            {assets.length === 0 && (
              <p className="empty">
                {loadingAssets
                  ? "Loading…"
                  : "No assets yet — get testnet tokens from the Miden faucet."}
              </p>
            )}
            {assets.map((a) => (
              <div key={a.faucetId} className="asset">
                <span className="mono">{shortAddr(a.faucetId, 14, 6)}</span>
                <span className="amount">{formatBalance(a.amount)}</span>
              </div>
            ))}
          </div>

          {tab === "send" ? (
            <SendTab
              address={address!}
              assets={assets}
              requestSend={requestSend}
              onSent={loadAssets}
            />
          ) : (
            <SwapTab
              address={address!}
              assets={assets}
              requestSend={requestSend}
              onSent={loadAssets}
            />
          )}
        </>
      )}

      <p className="footer">
        Testnet ·{" "}
        <a
          href={EXPLORER_BASE_URL}
          target="_blank"
          rel="noreferrer"
          className="tx-link"
        >
          midenscan.com
        </a>
      </p>
    </div>
  );
}

// ─── Send tab ───────────────────────────────────────────────────────────────

interface TabProps {
  address: string;
  assets: Asset[];
  requestSend: ReturnType<typeof useMidenFiWallet>["requestSend"];
  onSent: () => void;
}

function SendTab({ address, assets, requestSend, onSent }: TabProps) {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [faucetId, setFaucetId] = useState("");
  const [noteType, setNoteType] = useState<"public" | "private">("private");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SendResult[]>([]);
  const [copiedTxId, setCopiedTxId] = useState<string | null>(null);

  useEffect(() => {
    if (assets.length > 0 && !faucetId) setFaucetId(assets[0].faucetId);
  }, [assets, faucetId]);

  const selectedAsset = assets.find((a) => a.faucetId === faucetId);
  const selectedBalance = selectedAsset ? formatBalance(selectedAsset.amount) : "0";

  const copyTxId = (txId: string) => {
    navigator.clipboard.writeText(txId).then(() => {
      setCopiedTxId(txId);
      setTimeout(() => setCopiedTxId(null), 1400);
    });
  };

  const handleSend = async () => {
    setError(null);
    if (!requestSend) return setError("Wallet does not support requestSend");
    if (!recipient.trim()) return setError("Enter a recipient address");
    if (!faucetId) return setError("Select an asset");
    const baseAmount = toBaseUnits(amount);
    if (baseAmount <= 0) return setError("Enter a valid amount");

    setIsSending(true);
    try {
      const txId = await requestSend({
        senderAddress: address,
        recipientAddress: recipient.trim(),
        faucetId,
        noteType,
        amount: baseAmount,
      });
      setHistory((h) => [
        { txId, recipient: recipient.trim(), amount, faucetId, noteType, ts: Date.now() },
        ...h,
      ]);
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
                  {shortAddr(a.faucetId, 16, 6)} · {formatBalance(a.amount)}
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
            <p className="hint">
              {noteType === "private"
                ? "🔒 Hidden on midenscan. Recipient sees & accepts the note in their wallet."
                : "🌐 Visible on midenscan. Auto-credited to recipient."}
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
      </div>

      {history.length > 0 && (
        <div className="card">
          <h2>Recent transactions</h2>
          {history.map((h) => (
            <div key={h.txId} className="tx-row">
              <div className="tx-row-top">
                <span>
                  {h.amount} {h.noteType === "private" ? "🔒" : "🌐"} →{" "}
                  {shortAddr(h.recipient, 10, 6)}
                </span>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button
                    className="ghost tiny"
                    onClick={() => copyTxId(h.txId)}
                    title="Copy tx ID"
                  >
                    {copiedTxId === h.txId ? "✓" : "⧉"}
                  </button>
                  <a
                    className="tx-link"
                    href={`${EXPLORER_BASE_URL}/tx/${h.txId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    view ↗
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Swap tab ───────────────────────────────────────────────────────────────

function SwapTab({ address, assets, requestSend, onSent }: TabProps) {
  const [counterparty, setCounterparty] = useState("");
  const [sendFaucet, setSendFaucet] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [recvFaucet, setRecvFaucet] = useState("");
  const [recvAmount, setRecvAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [swaps, setSwaps] = useState<Swap[]>(() => loadSwaps());

  useEffect(() => {
    if (assets.length > 0 && !sendFaucet) {
      setSendFaucet(assets[0].faucetId);
      setRecvFaucet(assets.length > 1 ? assets[1].faucetId : assets[0].faucetId);
    }
  }, [assets, sendFaucet]);

  useEffect(() => {
    saveSwaps(swaps);
  }, [swaps]);

  const handleStartSwap = async () => {
    setError(null);
    if (!requestSend) return setError("Wallet not ready");
    if (!counterparty.trim()) return setError("Enter counterparty address");
    if (counterparty.trim() === address)
      return setError("Counterparty must be a different address");
    if (!sendFaucet || !recvFaucet) return setError("Select both assets");
    const baseSend = toBaseUnits(sendAmount);
    if (baseSend <= 0) return setError("Enter the amount you're sending");
    if (toBaseUnits(recvAmount) <= 0)
      return setError("Enter the amount you expect back");

    setSubmitting(true);
    try {
      const txId = await requestSend({
        senderAddress: address,
        recipientAddress: counterparty.trim(),
        faucetId: sendFaucet,
        noteType: "private",
        amount: baseSend,
      });

      const newSwap: Swap = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        counterparty: counterparty.trim(),
        sendFaucetId: sendFaucet,
        sendAmount,
        recvFaucetId: recvFaucet,
        recvAmount,
        status: "you_sent",
        ourTxId: txId,
        ts: Date.now(),
      };
      setSwaps((s) => [newSwap, ...s]);
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

  const markCompleted = (id: string) => {
    setSwaps((arr) =>
      arr.map((s) => (s.id === id ? { ...s, status: "completed" } : s)),
    );
  };

  const cancelLocal = (id: string) => {
    if (!confirm("Remove this swap from your local list? On-chain tx is NOT reversed.")) return;
    setSwaps((arr) => arr.filter((s) => s.id !== id));
  };

  const sendBalance = assets.find((a) => a.faucetId === sendFaucet);

  return (
    <>
      <div className="card swap-card">
        <h2>New Swap</h2>
        <p className="hint" style={{ marginBottom: "0.8rem" }}>
          ⚠️ OTC swap: you send first, counterparty sends back. Trust-based —
          atomic version coming next.
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
            <select
              value={sendFaucet}
              onChange={(e) => setSendFaucet(e.target.value)}
              disabled={assets.length === 0}
            >
              {assets.length === 0 && <option value="">— no assets —</option>}
              {assets.map((a) => (
                <option key={a.faucetId} value={a.faucetId}>
                  {shortAddr(a.faucetId, 12, 4)}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              step="any"
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
            <select
              value={recvFaucet}
              onChange={(e) => setRecvFaucet(e.target.value)}
              disabled={assets.length === 0}
            >
              {assets.length === 0 && <option value="">— no assets —</option>}
              {assets.map((a) => (
                <option key={a.faucetId} value={a.faucetId}>
                  {shortAddr(a.faucetId, 12, 4)}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="0"
              step="any"
              value={recvAmount}
              onChange={(e) => setRecvAmount(e.target.value)}
              placeholder="9"
            />
            <p className="hint">Expected from counterparty</p>
          </div>
        </div>

        <button
          onClick={handleStartSwap}
          disabled={submitting || assets.length === 0}
          style={{ width: "100%", marginTop: "1rem" }}
        >
          {submitting ? "Sending your side…" : "🔄 Start Swap (sends your side)"}
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
                Sent {s.sendAmount} of {shortAddr(s.sendFaucetId, 6, 4)} · Expect{" "}
                {s.recvAmount} of {shortAddr(s.recvFaucetId, 6, 4)}
              </div>
              {s.ourTxId && (
                <div className="swap-row-meta">
                  Your tx:{" "}
                  <a
                    href={`${EXPLORER_BASE_URL}/tx/${s.ourTxId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="tx-link"
                  >
                    {shortAddr(s.ourTxId, 8, 6)} ↗
                  </a>
                </div>
              )}
              <div className="swap-actions">
                {s.status === "you_sent" && (
                  <button
                    className="small primary"
                    onClick={() => markCompleted(s.id)}
                  >
                    ✓ Mark as completed
                  </button>
                )}
                <button className="ghost small" onClick={() => cancelLocal(s.id)}>
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
