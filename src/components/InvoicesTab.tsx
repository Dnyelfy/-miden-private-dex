import { useState, useEffect, useCallback, useMemo } from "react";
import type { InputNoteDetails } from "@miden-sdk/miden-wallet-adapter-base";
import { EXPLORER_BASE_URL } from "@/config";

// ─── Constants & helpers ───────────────────────────────────────────────────

const DECIMALS = 6;
const FACTOR = 10 ** DECIMALS;
const STORE = "miden_invoices_v1";

function fmt(raw: string | number | bigint): string {
  const n = Number(raw) / FACTOR;
  return n.toLocaleString(undefined, { maximumFractionDigits: DECIMALS });
}

function toBase(display: string): number {
  const n = parseFloat(display);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * FACTOR);
}

function short(s: string, head = 8, tail = 6): string {
  if (!s) return "";
  if (s.length <= head + tail + 2) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function lsLoad<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function lsSave(key: string, val: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* quota / private mode */
  }
}

function whenReadable(ts: number): string {
  const diff = Date.now() - ts;
  const days = Math.floor(diff / 86400000);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.max(1, Math.floor(diff / 60000));
  return `${mins}m ago`;
}

// ─── Stored shape ──────────────────────────────────────────────────────────

type Invoice = {
  id: string;
  number: number;
  faucetId: string;
  amount: string; // display units
  memo: string;
  createdAt: number;
  paidAt?: number;
  paidNoteId?: string;
  claimedTxId?: string;
};

// ─── Component ─────────────────────────────────────────────────────────────

export function InvoicesTab({
  address,
  assets,
  labelFor,
  requestConsumableNotes,
  requestConsume,
  onClaimed,
  humanError,
  noteTypeString,
}: {
  address: string;
  assets: { faucetId: string; amount: string }[];
  labelFor: (faucetId: string) => string;
  requestConsumableNotes: (() => Promise<InputNoteDetails[]>) | undefined;
  requestConsume:
    | ((tx: {
        faucetId: string;
        noteId: string;
        noteType: "public" | "private";
        amount: number;
      }) => Promise<string>)
    | undefined;
  onClaimed: () => void;
  humanError: (e: unknown) => string;
  noteTypeString: (v: unknown) => "public" | "private";
}) {
  const storeKey = `${STORE}:${(address || "").toLowerCase()}`;

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [faucetId, setFaucetId] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");

  const [checking, setChecking] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    setInvoices(lsLoad(storeKey, [] as Invoice[]));
  }, [storeKey]);

  useEffect(() => {
    if (invoices.length > 0) lsSave(storeKey, invoices);
  }, [invoices, storeKey]);

  useEffect(() => {
    if (assets.length > 0 && !faucetId) setFaucetId(assets[0].faucetId);
  }, [assets, faucetId]);

  const nextNumber = useMemo(
    () => invoices.reduce((max, i) => Math.max(max, i.number), 0) + 1,
    [invoices],
  );

  const linkFor = useCallback(
    (inv: Invoice) => {
      const origin = window.location.origin + window.location.pathname;
      const p = new URLSearchParams();
      p.set("to", address);
      if (inv.amount) p.set("amt", inv.amount);
      if (inv.faucetId) p.set("faucet", inv.faucetId);
      if (inv.memo) p.set("memo", inv.memo);
      return `${origin}?${p.toString()}`;
    },
    [address],
  );

  // ── Create ───────────────────────────────────────────────────────────────

  const handleCreate = useCallback(() => {
    setErr(null);
    setNotice(null);
    if (!faucetId) return setErr("Pick which token you are invoicing in.");
    if (toBase(amount) <= 0) return setErr("Enter the amount you are asking for.");

    const inv: Invoice = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      number: nextNumber,
      faucetId,
      amount,
      memo: memo.trim().slice(0, 120),
      createdAt: Date.now(),
    };
    setInvoices((prev) => [inv, ...prev]);
    setAmount("");
    setMemo("");
    setNotice(`Invoice #${inv.number} created. Copy the link and send it.`);
  }, [faucetId, amount, memo, nextNumber]);

  // ── Match incoming notes against open invoices ───────────────────────────

  const handleCheck = useCallback(async () => {
    if (!requestConsumableNotes) return;
    setChecking(true);
    setErr(null);
    setNotice(null);
    try {
      const notes = await requestConsumableNotes();
      const open = invoices.filter((i) => !i.paidAt);
      if (open.length === 0) {
        setNotice("No open invoices to match.");
        return;
      }

      const usedNoteIds = new Set(
        invoices.map((i) => i.paidNoteId).filter(Boolean) as string[],
      );
      const matched: Record<string, string> = {};

      for (const inv of open) {
        const target = toBase(inv.amount);
        const hit = notes.find((n) => {
          if (usedNoteIds.has(n.noteId)) return false;
          const a = n.assets?.[0];
          if (!a) return false;
          return (
            a.faucetId === inv.faucetId && Number(a.amount) === target
          );
        });
        if (hit) {
          matched[inv.id] = hit.noteId;
          usedNoteIds.add(hit.noteId);
        }
      }

      const count = Object.keys(matched).length;
      if (count === 0) {
        setNotice(
          "Nothing matched yet. A payment shows up here once it reaches your wallet.",
        );
        return;
      }

      setInvoices((prev) =>
        prev.map((i) =>
          matched[i.id]
            ? { ...i, paidAt: Date.now(), paidNoteId: matched[i.id] }
            : i,
        ),
      );
      setNotice(
        `${count} invoice${count === 1 ? "" : "s"} marked as paid. Claim below to move the funds into your balance.`,
      );
    } catch (e) {
      setErr(humanError(e));
    } finally {
      setChecking(false);
    }
  }, [requestConsumableNotes, invoices, humanError]);

  // ── Claim a paid invoice ─────────────────────────────────────────────────

  const handleClaim = useCallback(
    async (inv: Invoice) => {
      if (!requestConsume || !inv.paidNoteId || !requestConsumableNotes) return;
      setClaimingId(inv.id);
      setErr(null);
      setNotice(null);
      try {
        const notes = await requestConsumableNotes();
        const note = notes.find((n) => n.noteId === inv.paidNoteId);
        if (!note) {
          throw new Error("That payment is no longer available to claim.");
        }
        const asset = note.assets?.[0];
        if (!asset) throw new Error("Note has no assets");

        const txId = await requestConsume({
          faucetId: String(asset.faucetId),
          noteId: String(note.noteId),
          noteType: noteTypeString(note.noteType),
          amount: Number(asset.amount),
        });

        setInvoices((prev) =>
          prev.map((i) => (i.id === inv.id ? { ...i, claimedTxId: txId } : i)),
        );
        onClaimed();
        setNotice(`Invoice #${inv.number} claimed.`);
      } catch (e) {
        setErr(humanError(e));
      } finally {
        setClaimingId(null);
      }
    },
    [requestConsume, requestConsumableNotes, noteTypeString, humanError, onClaimed],
  );

  const copy = useCallback(async (inv: Invoice, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(inv.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* clipboard blocked */
    }
  }, []);

  const remove = useCallback((id: string) => {
    setInvoices((prev) => {
      const next = prev.filter((i) => i.id !== id);
      lsSave(storeKey, next);
      return next;
    });
  }, [storeKey]);

  const openCount = invoices.filter((i) => !i.paidAt).length;

  return (
    <>
      <style>{INVOICE_CSS}</style>

      <div className="card">
        <h2>New Invoice</h2>
        <p className="hint">
          Ask someone for a specific amount. They get a link that opens the Send
          tab with everything filled in. When the payment lands, the invoice
          here flips to paid — you do not have to remember who owes what.
        </p>

        <div className="inv-grid">
          <div>
            <label>Token</label>
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
            <label>Amount</label>
            <input
              type="number"
              min="0"
              step="any"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
            />
          </div>
        </div>

        <div>
          <label>What is it for (optional)</label>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value.slice(0, 120))}
            placeholder="e.g. Design work, March"
            maxLength={120}
          />
        </div>

        <button
          className="primary"
          onClick={handleCreate}
          style={{ width: "100%", marginTop: "1rem" }}
          disabled={assets.length === 0}
        >
          Create invoice #{nextNumber}
        </button>

        {err && <div className="error-box">{err}</div>}
        {notice && <div className="success-box">{notice}</div>}
      </div>

      <div className="card">
        <div className="inv-head">
          <h2>Invoices</h2>
          <button
            className="ghost"
            onClick={handleCheck}
            disabled={checking || openCount === 0}
          >
            {checking ? "Checking…" : "Check for payments"}
          </button>
        </div>

        {invoices.length === 0 && (
          <p className="empty">
            No invoices yet. Create one above and send the link.
          </p>
        )}

        {invoices.map((inv) => {
          const link = linkFor(inv);
          const paid = Boolean(inv.paidAt);
          return (
            <div className={`inv-row ${paid ? "inv-paid" : ""}`} key={inv.id}>
              <div className="inv-top">
                <div>
                  <div className="inv-amount">
                    {fmt(toBase(inv.amount))}{" "}
                    <span className="inv-token">{labelFor(inv.faucetId)}</span>
                  </div>
                  <div className="inv-meta">
                    #{inv.number}
                    {inv.memo ? ` · ${inv.memo}` : ""} ·{" "}
                    {whenReadable(inv.createdAt)}
                  </div>
                </div>

                {inv.claimedTxId ? (
                  <a
                    className="badge badge-completed"
                    href={`${EXPLORER_BASE_URL}/tx/${inv.claimedTxId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    ✅ Claimed
                  </a>
                ) : paid ? (
                  <button
                    className="small primary"
                    onClick={() => handleClaim(inv)}
                    disabled={claimingId === inv.id}
                  >
                    {claimingId === inv.id ? "…" : "Claim payment"}
                  </button>
                ) : (
                  <span className="badge badge-you_sent">Awaiting payment</span>
                )}
              </div>

              {!paid && (
                <div className="inv-link">
                  <div className="inv-link-value mono">{link}</div>
                  <button className="ghost" onClick={() => copy(inv, link)}>
                    {copiedId === inv.id ? "Copied ✓" : "Copy link"}
                  </button>
                </div>
              )}

              <button className="inv-remove" onClick={() => remove(inv.id)}>
                Remove
              </button>
            </div>
          );
        })}

        {invoices.length > 0 && (
          <p className="hint" style={{ marginTop: "0.8rem" }}>
            Matching works on token and exact amount, so give each open invoice
            a different amount if you are waiting on several at once.
          </p>
        )}
      </div>
    </>
  );
}

// ─── Scoped styles ─────────────────────────────────────────────────────────

const INVOICE_CSS = `
.inv-grid { display:flex; gap:.8rem; flex-wrap:wrap; }
.inv-grid > div { flex:1 1 10rem; min-width:0; }
.inv-head { display:flex; align-items:center; justify-content:space-between;
  gap:1rem; }
.inv-head h2 { margin:0; }
.inv-row { border-top:1px solid rgba(255,255,255,.08); padding:.9rem 0;
  position:relative; }
.inv-paid { opacity:.95; }
.inv-top { display:flex; align-items:flex-start; justify-content:space-between;
  gap:1rem; flex-wrap:wrap; }
.inv-amount { font-size:1.05rem; font-weight:600; }
.inv-token { font-weight:400; opacity:.7; font-size:.9rem; }
.inv-meta { font-size:.75rem; opacity:.6; margin-top:.2rem; }
.inv-link { display:flex; align-items:center; gap:.5rem; margin-top:.6rem;
  flex-wrap:wrap; }
.inv-link-value { flex:1 1 12rem; min-width:0; font-size:.68rem; opacity:.7;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.inv-remove { background:none; border:none; color:inherit; opacity:.35;
  font-size:.7rem; cursor:pointer; padding:.3rem 0 0; }
.inv-remove:hover { opacity:.8; }
`;
