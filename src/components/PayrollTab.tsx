import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useSend, useSyncState } from "@miden-sdk/react";
import type { Asset } from "@miden-sdk/miden-wallet-adapter-base";
import { EXPLORER_BASE_URL } from "@/config";

// ─── Constants ─────────────────────────────────────────────────────────────

const DECIMALS = 6;
const FACTOR = 10 ** DECIMALS;
const BLOCK_SECONDS = 5;
const STORE = "miden_payroll_v1";

const INTERVALS = [
  { label: "Weekly", seconds: 604800 },
  { label: "Monthly", seconds: 2592000 },
  { label: "Daily", seconds: 86400 },
] as const;

// ─── Helpers ───────────────────────────────────────────────────────────────

function fmt(raw: bigint | number): string {
  return (Number(raw) / FACTOR).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  });
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

function whenReadable(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "unlocked";
  const days = Math.floor(diff / 86400000);
  if (days >= 1) return `in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.max(1, Math.round(diff / 3600000));
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}

const ERROR_HINTS: [RegExp, string][] = [
  [/insufficient|not enough|exceeds balance/i, "You do not have enough of that asset to fund every period."],
  [/rejected|denied|cancell?ed by user|user rejected/i, "You cancelled the request in your wallet."],
  [/not connected|no wallet|wallet not found/i, "Your wallet is not connected."],
  [/timeout|timed out|deadline/i, "The network took too long to answer."],
  [/network|fetch|rpc|connection|offline/i, "Cannot reach the Miden network right now."],
  [/invalid.*(address|account id)|malformed/i, "That recipient address does not look right."],
];

function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  for (const [re, msg] of ERROR_HINTS) if (re.test(raw)) return msg;
  return "Something went wrong. Please try again.";
}

// ─── Stored shape ──────────────────────────────────────────────────────────

type Period = {
  index: number;
  txId: string;
  unlocksAt: number; // ms epoch, for display only
};

type Plan = {
  id: string;
  recipient: string;
  faucetId: string;
  perPeriod: string;
  intervalSeconds: number;
  intervalLabel: string;
  periods: Period[];
  createdAt: number;
};

// ─── Component ─────────────────────────────────────────────────────────────

export function PayrollTab({
  accountId,
  assets,
  labelFor,
}: {
  accountId: string;
  assets: Asset[];
  labelFor: (faucetId: string) => string;
}) {
  const [recipient, setRecipient] = useState("");
  const [faucetId, setFaucetId] = useState("");
  const [perPeriod, setPerPeriod] = useState("");
  const [interval, setInterval] = useState<(typeof INTERVALS)[number]>(
    INTERVALS[1],
  );
  const [count, setCount] = useState("3");

  const [err, setErr] = useState<string | null>(null);
  const [rawErr, setRawErr] = useState<string | null>(null);
  const [stage, setStage] = useState("");
  const [running, setRunning] = useState(false);

  const [plans, setPlans] = useState<Plan[]>(() => lsLoad(STORE, [] as Plan[]));

  const { send } = useSend();
  const { syncHeight, sync } = useSyncState();

  const heightRef = useRef<number>(0);
  useEffect(() => {
    if (typeof syncHeight === "number" && syncHeight > 0) {
      heightRef.current = syncHeight;
    }
  }, [syncHeight]);

  useEffect(() => {
    if (assets.length > 0 && !faucetId) setFaucetId(assets[0].faucetId);
  }, [assets, faucetId]);

  useEffect(() => {
    lsSave(STORE, plans);
  }, [plans]);

  const periodCount = Math.max(1, Math.min(24, Number(count) || 0));
  const totalBase = toBase(perPeriod) * periodCount;

  const held = useMemo(
    () => assets.find((a) => a.faucetId === faucetId),
    [assets, faucetId],
  );

  const enough = held ? BigInt(held.amount) >= BigInt(totalBase || 0) : false;

  // ── Set up a plan ────────────────────────────────────────────────────────

  const handleCreate = useCallback(async () => {
    setErr(null);

    const per = toBase(perPeriod);
    if (!recipient.trim()) return setErr("Enter who gets paid.");
    if (!faucetId) return setErr("Pick which token to pay in.");
    if (per <= 0) return setErr("Enter the amount for one period.");
    if (!held || BigInt(held.amount) < BigInt(per * periodCount)) {
      return setErr(
        `Funding ${periodCount} periods needs ${fmt(per * periodCount)} — you hold ${held ? fmt(BigInt(held.amount)) : "0"}.`,
      );
    }

    setRunning(true);
    try {
      setStage("Reading the current block…");
      try {
        await sync?.();
      } catch {
        /* best effort; the ref may already hold a usable height */
      }
      await new Promise((r) => setTimeout(r, 800));

      const startHeight = heightRef.current || syncHeight || 0;
      if (!startHeight) {
        setErr(
          "Could not read the current block height from the network. " +
            "Wait for the wallet to finish syncing, then try again.",
        );
        return;
      }

      const blocksPerPeriod = Math.floor(interval.seconds / BLOCK_SECONDS);
      const created: Period[] = [];

      for (let i = 0; i < periodCount; i++) {
        setStage(`Signing period ${i + 1} of ${periodCount}…`);

        // Period 1 is payable immediately; each later one unlocks a full
        // interval after the previous. recallHeight matches the unlock, so
        // anything the recipient has not taken can be pulled back on cancel.
        const offset = blocksPerPeriod * i;
        const unlockHeight = startHeight + offset;
        // The recipient gets first claim; the sender can only pull back a
        // period that was left untouched for a full interval after unlocking.
        const reclaimHeight = unlockHeight + blocksPerPeriod;

        const res = await send({
          from: accountId,
          to: recipient.trim(),
          assetId: faucetId,
          amount: BigInt(per),
          noteType: "private",
          ...(i > 0 ? { timelockHeight: unlockHeight } : {}),
          recallHeight: reclaimHeight,
        });

        created.push({
          index: i + 1,
          txId: res.txId,
          unlocksAt: Date.now() + interval.seconds * 1000 * i,
        });
      }

      const plan: Plan = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        recipient: recipient.trim(),
        faucetId,
        perPeriod,
        intervalSeconds: interval.seconds,
        intervalLabel: interval.label,
        periods: created,
        createdAt: Date.now(),
      };

      setPlans((prev) => [plan, ...prev]);
      setPerPeriod("");
      setRecipient("");
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[payroll]", e);
      setRawErr(
        e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ""}` : String(e),
      );
      setErr(humanError(e));
    } finally {
      setRunning(false);
      setStage("");
    }
  }, [
    recipient,
    faucetId,
    perPeriod,
    periodCount,
    interval,
    held,
    accountId,
    send,
    sync,
    syncHeight,
  ]);

  const forget = useCallback((id: string) => {
    setPlans((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return (
    <>
      <style>{PAYROLL_CSS}</style>

      <div className="card">
        <h2>Set Up Recurring Pay</h2>
        <p className="hint">
          Fund a run of payments in one sitting. Each period unlocks on its own
          date and lands in the recipient's wallet without you signing again.
          Every note is private, so amounts are not visible on the explorer.
        </p>

        <label className="pay-field">
          <span>Pay to</span>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="mtst1… recipient address"
            disabled={running}
          />
        </label>

        <div className="pay-grid">
          <label className="pay-field">
            <span>Token</span>
            <select
              value={faucetId}
              onChange={(e) => setFaucetId(e.target.value)}
              disabled={running}
            >
              {assets.map((a) => (
                <option key={a.faucetId} value={a.faucetId}>
                  {labelFor(a.faucetId)} · {fmt(BigInt(a.amount))}
                </option>
              ))}
            </select>
          </label>

          <label className="pay-field">
            <span>Each period</span>
            <input
              value={perPeriod}
              onChange={(e) => setPerPeriod(e.target.value)}
              placeholder="0.0"
              inputMode="decimal"
              disabled={running}
            />
          </label>
        </div>

        <div className="pay-grid">
          <label className="pay-field">
            <span>How often</span>
            <select
              value={interval.label}
              onChange={(e) =>
                setInterval(
                  INTERVALS.find((i) => i.label === e.target.value) ??
                    INTERVALS[1],
                )
              }
              disabled={running}
            >
              {INTERVALS.map((i) => (
                <option key={i.label} value={i.label}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>

          <label className="pay-field">
            <span>How many periods to fund</span>
            <input
              value={count}
              onChange={(e) => setCount(e.target.value)}
              inputMode="numeric"
              disabled={running}
            />
          </label>
        </div>

        {totalBase > 0 && (
          <div className={`pay-total ${enough ? "" : "pay-total-short"}`}>
            Leaves your wallet now: <b>{fmt(totalBase)}</b>{" "}
            {held ? labelFor(held.faucetId) : ""}
            <span className="pay-total-note">
              {" "}
              · covers {periodCount} {interval.label.toLowerCase()} period
              {periodCount === 1 ? "" : "s"}
            </span>
          </div>
        )}

        <button
          className="primary"
          onClick={handleCreate}
          disabled={running || !accountId || assets.length === 0}
        >
          {running ? stage || "Working…" : "Fund the schedule"}
        </button>

        {running && (
          <p className="hint">
            One proof is generated per period, in your browser. Funding three
            periods takes about three times as long as a single payment — keep
            the tab open.
          </p>
        )}

        {err && <div className="error-box">{err}</div>}

        {rawErr && (
          <details className="pay-raw">
            <summary>Technical details</summary>
            <pre>{rawErr}</pre>
          </details>
        )}

        <div className="pay-height">
          block height: {heightRef.current || syncHeight || "reading…"}
        </div>
      </div>

      <div className="card">
        <h2>Scheduled Payments</h2>

        {plans.length === 0 && (
          <p className="hint">
            Nothing scheduled yet. Anything you fund shows up here with its
            unlock dates.
          </p>
        )}

        {plans.map((p) => (
          <div className="pay-plan" key={p.id}>
            <div className="pay-plan-head">
              <div>
                <b>{fmt(toBase(p.perPeriod))}</b>{" "}
                {labelFor(p.faucetId)} · {p.intervalLabel.toLowerCase()}
                <div className="pay-plan-to">
                  to <span className="mono">{short(p.recipient)}</span>
                </div>
              </div>
              <button className="ghost" onClick={() => forget(p.id)}>
                Remove
              </button>
            </div>

            <div className="pay-periods">
              {p.periods.map((per) => (
                <div className="pay-period" key={per.txId}>
                  <span className="pay-period-n">#{per.index}</span>
                  <span className="pay-period-when">
                    {whenReadable(per.unlocksAt)}
                  </span>
                  <a
                    href={`${EXPLORER_BASE_URL}/tx/${per.txId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="tx-link"
                  >
                    tx
                  </a>
                </div>
              ))}
            </div>

            <p className="hint">
              To stop this schedule, reclaim the periods that have not been
              taken yet from the Vault tab. Anything already unlocked and
              collected stays with the recipient.
            </p>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Scoped styles ─────────────────────────────────────────────────────────

const PAYROLL_CSS = `
.pay-field { display:flex; flex-direction:column; gap:.4rem; margin-top:1rem; }
.pay-field > span { font-size:.8rem; opacity:.7; }
.pay-grid { display:flex; gap:.75rem; flex-wrap:wrap; }
.pay-grid > .pay-field { flex:1 1 10rem; min-width:0; }
.pay-total { margin:1rem 0; padding:.6rem .8rem; border-radius:.5rem;
  background:rgba(255,255,255,.05); font-size:.9rem; }
.pay-total-short { background:rgba(239,68,68,.12); }
.pay-total-note { opacity:.65; }
.pay-plan { border-top:1px solid rgba(255,255,255,.08); padding-top:.9rem;
  margin-top:.9rem; }
.pay-plan-head { display:flex; justify-content:space-between; gap:1rem;
  align-items:flex-start; flex-wrap:wrap; }
.pay-plan-to { font-size:.8rem; opacity:.7; margin-top:.2rem; }
.pay-periods { display:flex; flex-wrap:wrap; gap:.5rem; margin:.75rem 0; }
.pay-period { display:flex; align-items:center; gap:.4rem; font-size:.78rem;
  padding:.3rem .55rem; border-radius:.4rem; background:rgba(255,255,255,.05); }
.pay-period-n { opacity:.55; }
.pay-period-when { opacity:.85; }
.pay-raw { margin-top:.6rem; font-size:.75rem; opacity:.75; }
.pay-raw pre { white-space:pre-wrap; word-break:break-all; max-height:12rem;
  overflow:auto; margin:.4rem 0 0; }
.pay-height { margin-top:.6rem; font-size:.72rem; opacity:.45; }
`;
