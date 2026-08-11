import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  usePswapCreate,
  usePswapConsume,
  usePswapCancelByOrder,
  usePswapLineagesFor,
  useSyncState,
  accountIdsEqual,
  useExportNote,
  useImportNote,
  type PswapLineageRecord,
} from "@miden-sdk/react";
import type { Asset } from "@miden-sdk/miden-wallet-adapter-base";
import { EXPLORER_BASE_URL } from "@/config";

// ─── Constants & helpers ───────────────────────────────────────────────────

const DECIMALS = 6;
const FACTOR = 10 ** DECIMALS;

// PswapLineageState: 0 = Active, 1 = FullyFilled, 2 = Reclaimed
const STATE_ACTIVE = 0;

const LINK_STORE = "miden_swap_links_v1";
const MAX_URL_LEN = 7500;
const FAUCET_STORE = "miden_known_faucets_v1";

// ─── Human-readable errors ─────────────────────────────────────────────────

const ERROR_HINTS: [RegExp, string][] = [
  [/insufficient|not enough|exceeds balance/i, "You do not have enough of that asset."],
  [/rejected|denied|cancell?ed by user|user rejected/i, "You cancelled the request in your wallet."],
  [/not connected|no wallet|wallet not found/i, "Your wallet is not connected."],
  [/note.*(not found|unknown|missing)|unknown note/i, "That offer is no longer available — it may already have been filled."],
  [/already consumed|already spent|nullifier/i, "That offer has already been used."],
  [/timeout|timed out|deadline/i, "The network took too long to answer. Try again."],
  [/network|fetch|rpc|connection|offline/i, "Cannot reach the Miden network right now."],
  [/invalid.*(address|account id)|malformed/i, "That address does not look right."],
  [/inclusion proof|not.*committed/i, "Your offer is on-chain but has not been included in a block yet. Give it a moment, then press 'Get link'."],
  [/faucet/i, "There is a problem with that token's faucet."],
];

function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  for (const [re, msg] of ERROR_HINTS) if (re.test(raw)) return msg;
  return "Something went wrong. Please try again.";
}

/** A faucet the user has seen before: shown in the picker so nobody
 *  has to paste a raw mtst1… id from memory. */
type KnownFaucet = { id: string; label: string };


function fmt(raw: bigint | number): string {
  const n = Number(raw) / FACTOR;
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function toBase(display: string): number {
  const n = Number(display);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * FACTOR);
}

function short(s: string, head = 8, tail = 6): string {
  if (!s || s.length <= head + tail + 1) return s;
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

// ─── base64url, chunked so large notes do not blow the call stack ──────────

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A PswapLineageRecord is a WASM handle. Flatten it into a plain object on
// every read so React never touches a freed pointer during a later render.
type Order = {
  orderId: string;
  creator: string;
  tipNoteId: string;
  depth: number;
  remainingOffered: bigint;
  remainingRequested: bigint;
  state: number;
};

function flatten(rec: PswapLineageRecord): Order | null {
  try {
    return {
      orderId: rec.orderId(),
      creator: rec.creatorAccountId().toString(),
      tipNoteId: rec.currentTipNoteId().toString(),
      depth: rec.currentDepth(),
      remainingOffered: rec.remainingOffered(),
      remainingRequested: rec.remainingRequested(),
      state: rec.state() as unknown as number,
    };
  } catch {
    return null;
  }
}

/** Read an offer payload out of the URL fragment, if present. */
function readOfferFromHash(): string | null {
  if (typeof window === "undefined") return null;
  const h = window.location.hash.replace(/^#/, "");
  if (!h) return null;
  const params = new URLSearchParams(h);
  return params.get("offer");
}

// ─── Component ─────────────────────────────────────────────────────────────

export function SwapTab({
  accountId,
  assets,
  labelFor,
}: {
  accountId: string;
  assets: Asset[];
  labelFor: (faucetId: string) => string;
}) {
  // ── Offer form ──
  const [offerFaucet, setOfferFaucet] = useState("");
  const [offerAmount, setOfferAmount] = useState("");
  const [wantFaucet, setWantFaucet] = useState("");
  const [wantOther, setWantOther] = useState(false);
  const [known, setKnown] = useState<KnownFaucet[]>(() =>
    lsLoad(FAUCET_STORE, [] as KnownFaucet[]),
  );
  const [wantAmount, setWantAmount] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);

  // ── Created offer ──
  const [building, setBuilding] = useState(false);
  const [buildStage, setBuildStage] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ── Incoming offer ──
  const [payload, setPayload] = useState<string | null>(() => readOfferFromHash());
  const [incoming, setIncoming] = useState<Order | null>(null);
  const [incomingErr, setIncomingErr] = useState<string | null>(null);
  const [loadingIncoming, setLoadingIncoming] = useState(false);
  const [fillAmount, setFillAmount] = useState("");
  const [fillTx, setFillTx] = useState<string | null>(null);

  // ── Saved links, so an offer can be re-shared later ──
  const [savedLinks, setSavedLinks] = useState<Record<string, string>>(() =>
    lsLoad(LINK_STORE, {} as Record<string, string>),
  );

  const [rawErr, setRawErr] = useState<string | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);

  // Keeps the real error text around while still showing something readable.
  const explain = useCallback((e: unknown) => {
    const raw =
      e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e);
    setRawErr(raw);
    // eslint-disable-next-line no-console
    console.error("[swap]", e);
    return humanError(e);
  }, []);

  const { pswapCreate, isLoading: creating } = usePswapCreate();
  const { pswapConsume, isLoading: filling } = usePswapConsume();
  const { pswapCancelByOrder, isLoading: cancelling } = usePswapCancelByOrder();
  const { lineages, isLoading: loadingOrders, refetch } =
    usePswapLineagesFor(accountId || null);
  const { sync } = useSyncState();
  const { exportNote } = useExportNote();
  const { importNote } = useImportNote();


  // Keep a ref mirror so async loops can read the freshest orders.
  const ordersRef = useRef<Order[]>([]);

  const orders = useMemo(() => {
    const out: Order[] = [];
    for (const rec of lineages ?? []) {
      const o = flatten(rec);
      if (o) out.push(o);
    }
    return out;
  }, [lineages]);

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  useEffect(() => {
    lsSave(LINK_STORE, savedLinks);
  }, [savedLinks]);

  useEffect(() => {
    lsSave(FAUCET_STORE, known);
  }, [known]);

  const remember = useCallback((id: string, label?: string) => {
    const clean = id.trim();
    if (!clean) return;
    setKnown((prev) =>
      prev.some((k) => k.id === clean)
        ? prev
        : [...prev, { id: clean, label: label ?? short(clean) }].slice(-20),
    );
  }, []);

  // Everything the picker can offer: wallet holdings first, then anything
  // seen before, minus whatever is already selected on the other side.
  const wantOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: KnownFaucet[] = [];
    for (const a of assets) {
      if (a.faucetId === offerFaucet || seen.has(a.faucetId)) continue;
      seen.add(a.faucetId);
      out.push({ id: a.faucetId, label: labelFor(a.faucetId) });
    }
    for (const k of known) {
      if (k.id === offerFaucet || seen.has(k.id)) continue;
      seen.add(k.id);
      out.push(k);
    }
    return out;
  }, [assets, known, offerFaucet, labelFor]);

  // Account IDs arrive in two formats (hex 0x… and bech32 mtst1…), so they
  // can never be compared as plain strings — the SDK helper parses both.
  // usePswapLineagesFor already scopes results to this account; this is kept
  // for labelling an offer as yours when a record shows up unscoped.
  const isMine = useCallback(
    (id: string) => {
      if (!accountId || !id) return false;
      try {
        return accountIdsEqual(id, accountId);
      } catch {
        return false;
      }
    },
    [accountId],
  );

  // usePswapLineagesFor already scopes to this account, so the creator check
  // is only a safety net for anything the SDK hands back unscoped.
  const myOpenOffers = useMemo(
    () =>
      orders.filter(
        (o) => o.state === STATE_ACTIVE,
      ),
    [orders],
  );

  /** exportNote fails until the note has an inclusion proof, i.e. until it
   *  has landed in a block. Sync and retry rather than giving up. */
  const exportWhenReady = useCallback(
    async (noteId: string, attempts = 20): Promise<Uint8Array> => {
      let last: unknown;
      for (let i = 0; i < attempts; i++) {
        try {
          return await exportNote(noteId);
        } catch (e) {
          last = e;
          const msg = e instanceof Error ? e.message : String(e);
          // Anything other than "not in a block yet" will not fix itself.
          if (!/inclusion proof|not.*committed/i.test(msg)) throw e;
          try {
            await sync?.();
          } catch {
            /* best effort */
          }
          await sleep(3000);
        }
      }
      throw last instanceof Error
        ? last
        : new Error("The offer did not reach a block in time.");
    },
    [exportNote, sync],
  );

  // ── Build an offer ───────────────────────────────────────────────────────

  const handleCreateOffer = useCallback(async () => {
    setFormErr(null);
    setLink(null);
    setCopied(false);

    const offered = toBase(offerAmount);
    const requested = toBase(wantAmount);

    if (!offerFaucet.trim()) return setFormErr("Pick the asset you are giving.");
    if (!wantFaucet.trim()) return setFormErr("Enter the asset you want.");
    if (offered <= 0) return setFormErr("Enter how much you are giving.");
    if (requested <= 0) return setFormErr("Enter how much you want back.");
    if (offerFaucet.trim() === wantFaucet.trim())
      return setFormErr("The two assets must be different.");

    const held = assets.find((a) => a.faucetId === offerFaucet.trim());
    if (held && BigInt(held.amount) < BigInt(offered)) {
      return setFormErr(
        `You only hold ${fmt(BigInt(held.amount))} of that asset.`,
      );
    }

    setBuilding(true);
    const before = new Set(ordersRef.current.map((o) => o.orderId));

    try {
      setBuildStage("Signing the swap note…");
      await pswapCreate({
        accountId,
        offeredFaucetId: offerFaucet.trim(),
        offeredAmount: BigInt(offered),
        requestedFaucetId: wantFaucet.trim(),
        requestedAmount: BigInt(requested),
        // The order note is public so the network indexes it — a fully
        // private note is delivered, never listed, so neither side could
        // look it up afterwards. The payback note stays private: who filled
        // the offer and where the funds went is not visible.
        noteType: "public",
        paybackNoteType: "private",
      });

      setBuildStage("Waiting for the note to settle…");
      let fresh: Order | null = null;
      for (let i = 0; i < 30 && !fresh; i++) {
        try {
          await sync?.();
        } catch {
          /* sync is best-effort */
        }
        await refetch();
        await sleep(2000);
        fresh =
          ordersRef.current.find((o) => !before.has(o.orderId)) ?? null;
      }

      if (!fresh) {
        setFormErr(
          "Your offer was submitted, but the network is slow to confirm it. " +
            "It will appear under 'Your Open Offers' shortly — use 'Get link' there to share it.",
        );
        return;
      }

      setBuildStage("Waiting for the block that carries it…");
      const bytes = await exportWhenReady(fresh.tipNoteId);
      const encoded = b64urlEncode(bytes);
      const base = `${window.location.origin}${window.location.pathname}`;
      const url = `${base}#offer=${encoded}`;

      setLink(url);
      setSavedLinks((prev) => ({ ...prev, [fresh!.orderId]: url }));
      remember(wantFaucet.trim());
      remember(offerFaucet.trim(), labelFor(offerFaucet.trim()));
      setOfferAmount("");
      setWantAmount("");
    } catch (err) {
      setFormErr(explain(err));
    } finally {
      setBuilding(false);
      setBuildStage("");
    }
  }, [
    offerAmount,
    wantAmount,
    offerFaucet,
    wantFaucet,
    assets,
    accountId,
    pswapCreate,
    refetch,
    sync,
    exportWhenReady,
    explain,
    remember,
    labelFor,
  ]);

  // ── Open an incoming offer ───────────────────────────────────────────────

  useEffect(() => {
    if (!payload || !accountId) return;
    let cancelled = false;

    (async () => {
      setLoadingIncoming(true);
      setIncomingErr(null);
      try {
        const bytes = b64urlDecode(payload);
        const noteId = await importNote(bytes);

        let found: Order | null = null;
        for (let i = 0; i < 15 && !found; i++) {
          try {
            await sync?.();
          } catch {
            /* sync is best-effort */
          }
          await refetch();
          await sleep(1500);
          found =
            ordersRef.current.find((o) => o.tipNoteId === noteId) ?? null;
        }
        if (cancelled) return;

        if (!found) {
          setIncomingErr(
            "This offer could not be read. It may have already been filled or cancelled.",
          );
        } else {
          setIncoming(found);
          setFillAmount(fmt(found.remainingRequested));
        }
      } catch (err) {
        if (!cancelled) {
          setIncomingErr(explain(err));
        }
      } finally {
        if (!cancelled) setLoadingIncoming(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [payload, accountId, importNote, refetch, sync, explain]);

  const dismissIncoming = useCallback(() => {
    setPayload(null);
    setIncoming(null);
    setIncomingErr(null);
    setFillTx(null);
    history.replaceState(null, "", window.location.pathname);
  }, []);

  const handleFill = useCallback(async () => {
    if (!incoming) return;
    const amount = toBase(fillAmount);
    if (amount <= 0) return setIncomingErr("Enter an amount to send.");
    if (BigInt(amount) > incoming.remainingRequested) {
      return setIncomingErr("That is more than this offer is asking for.");
    }

    setIncomingErr(null);
    try {
      const res = await pswapConsume({
        accountId,
        note: incoming.tipNoteId,
        fillAmount: BigInt(amount),
      });
      setFillTx(res.transactionId);
      await refetch();
    } catch (err) {
      setIncomingErr(explain(err));
    }
  }, [incoming, fillAmount, accountId, pswapConsume, refetch, explain]);

  const [linking, setLinking] = useState<string | null>(null);

  const handleGetLink = useCallback(
    async (order: Order) => {
      setLinking(order.orderId);
      setFormErr(null);
      try {
        const bytes = await exportWhenReady(order.tipNoteId);
        const base = `${window.location.origin}${window.location.pathname}`;
        const url = `${base}#offer=${b64urlEncode(bytes)}`;
        setSavedLinks((prev) => ({ ...prev, [order.orderId]: url }));
        await copy(url);
      } catch (err) {
        setFormErr(explain(err));
      } finally {
        setLinking(null);
      }
    },
    [exportWhenReady, explain],
  );

  // ── Cancel one of my offers ──────────────────────────────────────────────

  const handleCancel = useCallback(
    async (order: Order) => {
      try {
        await pswapCancelByOrder({ orderId: order.orderId });
        setSavedLinks((prev) => {
          const next = { ...prev };
          delete next[order.orderId];
          return next;
        });
        await refetch();
      } catch (err) {
        setFormErr(explain(err));
      }
    },
    [pswapCancelByOrder, refetch, explain],
  );

  // ── Copy helper ──────────────────────────────────────────────────────────

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  }, []);

  const busy = building || creating || filling || cancelling;
  const linkTooLong = link !== null && link.length > MAX_URL_LEN;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      <style>{SWAP_CSS}</style>

      {/* ── Someone sent you an offer ── */}
      {payload && (
        <div className="card swap-incoming">
          <div className="swap-head">
            <h2>Someone sent you a swap</h2>
            <button className="ghost" onClick={dismissIncoming}>
              Dismiss
            </button>
          </div>

          {loadingIncoming && (
            <p className="hint">Opening the offer…</p>
          )}

          {incoming && !fillTx && (
            <>
              <div className="swap-terms">
                <div className="swap-leg">
                  <span className="swap-leg-label">You receive</span>
                  <span className="swap-leg-value">
                    {fmt(incoming.remainingOffered)}
                  </span>
                </div>
                <div className="swap-arrow">→</div>
                <div className="swap-leg">
                  <span className="swap-leg-label">You send</span>
                  <span className="swap-leg-value">
                    {fmt(incoming.remainingRequested)}
                  </span>
                </div>
              </div>

              <label className="swap-field">
                <span>Amount to send</span>
                <input
                  value={fillAmount}
                  onChange={(e) => setFillAmount(e.target.value)}
                  inputMode="decimal"
                  disabled={filling}
                />
              </label>
              <p className="hint">
                Sending less than the full amount is fine — you get a
                proportional share and the rest stays open for someone else.
              </p>

              <button
                className="primary"
                onClick={handleFill}
                disabled={filling || !accountId}
              >
                {filling ? "Settling…" : "Accept swap"}
              </button>
            </>
          )}

          {fillTx && (
            <div className="success-box">
              Swap settled ·{" "}
              <a
                href={`${EXPLORER_BASE_URL}/tx/${fillTx}`}
                target="_blank"
                rel="noreferrer"
                className="tx-link"
              >
                view transaction
              </a>
            </div>
          )}

          {incomingErr && <div className="error-box">{incomingErr}</div>}
        </div>
      )}

      {/* ── Create an offer ── */}
      <div className="card">
        <h2>Send a Swap Offer</h2>
        <p className="hint">
          Set your terms, get a link, send it to whoever you are trading with.
          They open the link and settle in one click — no order book, no
          waiting for a stranger. The payback leg stays private.
        </p>

        <div className="swap-form">
          <label className="swap-field">
            <span>You give</span>
            <div className="swap-row">
              <select
                value={offerFaucet}
                onChange={(e) => setOfferFaucet(e.target.value)}
                disabled={busy}
              >
                <option value="">select asset</option>
                {assets.map((a) => (
                  <option key={a.faucetId} value={a.faucetId}>
                    {labelFor(a.faucetId)} · {fmt(BigInt(a.amount))}
                  </option>
                ))}
              </select>
              <input
                value={offerAmount}
                onChange={(e) => setOfferAmount(e.target.value)}
                placeholder="0.0"
                inputMode="decimal"
                disabled={busy}
              />
            </div>
          </label>

          <label className="swap-field">
            <span>You want</span>
            <div className="swap-row">
              {wantOther ? (
                <input
                  value={wantFaucet}
                  onChange={(e) => setWantFaucet(e.target.value)}
                  placeholder="paste a token address"
                  disabled={busy}
                  autoFocus
                />
              ) : (
                <select
                  value={wantFaucet}
                  onChange={(e) => {
                    if (e.target.value === "__other__") {
                      setWantOther(true);
                      setWantFaucet("");
                    } else {
                      setWantFaucet(e.target.value);
                    }
                  }}
                  disabled={busy}
                >
                  <option value="">select token</option>
                  {wantOptions.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.label}
                    </option>
                  ))}
                  <option value="__other__">Another token…</option>
                </select>
              )}
              <input
                value={wantAmount}
                onChange={(e) => setWantAmount(e.target.value)}
                placeholder="0.0"
                inputMode="decimal"
                disabled={busy}
              />
            </div>
            {wantOther && (
              <button
                className="swap-link-back"
                onClick={() => {
                  setWantOther(false);
                  setWantFaucet("");
                }}
              >
                ← back to the list
              </button>
            )}
          </label>
        </div>

        <button
          className="primary"
          onClick={handleCreateOffer}
          disabled={busy || !accountId}
        >
          {building ? buildStage || "Working…" : "Create offer link"}
        </button>

        {building && (
          <p className="hint">
            The proof is generated in your browser, so this takes a minute.
            Keep the tab open.
          </p>
        )}

        {formErr && <div className="error-box">{formErr}</div>}

        {link && (
          <div className="swap-link-box">
            <div className="swap-link-label">
              {linkTooLong
                ? "This offer is too large for a link — copy the code and send it as a message."
                : "Your offer link is ready. Send it to your counterparty."}
            </div>
            <textarea readOnly value={link} rows={3} className="swap-link" />
            <button className="primary" onClick={() => copy(link)}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
        )}
      </div>

      {/* ── My open offers ── */}
      <div className="card">
        <div className="swap-head">
          <h2>Your Open Offers</h2>
          <button className="ghost" onClick={() => refetch()} disabled={loadingOrders}>
            {loadingOrders ? "…" : "Refresh"}
          </button>
        </div>

        {myOpenOffers.length === 0 && (
          <p className="hint">
            Nothing open right now. Offers you create show up here until they
            are filled or cancelled.
          </p>
        )}

        {myOpenOffers.map((o) => (
          <div className="swap-offer" key={o.orderId}>
            <div className="swap-offer-main">
              <span className="mono">{short(o.orderId)}</span>
              <span className="swap-offer-terms">
                giving {fmt(o.remainingOffered)} · asking{" "}
                {fmt(o.remainingRequested)}
              </span>
            </div>
            <div className="swap-offer-actions">
              {savedLinks[o.orderId] ? (
                <button
                  className="ghost"
                  onClick={() => copy(savedLinks[o.orderId])}
                >
                  {copied ? "Copied ✓" : "Copy link"}
                </button>
              ) : (
                <button
                  className="ghost"
                  onClick={() => handleGetLink(o)}
                  disabled={linking === o.orderId}
                >
                  {linking === o.orderId ? "Building…" : "Get link"}
                </button>
              )}
              <button
                className="ghost"
                onClick={() => handleCancel(o)}
                disabled={cancelling}
              >
                Cancel
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Diagnostics ── */}
      <div className="card swap-dev">
        <button
          className="swap-dev-toggle"
          onClick={() => setDiagOpen((v) => !v)}
        >
          {diagOpen ? "▾" : "▸"} Diagnostics
        </button>

        {diagOpen && (
          <div className="swap-diag">
            <div>
              <b>wallet</b>: <span className="mono">{accountId || "(not connected)"}</span>
            </div>
            <div>
              <b>lineage records</b>: {orders.length}
              {loadingOrders ? " (loading…)" : ""}
            </div>
            {orders.length === 0 && (
              <div className="hint">
                Nothing came back from the network for this account.
              </div>
            )}
            {orders.map((o) => (
              <div key={o.orderId} className="swap-diag-row">
                <span className="mono">{short(o.orderId)}</span>
                {" · state "}{o.state}
                {" · mine "}{isMine(o.creator) ? "yes" : "no"}
                {" · creator "}<span className="mono">{short(o.creator)}</span>
                {" · offering "}{fmt(o.remainingOffered)}
                {" · asking "}{fmt(o.remainingRequested)}
              </div>
            ))}
            {rawErr && (
              <>
                <div><b>last raw error</b></div>
                <pre className="swap-diag-raw">{rawErr}</pre>
              </>
            )}
            <button className="ghost" onClick={() => refetch()}>
              Re-read from network
            </button>
          </div>
        )}
      </div>

    </>
  );
}

// ─── Scoped styles ─────────────────────────────────────────────────────────

const SWAP_CSS = `
.swap-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
.swap-head h2 { margin:0; }
.swap-incoming { border:1px solid rgba(249,115,22,.5); }
.swap-terms { display:flex; align-items:center; gap:1rem; margin:1rem 0; flex-wrap:wrap; }
.swap-leg { display:flex; flex-direction:column; gap:.25rem; flex:1 1 40%; }
.swap-leg-label { font-size:.75rem; opacity:.6; text-transform:uppercase; letter-spacing:.05em; }
.swap-leg-value { font-size:1.4rem; font-weight:600; }
.swap-arrow { font-size:1.4rem; opacity:.5; }
.swap-form { display:flex; flex-direction:column; gap:1rem; margin:1rem 0; }
.swap-field { display:flex; flex-direction:column; gap:.4rem; }
.swap-field > span { font-size:.8rem; opacity:.7; }
.swap-row { display:flex; gap:.5rem; flex-wrap:wrap; }
.swap-row > select, .swap-row > input { flex:1 1 8rem; min-width:0; }
.swap-link-box { margin-top:1rem; display:flex; flex-direction:column; gap:.5rem; }
.swap-link-label { font-size:.85rem; opacity:.8; }
.swap-link { width:100%; font-family:ui-monospace,monospace; font-size:.7rem;
  word-break:break-all; resize:vertical; }
.swap-offer { display:flex; align-items:center; justify-content:space-between;
  gap:1rem; padding:.75rem 0; border-top:1px solid rgba(255,255,255,.08);
  flex-wrap:wrap; }
.swap-offer-main { display:flex; flex-direction:column; gap:.25rem; }
.swap-offer-terms { font-size:.85rem; opacity:.7; }
.swap-offer-actions { display:flex; gap:.5rem; }
.swap-link-back { background:none; border:none; color:inherit; cursor:pointer;
  font-size:.75rem; opacity:.6; padding:.25rem 0; text-align:left; }
.swap-link-back:hover { opacity:1; }
.swap-diag { display:flex; flex-direction:column; gap:.4rem; margin-top:.75rem;
  font-size:.8rem; }
.swap-diag-row { opacity:.8; word-break:break-all; }
.swap-diag-raw { white-space:pre-wrap; word-break:break-all; font-size:.7rem;
  max-height:14rem; overflow:auto; opacity:.75; margin:0; }
.swap-dev { opacity:.85; }
.swap-dev-toggle { background:none; border:none; color:inherit; cursor:pointer;
  font-size:.9rem; padding:0; opacity:.75; }
.swap-dev-toggle:hover { opacity:1; }
`;
