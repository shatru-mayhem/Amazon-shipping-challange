"use client";

import { useState } from "react";
import TopBar from "@/components/TopBar";
import PipelineView from "@/components/PipelineView";
import StatusBadge from "@/components/StatusBadge";
import { pipelineByProject } from "@/lib/mock-data";
import TeamPanel from "@/components/TeamPanel";
import DeliverablesPanel from "@/components/DeliverablesPanel";
import TenderUploadPanel from "@/components/TenderUploadPanel";
import EmailImportPanel from "@/components/EmailImportPanel";
import RetrievalStatusPanel from "@/components/RetrievalStatusPanel";
import KnowledgePanel from "@/components/KnowledgePanel";
import {
  reviewFolders,
  employeeQA,
  proposalSignals,
  evaluationChecklist,
  type HierarchyLevel,
} from "@/lib/mock-employee";

const levelRank: Record<HierarchyLevel, number> = {
  Associate: 1,
  Manager: 2,
  Executive: 3,
};

export default function EmployeePortal() {
  const [level, setLevel] = useState<HierarchyLevel>("Associate");

  return (
    <main className="min-h-screen">
      <TopBar context="Employee Portal" showBack />

      <div className="mx-auto max-w-7xl px-4 py-6">
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-bold">Operations Dashboard</h1>
          <label htmlFor="level" className="ml-auto text-sm text-gray-600">
            Hierarchy level (demo switch):
          </label>
          <select
            id="level"
            value={level}
            onChange={(e) => setLevel(e.target.value as HierarchyLevel)}
            className="h-11 rounded-sm border border-border bg-surface px-2 text-sm"
          >
            <option>Associate</option>
            <option>Manager</option>
            <option>Executive</option>
          </select>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-8 lg:col-span-2">
            {/* Internal pipeline view */}
            <section>
              <h2 className="mb-3 text-base font-bold">
                Digital Twin Pipeline — internal view (EU Cross-Border
                Fulfilment)
              </h2>
              <PipelineView stages={pipelineByProject.p1} />
            </section>

            {/* Q&A answer bar */}
            <section>
              <h2 className="mb-3 text-base font-bold">
                Q&amp;A Answer Bar — filtered to your area
              </h2>
              <ul className="space-y-2">
                {employeeQA.map((q) => (
                  <li
                    key={q.id}
                    className="rounded-sm border border-border bg-surface p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      <span>{q.client}</span>
                      <span aria-hidden="true">·</span>
                      <span>{q.area}</span>
                      <StatusBadge tone="warning" label={"Due: " + q.due} />
                    </div>
                    <p className="mt-1 text-sm">{q.question}</p>
                    <button className="mt-2 h-9 rounded-sm bg-orange px-3 text-sm font-medium text-ink hover:bg-orange-dark">
                      Answer
                    </button>
                  </li>
                ))}
              </ul>
            </section>

            {/* Challenge brief & evaluation */}
            <section>
              <h2 className="mb-3 text-base font-bold">
                Challenge Brief &amp; Client Evaluation
              </h2>
              <ul className="space-y-2">
                {evaluationChecklist.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 rounded-sm border border-border bg-surface p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      defaultChecked={c.done}
                      aria-label={c.item}
                      className="h-4 w-4"
                    />
                    <span>{c.item}</span>
                  </li>
                ))}
              </ul>
            </section>

            <TenderUploadPanel />

            <EmailImportPanel />

            <RetrievalStatusPanel />

            <TeamPanel />

            <DeliverablesPanel />

            <KnowledgePanel />
          </div>

          <div className="space-y-8">
            {/* Restricted document folders */}
            <section>
              <h2 className="mb-3 text-base font-bold">
                Document Review Folders
              </h2>
              <ul className="space-y-2">
                {reviewFolders.map((f) => {
                  const allowed = levelRank[level] >= levelRank[f.minLevel];
                  return (
                    <li
                      key={f.id}
                      className={
                        "flex items-center justify-between rounded-sm border border-border p-3 text-sm " +
                        (allowed ? "bg-surface" : "bg-gray-100 text-gray-400")
                      }
                    >
                      <span>
                        {allowed ? "📁" : "🔒"} {f.name}
                      </span>
                      <span className="text-xs">
                        {allowed ? f.files + " files" : f.minLevel + "+ only"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>

            {/* Proposal chat */}
            <section>
              <h2 className="mb-3 text-base font-bold">
                Proposal Integration Chat
              </h2>
              <div className="rounded-sm border border-border bg-surface p-3">
                <p className="mb-2 text-xs text-gray-500">
                  Deterministic assistant constrained to current execution
                  capabilities. Human review required.
                </p>
                <ul className="space-y-2 text-sm">
                  {proposalSignals.map((s, i) => (
                    <li key={i} className="flex gap-2">
                      <StatusBadge
                        tone={
                          s.kind === "Risk"
                            ? "danger"
                            : s.kind === "Opportunity"
                              ? "success"
                              : "warning"
                        }
                        label={s.kind}
                      />
                      <span className="flex-1">{s.text}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex gap-2">
                  <input
                    aria-label="Ask about this opportunity"
                    placeholder="Ask about this opportunity…"
                    className="h-11 flex-1 rounded-sm border border-border px-3 text-sm"
                  />
                  <button className="h-11 rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark">
                    Send
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
