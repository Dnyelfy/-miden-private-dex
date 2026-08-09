import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  usePswapCreate,
  usePswapConsume,
  usePswapCancelByOrder,
  usePswapLineages,
  type PswapLineageRecord,
} from "@miden-sdk/react";
import { EXPLORER_BASE_URL } from "@/config";

// ─── Constants & helpers ───────────────────────────────────────────────────

const DECIMALS = 6;
const FACTOR = 10 ** DECIMALS;

// PswapLineageState: 0 = Active, 1 = FullyFilled, 2 = Reclaimed
const STATE_ACTIVE = 0;

const SOLVER_KEY = "miden_dex_solver_v1";
const SOLVER_LOG_KEY = "miden_dex_solver_log_v1";
const POLL_MS = 8000;

function fmt(raw: bigint | number): string {
  const n = Number(raw) / FACTOR;
  if (n === 0) return "0";
  if (n < 0.000001) return n.toExponential(2);
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
    return raw ? (JSON.parse(raw) ?? fallback) : fallback;
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

type LogEntry = {
  at: number;
  orderId: string;
  filled: string;
  txId: string | null;
  error?: string;
};

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

// ─── Component ─────────────────────────────────────────────────────────────

export function SwapTab({ accountId }: { accountId: string }) {
  // Order form
  const [offerFaucet, setOfferFaucet] = useState("");
  const [offerAmount, setOfferAmount] = useState("");
  const [wantFaucet, setWantFaucet] = useState("");
  const [wantAmount, setWantAmount] = useState("");
  const [publicOrder, setPublicOrder] = useState(true);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [formOk, setFormOk] = useState<string | null>(null);

  // Manual fill inputs, keyed by order id
  const [fillInputs, setFillInputs] = useState<Record<string, string>>({});

  // Solver
  const saved = useMemo(() => lsLoad(SOLVER_KEY, { on: false, maxFill: "" }), []);
  const [solverOn, setSolverOn] = useState<boolean>(saved.on);
  const [maxFill, setMaxFill] = useState<string>(saved.maxFill);
  const [log, setLog] = useState<LogEntry[]>(() =>
    lsLoad(SOLVER_LOG_KEY, [] as LogEntry[]),
  );
  const busyRef = useRef(false);
  const triedRef = useRef<Set<string>>(new Set());

  const { pswapCreate, isLoading: creating, stage: createStage } = usePswapCreate();
  const { pswapConsume, isLoading: filling } = usePswapConsume();
  const { pswapCancelByOrder, isLoading: cancelling } = usePswapCancelByOrder();
  const { lineages, isLoading: loadingOrders, refetch } = usePswapLineages();

  useEffect(() => {
    lsSave(SOLVER_KEY, { on: solverOn, maxFill });
  }, [solverOn, maxFill]);

  useEffect(() => {
    lsSave(SOLVER_LOG_KEY, log.slice(0, 50));
  }, [log]);

  const me = (accountId ?? "").toLowerCase();

  const orders = useMemo(
    () => (lineages ?? []).map(flatten).filter((o): o is Order => o !== null),
    [lineages],
  );

  const mine = useMemo(
    () => orders.filter((o) => o.creator.toLowerCase() === me),
    [orders, me],
  );

  const fillable = useMemo(
    () =>
      orders.filter(
        (o) =>
          o.state === STATE_ACTIVE &&
          o.remainingRequested > 0n &&
          o.creator.toLowerCase() !== me,
      ),
    [orders, me],
  );

  const pushLog = useCallback((e: LogEntry) => {
    setLog((prev) => [e, ...prev].slice(0, 50));
  }, []);

  // ── Create order ─────────────────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    setFormErr(null);
    setFormOk(null);

    const offered = toBase(offerAmount);
    const requested = toBase(wantAmount);

    if (!offerFaucet.trim() || !wantFaucet.trim()) {
      setFormErr("Both faucet IDs are required.");
      return;
    }
    if (offered <= 0 || requested <= 0) {
      setFormErr("Amounts must be greater than zero.");
      return;
    }

    try {
      const res = await pswapCreate({
        accountId,
        offeredFaucetId: offerFaucet.trim(),
        offeredAmount: BigInt(offered),
        requestedFaucetId: wantFaucet.trim(),
        requestedAmount: BigInt(requested),
        // Public so other clients can discover and fill it.
        noteType: publicOrder ? "public" : "private",
        // Payback stays private: who filled it and where it went is hidden.
        paybackNoteType: "private",
      });
      setFormOk(`Order created · ${short(res.transactionId)}`);
      setOfferAmount("");
      setWantAmount("");
      await refetch();
    } catch (err) {
      setFormErr(err instanceof Error ? err.message : String(err));
    }
  }, [
    accountId,
    offerFaucet,
    offerAmount,
    wantFaucet,
    wantAmount,
    publicOrder,
    pswapCreate,
    refetch,
  ]);

  // ── Fill (manual and solver share this) ──────────────────────────────────

  const fillOrder = useCallback(
    async (order: Order, amount: bigint) => {
      const res = await pswapConsume({
        accountId,
        note: order.tipNoteId,
        fillAmount: amount,
      });
      pushLog({
        at: Date.now(),
        orderId: order.orderId,
        filled: fmt(amount),
        txId: res.transactionId,
      });
      await refetch();
      return res;
    },
    [accountId, pswapConsume, pushLog, refetch],
  );

  const handleManualFill = useCallback(
    async (order: Order) => {
      const amt = toBase(fillInputs[order.orderId] ?? "");
      if (amt <= 0) return;
      const capped =
        BigInt(amt) > order.remainingRequested
          ? order.remainingRequested
          : BigInt(amt);
      try {
        await fillOrder(order, capped);
        setFillInputs((p) => ({ ...p, [order.orderId]: "" }));
      } catch (err) {
        pushLog({
          at: Date.now(),
          orderId: order.orderId,
          filled: "0",
          txId: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [fillInputs, fillOrder, pushLog],
  );

  const handleCancel = useCallback(
    async (order: Order) => {
      try {
        await pswapCancelByOrder({ orderId: order.orderId });
        await refetch();
      } catch (err) {
        pushLog({
          at: Date.now(),
          orderId: order.orderId,
          filled: "0",
          txId: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [accountId, pswapCancelByOrder, refetch, pushLog],
  );

  // ── Solver loop ──────────────────────────────────────────────────────────

  useEffect(() => {
    if (!solverOn || !accountId) return;

    const tick = async () => {
      if (busyRef.current) return;
      const cap = toBase(maxFill);
      if (cap <= 0) return;

      const target = fillable.find((o) => !triedRef.current.has(o.tipNoteId));
      if (!target) return;

      busyRef.current = true;
      triedRef.current.add(target.tipNoteId);
      try {
        const amount =
          BigInt(cap) > target.remainingRequested
            ? target.remainingRequested
            : BigInt(cap);
        await fillOrder(target, amount);
      } catch (err) {
        pushLog({
          at: Date.now(),
          orderId: target.orderId,
          filled: "0",
          txId: null,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        busyRef.current = false;
      }
    };

    const id = setInterval(tick, POLL_MS);
    void tick();
    return () => clearInterval(id);
  }, [solverOn, accountId, maxFill, fillable, fillOrder, pushLog]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Create order ── */}
      <div className="card">
        <h2>Create Private Order</h2>
        <p className="hint">
          The order note is public so anyone can discover it. The payback note is
          always private — who filled it and where the funds went stays hidden.
        </p>

        <div className="swap-grid">
          <div className="swap-side">
            <span className="swap-side-label">You offer</span>
            <input
              value={offerFaucet}
              onChange={(e) => setOfferFaucet(e.target.value)}
              placeholder="faucet id"
            />
            <input
              value={offerAmount}
              onChange={(e) => setOfferAmount(e.target.value)}
              placeholder="0.0"
              inputMode="decimal"
            />
          </div>

          <div className="swap-arrow">→</div>

          <div className="swap-side">
            <span className="swap-side-label">You want</span>
            <input
              value={wantFaucet}
              onChange={(e) => setWantFaucet(e.target.value)}
              placeholder="faucet id"
            />
            <input
              value={wantAmount}
              onChange={(e) => setWantAmount(e.target.value)}
              placeholder="0.0"
              inputMode="decimal"
            />
          </div>
        </div>

        <label className="toggle swap-toggle">
          <input
            type="checkbox"
            checked={publicOrder}
            onChange={(e) => setPublicOrder(e.target.checked)}
          />
          Discoverable order (uncheck to keep the order note private too)
        </label>

        <button
          className="primary swap-submit"
          onClick={handleCreate}
          disabled={creating || !accountId}
        >
          {creating ? createStage : "Create Order"}
        </button>

        {formErr && <div className="error-box">{formErr}</div>}
        {formOk && <div className="success-box">{formOk}</div>}
      </div>

      {/* ── Blind Solver ── */}
      <div className="card">
        <div className="card-head">
          <h2>Blind Solver</h2>
          <span className={solverOn ? "badge badge-completed" : "badge"}>
            {solverOn ? "running" : "stopped"}
          </span>
        </div>

        <p className="hint">
          An agent that fills orders without ever seeing the counterparty or the
          payback. It reads only what the order note makes public, then fills up
          to your limit.
        </p>

        <div className="solver-controls">
          <input
            value={maxFill}
            onChange={(e) => setMaxFill(e.target.value)}
            placeholder="max fill per order"
            inputMode="decimal"
          />
          <button
            className={solverOn ? "ghost" : "primary"}
            onClick={() => setSolverOn((v) => !v)}
            disabled={!accountId || toBase(maxFill) <= 0}
          >
            {solverOn ? "Stop" : "Start"}
          </button>
        </div>

        <p className="hint">
          {fillable.length} fillable · checks every {POLL_MS / 1000}s ·{" "}
          {filling ? "filling…" : "idle"}
        </p>

        {log.length > 0 && (
          <div className="solver-log">
            {log.map((e, i) => (
              <div
                key={`${e.at}-${i}`}
                className={e.error ? "solver-log-row err" : "solver-log-row"}
              >
                <span className="mono">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="mono">#{short(e.orderId, 6, 4)}</span>
                {e.error ? (
                  <span className="tiny">{e.error}</span>
                ) : (
                  <>
                    <span className="amount">filled {e.filled}</span>
                    {e.txId && (
                      <a
                        className="tx-link"
                        href={`${EXPLORER_BASE_URL}/tx/${e.txId}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        tx ↗
                      </a>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Open orders ── */}
      <div className="card">
        <div className="card-head">
          <h2>Open Orders</h2>
          <button
            className="ghost"
            onClick={() => refetch()}
            disabled={loadingOrders}
          >
            {loadingOrders ? "…" : "↻"}
          </button>
        </div>

        {fillable.length === 0 && (
          <p className="empty">
            {loadingOrders ? "Syncing…" : "No orders to fill yet."}
          </p>
        )}

        {fillable.map((o) => (
          <div className="swap-row" key={o.orderId}>
            <div className="swap-row-top">
              <span className="amount">{fmt(o.remainingOffered)} offered</span>
              <span className="badge">round {o.depth}</span>
            </div>
            <div className="swap-row-body">
              wants {fmt(o.remainingRequested)} in return
            </div>
            <div className="swap-row-meta mono">
              #{short(o.orderId, 6, 4)} · by {short(o.creator)}
            </div>
            <div className="swap-actions">
              <input
                value={fillInputs[o.orderId] ?? ""}
                onChange={(e) =>
                  setFillInputs((p) => ({ ...p, [o.orderId]: e.target.value }))
                }
                placeholder="fill amount"
                inputMode="decimal"
              />
              <button
                className="primary"
                onClick={() => handleManualFill(o)}
                disabled={filling}
              >
                Fill
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* ── My orders ── */}
      <div className="card">
        <h2>My Orders</h2>

        {mine.length === 0 && <p className="empty">You have no orders yet.</p>}

        {mine.map((o) => (
          <div
            className={
              o.state === STATE_ACTIVE ? "swap-row" : "swap-row status-completed"
            }
            key={o.orderId}
          >
            <div className="swap-row-top">
              <span className="amount">{fmt(o.remainingOffered)} left</span>
              <span
                className={
                  o.state === STATE_ACTIVE ? "badge" : "badge badge-completed"
                }
              >
                {o.state === STATE_ACTIVE ? "active" : "closed"}
              </span>
            </div>
            <div className="swap-row-body">
              still wants {fmt(o.remainingRequested)}
            </div>
            <div className="swap-row-meta mono">
              #{short(o.orderId, 6, 4)} · round {o.depth}
            </div>
            {o.state === STATE_ACTIVE && (
              <div className="swap-actions">
                <button
                  className="ghost"
                  onClick={() => handleCancel(o)}
                  disabled={cancelling}
                >
                  Cancel &amp; reclaim
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
