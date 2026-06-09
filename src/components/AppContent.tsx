import { useState, useEffect, useCallback } from "react";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import type { Asset } from "@miden-sdk/miden-wallet-adapter-base";
import { EXPLORER_BASE_URL } from "@/config";
import "./AppContent.css";

interface SendResult {
  txId: string;
  recipient: string;
  amount: string;
  faucetId: string;
  noteType: "public" | "private";
  ts: number;
}

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

  const [assets, setAssets] = useState<Asset[]>([]);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [faucetId, setFaucetId] = useState("");
  const [noteType, setNoteType] = useState<"public" | "private">("private");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SendResult[]>([]);

  // Pick first installed wallet automatically
  useEffect(() => {
    if (!connected && !connecting && wallets.length > 0) {
      const firstReady = wallets[0];
      if (firstReady?.adapter.name) {
        select(firstReady.adapter.name);
      }
    }
  }, [connected, connecting, wallets, select]);

  const handleConnect = useCallback(async () => {
    setError(null);
    try {
      await connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [connect]);

  const loadAssets = useCallback(async () => {
    if (!requestAssets) return;
    setLoadingAssets(true);
    setError(null);
    try {
      const list = await requestAssets();
      setAssets(list);
      if (list.length > 0 && !faucetId) {
        setFaucetId(list[0].faucetId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingAssets(false);
    }
  }, [requestAssets, faucetId]);

  // Auto-load assets once connected
  useEffect(() => {
    if (connected && assets.length === 0) {
      loadAssets();
    }
  }, [connected, assets.length, loadAssets]);

  const handleSend = useCallback(async () => {
    setError(null);

    if (!connected || !address) {
      setError("Connect wallet first");
      return;
    }
    if (!requestSend) {
      setError("Wallet does not support requestSend");
      return;
    }
    if (!recipient.trim()) {
      setError("Enter a recipient address");
      return;
    }
    if (!faucetId) {
      setError("Select an asset");
      return;
    }
    const amt = Number(amount);
    if (!amt || amt <= 0) {
      setError("Enter a valid amount");
      return;
    }

    setIsSending(true);
    try {
      const txId = await requestSend({
        senderAddress: address,
        recipientAddress: recipient.trim(),
        faucetId,
        noteType,
        amount: amt,
      });

      setHistory((h) => [
        {
          txId,
          recipient: recipient.trim(),
          amount: String(amt),
          faucetId,
          noteType,
          ts: Date.now(),
        },
        ...h,
      ]);
      setRecipient("");
      setAmount("");
      // refresh balances
      loadAssets();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSending(false);
    }
  }, [
    connected,
    address,
    requestSend,
    recipient,
    faucetId,
    amount,
    noteType,
    loadAssets,
  ]);

  const shortAddr = address ? `${address.slice(0, 10)}…${address.slice(-6)}` : "";

  return (
    <div className="app">
      <h1>🔒 Miden Private Transfer</h1>
      <p className="subtitle">
        Real on-chain transfers on Miden testnet · private notes by default
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
        </div>
      ) : (
        <>
          <div className="wallet-info">
            <span>✅ {shortAddr}</span>
            <button
              className="disconnect-btn"
              onClick={() => disconnect()}
              title="Disconnect"
            >
              ×
            </button>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Your Assets</h2>
              <button
                className="ghost"
                onClick={loadAssets}
                disabled={loadingAssets}
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
                <span className="mono">
                  {a.faucetId.slice(0, 14)}…{a.faucetId.slice(-6)}
                </span>
                <span className="amount">{a.amount}</span>
              </div>
            ))}
          </div>

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
                <label>Asset (faucet ID)</label>
                <select
                  value={faucetId}
                  onChange={(e) => setFaucetId(e.target.value)}
                  disabled={assets.length === 0}
                >
                  {assets.length === 0 && (
                    <option value="">— no assets —</option>
                  )}
                  {assets.map((a) => (
                    <option key={a.faucetId} value={a.faucetId}>
                      {a.faucetId.slice(0, 18)}… · {a.amount}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label>Amount</label>
                <input
                  type="number"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="100"
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
                      {h.amount} {noteType === "private" ? "🔒" : "🌐"} →{" "}
                      {h.recipient.slice(0, 10)}…{h.recipient.slice(-6)}
                    </span>
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
              ))}
            </div>
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
