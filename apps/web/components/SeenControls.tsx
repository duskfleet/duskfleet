"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { markSeenAction, undoSeenAction, unseeAction } from "@/app/attention/actions";

/**
 * DS-32 (issue #430) client controls of /attention: the per-item seen toggle, the bulk "Mark ... seen"
 * buttons, the Seen group disclosure and the toast with Undo. Every write is a server action of
 * app/attention/actions.ts; the page re-renders from the database afterwards (router.refresh).
 * Nothing here imports lib/attention's values: that module pulls in core, which stays server-side.
 */

/** The toast after a mark: "Marked seen: <item>" for one row, "Marked n seen" for a bulk action. */
export function markedText(marked: number, label?: string): string {
  if (label && marked === 1) return `Marked seen: ${label}`;
  return `Marked ${marked} seen`;
}

/** How long the toast stays (about 8 s). */
export const TOAST_MS = 8000;
const TOAST_EVENT = "duskfleet:seen-toast";

interface ToastDetail {
  text: string;
  /** The keys the mark inserted: what Undo deletes. */
  undo: string[];
}

function toast(detail: ToastDetail) {
  window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail }));
}

/** The check of the seen controls (stroke in currentColor). */
export function CheckIcon() {
  return (
    <svg className="att-check" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3 8.5l3.2 3.2L13 4.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One item's toggle: marks it seen (toast with Undo), or, pressed in the Seen group, un-sees it in place. */
export function SeenToggle({ itemKey, label, pressed }: { itemKey: string; label: string; pressed: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const onClick = () =>
    start(async () => {
      if (pressed) {
        await unseeAction(itemKey);
      } else {
        const r = await markSeenAction([itemKey]);
        if (r.ok && r.inserted.length) toast({ text: markedText(r.inserted.length, label), undo: r.inserted });
      }
      router.refresh();
    });
  return <SeenToggleView label={label} pressed={pressed} pending={pending} onClick={onClick} />;
}

export function SeenToggleView({
  label,
  pressed,
  pending,
  onClick,
}: {
  label: string;
  pressed: boolean;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="att-seen"
      aria-pressed={pressed}
      aria-label={`${pressed ? "Mark unseen" : "Mark seen"}: ${label}`}
      disabled={pending}
      onClick={onClick}
    >
      <CheckIcon />
    </button>
  );
}

/** "Mark all seen" / "Mark section seen" ("Mark seen" at 390): every dismissable unseen item shown. */
export function MarkSeenButton({ keys, label, short }: { keys: string[]; label: string; short?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const onClick = () =>
    start(async () => {
      const r = await markSeenAction(keys);
      if (r.ok && r.inserted.length) toast({ text: markedText(r.inserted.length), undo: r.inserted });
      router.refresh();
    });
  return <MarkSeenButtonView label={label} short={short} pending={pending} onClick={onClick} />;
}

export function MarkSeenButtonView({
  label,
  short,
  pending,
  onClick,
}: {
  label: string;
  short?: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="att-mark" disabled={pending} onClick={onClick}>
      <CheckIcon />
      {short ? (
        <>
          <span className="att-wide">{label}</span>
          <span className="att-short">{short}</span>
        </>
      ) : (
        label
      )}
    </button>
  );
}

/** The toast host of the page: one toast at a time, `role=status`, Undo deletes what the mark inserted. */
export function SeenToast() {
  const router = useRouter();
  const [current, setCurrent] = useState<ToastDetail | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    const on = (e: Event) => setCurrent((e as CustomEvent<ToastDetail>).detail);
    window.addEventListener(TOAST_EVENT, on);
    return () => window.removeEventListener(TOAST_EVENT, on);
  }, []);
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => setCurrent(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [current]);
  const undo = () =>
    start(async () => {
      if (current) await undoSeenAction(current.undo);
      setCurrent(null);
      router.refresh();
    });
  return <SeenToastView text={current?.text ?? null} pending={pending} onUndo={undo} />;
}

export function SeenToastView({
  text,
  pending,
  onUndo,
}: {
  text: string | null;
  pending: boolean;
  onUndo: () => void;
}) {
  // The live region stays in the page so the status is announced when the text arrives.
  return (
    <div className="att-toast-host" role="status">
      {text && (
        <div className="att-toast">
          <CheckIcon />
          <span className="att-toast-text">{text}</span>
          <button type="button" className="att-undo" disabled={pending} onClick={onUndo}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The Seen group: a disclosure (`aria-expanded`). Open while unseen items remain; collapsed into one
 * full-width row with "Show" when every item is seen.
 */
export function SeenGroup({
  count,
  defaultOpen,
  children,
}: {
  count: number;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <SeenGroupView count={count} open={open} onToggle={() => setOpen(!open)}>
      {children}
    </SeenGroupView>
  );
}

export const SEEN_NOTE = "Read and set aside. Each one comes back up when something new happens.";

export function SeenGroupView({
  count,
  open,
  onToggle,
  children,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className={`att-section att-seen-group${open ? " open" : ""}`} aria-labelledby="att-seen">
      <h2 id="att-seen" className="att-h2 att-seen-head">
        <button
          type="button"
          className="att-disclosure"
          aria-expanded={open}
          aria-controls="att-seen-body"
          onClick={onToggle}
        >
          <svg className="att-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path
              d="M6 3.5L10.5 8 6 12.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Seen <span className="count">{count}</span>
          <span className="att-head-note">{SEEN_NOTE}</span>
          {!open && <span className="att-show">Show</span>}
        </button>
      </h2>
      <div id="att-seen-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
