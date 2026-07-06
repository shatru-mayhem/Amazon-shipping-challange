"use client";

import { useEffect, useState, useTransition } from "react";
import StatusBadge, { type StatusTone } from "@/components/StatusBadge";
import { getCurrentProfile } from "@/app/actions/auth";

// Ground-truth capability ingestion (skills/capability_ingestion/) — a
// fundamentally different pipeline from tender/email ingestion: this
// proposes changes to Amazon's OWN amazon_capability_profile (e.g. "we
// can now cover France"), not a client's stated requirement. A wrong
// extraction here would silently corrupt every future opportunity's
// compliance/risk/pricing checks against that constraint type, so
// nothing here ever writes directly — every proposal sits in
// amazon_capability_update_queue until an explicit Approve/Reject.
//
// "Run Demo Ingestion" only ever processes a hardcoded internal memo
// (see capability_ingestion.py's DEMO_MEMO_TEXT) — nothing runs
// automatically; it only executes on click, and every resulting row is
// tagged is_demo so it's never confused with a real future upload.

interface Proposal {
  update_id: string;
  constraint_name: string;
  proposed_capability_status: "can_do" | "cannot_do" | "can_do_with_conditions";
  proposed_structured_value: Record<string, unknown> | null;
  proposed_conditions_text: string | null;
  confidence: string;
  is_demo: boolean;
  raw_text: string;
}

const statusTone: Record<string, StatusTone> = {
  can_do: "success",
  can_do_with_conditions: "warning",
  cannot_do: "danger",
};

async function callCapabilitySkill<T>(extraArgs: string[]): Promise<T | null> {
  try {
    const res = await fetch("/api/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill: "capability_ingestion", extra_args: extraArgs }),
    });
    const json = await res.json();
    return json.ok ? (json.data as T) : null;
  } catch {
    return null;
  }
}

export default function CapabilityIngestionPanel() {
  const [reviewerEmail, setReviewerEmail] = useState("employee");
  const [pending, setPendingProposals] = useState<Proposal[]>([]);
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    getCurrentProfile().then((profile) => {
      if (profile?.email) setReviewerEmail(profile.email);
    });
    refreshPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function refreshPending() {
    callCapabilitySkill<Proposal[]>(["list_pending"]).then((res) => {
      if (res) setPendingProposals(res);
    });
  }

  function runDemoIngestion() {
    setMessage("");
    startTransition(async () => {
      const result = await callCapabilitySkill<{ proposals_created: number; chunks_ingested: number }>(["run_demo"]);
      if (!result) {
        setMessage("Demo ingestion failed.");
        return;
      }
      setMessage(`Demo memo ingested (${result.chunks_ingested} chunk(s)) — ${result.proposals_created} proposal(s) awaiting review.`);
      refreshPending();
    });
  }

  function decide(updateId: string, action: "approve" | "reject") {
    startTransition(async () => {
      await callCapabilitySkill([action, updateId, reviewerEmail]);
      refreshPending();
    });
  }

  function resetDemo() {
    setMessage("");
    startTransition(async () => {
      const result = await callCapabilitySkill<{ reverted_count: number }>(["reset_demo"]);
      if (!result) {
        setMessage("Reset failed.");
        return;
      }
      setMessage(
        result.reverted_count > 0
          ? `Reverted ${result.reverted_count} demo-approved capability change(s) back to baseline.`
          : "No demo-approved changes to revert — already at baseline."
      );
      refreshPending();
    });
  }

  return (
    <section>
      <h2 className="mb-3 text-base font-bold">Capability Update Ingestion (Ground Truth)</h2>
      <div className="rounded-md border border-border bg-surface p-4">
        <p className="mb-3 text-xs text-gray-500">
          Proposes changes to Amazon&apos;s own capability profile from an internal ops memo — never
          writes directly. Every proposal waits here for an explicit Approve/Reject.
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={runDemoIngestion}
            disabled={isPending}
            className="h-11 rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark disabled:opacity-60"
          >
            {isPending ? "Working…" : "Run Demo Ingestion"}
          </button>
          <button
            onClick={resetDemo}
            disabled={isPending}
            title="Reverts amazon_capability_profile back to its pre-demo state for every demo-approved change. Never touches a real (non-demo) approval."
            className="h-11 rounded-sm border border-border px-4 text-sm font-medium text-link hover:bg-gray-50 disabled:opacity-60"
          >
            Reset Demo
          </button>
        </div>
        {message ? <p className="mt-2 text-sm text-gray-600">{message}</p> : null}

        {pending.length > 0 ? (
          <ul className="mt-4 space-y-3 border-t border-border pt-4">
            {pending.map((p) => (
              <li key={p.update_id} className="rounded-sm border border-border p-3">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <StatusBadge tone={statusTone[p.proposed_capability_status] ?? "neutral"} label={p.proposed_capability_status} />
                  <span className="text-sm font-medium">{p.constraint_name}</span>
                  {p.is_demo ? <StatusBadge tone="info" label="demo" /> : null}
                  <span className="text-xs text-gray-500">confidence {p.confidence}</span>
                </div>
                {p.proposed_structured_value ? (
                  <pre className="mt-1 overflow-x-auto rounded-sm bg-canvas p-2 text-xs text-gray-700">
                    {JSON.stringify(p.proposed_structured_value, null, 2)}
                  </pre>
                ) : null}
                {p.proposed_conditions_text ? (
                  <p className="mt-1 text-xs text-gray-600">{p.proposed_conditions_text}</p>
                ) : null}
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-link">Source text</summary>
                  <p className="mt-1 text-xs text-gray-500">{p.raw_text}</p>
                </details>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => decide(p.update_id, "approve")}
                    disabled={isPending}
                    className="h-9 rounded-sm bg-success px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(p.update_id, "reject")}
                    disabled={isPending}
                    className="h-9 rounded-sm border border-border px-3 text-xs font-medium text-link hover:bg-gray-50 disabled:opacity-60"
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-xs text-gray-500">No pending capability update proposals.</p>
        )}
      </div>
    </section>
  );
}
