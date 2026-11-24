"use client";

import { useState } from "react";
import type { RemovalImpactDTO } from "@/lib/api-types";
import type { ArticleChoice } from "@/lib/filters";
import { plural } from "@/lib/format";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";

/** The first few articles a run would remove, and how many more. */
export function RemovalList({ impact }: { impact: RemovalImpactDTO }) {
  const more = impact.removals - impact.sample.length;
  return (
    <ul aria-label="Articles that would be removed" className="space-y-1 rounded-xl bg-nimbus px-4 py-3 text-[13px]">
      {impact.sample.map((article) => (
        <li key={article.number} className="truncate">
          <span className="font-medium text-navy">{article.number}</span> {article.title}
        </li>
      ))}
      {more > 0 ? <li className="text-navy/55">and {plural(more, "more article")}</li> : null}
    </ul>
  );
}

const INTRO = {
  settings: "These articles are in Genesys Cloud now, but the new settings leave them out, so the next run removes them:",
  run: "These articles are in Genesys Cloud now, but they no longer match this sync's settings, or they're no longer published in ServiceNow. This run removes them:",
};

const KEEP = {
  settings: "To keep them, include them in the settings too. A sync keeps only the articles its settings match.",
  run: "To keep them, cancel and add them back in the sync's settings first.",
};

/**
 * Confirms a change that removes articles from Genesys Cloud. With `onKeep`, it also offers
 * to choose the removed articles again, for the ones that can still be synced.
 */
export function RemovalDialog({
  impact,
  reason,
  confirmLabel,
  onConfirm,
  onKeep,
  onClose,
}: {
  impact: RemovalImpactDTO | null;
  reason: keyof typeof INTRO;
  confirmLabel: string;
  onConfirm: () => Promise<unknown>;
  onKeep?: (keep: ArticleChoice[]) => Promise<unknown>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"confirm" | "keep" | null>(null);
  const keep = onKeep && impact?.keep?.length ? impact.keep : null;
  const lost = impact && keep ? impact.removals - keep.length : 0;

  async function run(kind: "confirm" | "keep", action: () => Promise<unknown>) {
    setBusy(kind);
    try {
      await action();
      // Keeping re-checks the settings and may ask again, so the caller decides whether to close.
      if (kind === "confirm") onClose();
    } catch {
      // The caller reports the error (toast); keep the dialog open so the user can retry.
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open={impact !== null}
      onClose={busy ? () => undefined : onClose}
      size={keep ? "md" : "sm"}
      title={impact ? `Remove ${plural(impact.removals, "article")} from Genesys Cloud?` : ""}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            Cancel
          </Button>
          <Button variant={keep ? "secondary" : "danger"} onClick={() => run("confirm", onConfirm)} loading={busy === "confirm"} disabled={busy === "keep"}>
            {confirmLabel}
          </Button>
          {keep && onKeep ? (
            <Button variant="primary" onClick={() => run("keep", () => onKeep(keep))} loading={busy === "keep"} disabled={busy === "confirm"}>
              Keep them and add the new ones
            </Button>
          ) : null}
        </>
      }
    >
      {impact ? (
        <div className="space-y-2 text-sm leading-relaxed text-navy/70">
          <p>{INTRO[reason]}</p>
          <RemovalList impact={impact} />
          {impact.additions > 0 ? <p>It also adds {plural(impact.additions, "new article")}.</p> : null}
          {keep ? (
            lost > 0 ? (
              <p>
                Only {plural(keep.length, "of them", "of them")} can be kept. The other {lost === 1 ? "one isn't" : `${lost} aren't`} published in ServiceNow right now, or{" "}
                {lost === 1 ? "it's" : "they're"} in a knowledge base you didn&apos;t pick.
              </p>
            ) : null
          ) : (
            <p>{KEEP[reason]}</p>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
