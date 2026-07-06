"use client";

import { useState } from "react";
import TopBar from "@/components/TopBar";
import PipelineView from "@/components/PipelineView";
import StatusBadge, { type StatusTone } from "@/components/StatusBadge";
import {
  projects,
  pipelineByProject,
  qaItems,
  docItems,
  docCategories,
} from "@/lib/mock-data";

const statusTone: Record<string, StatusTone> = {
  Uploaded: "neutral",
  Viewed: "info",
  Reviewed: "warning",
  Answered: "success",
};

export default function ClientPortal() {
  const [projectId, setProjectId] = useState(projects[0].id);
  const [menuOpen, setMenuOpen] = useState(false);
  const project = projects.find((p) => p.id === projectId) ?? projects[0];

  return (
    <main className="min-h-screen">
      <TopBar context="Client Portal" showBack />

      <div className="mx-auto max-w-7xl px-4 py-6">
        {/* Project hamburger drop-down */}
        <div className="relative mb-6 flex items-center gap-3">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="flex h-11 items-center gap-2 rounded-sm border border-border bg-surface px-3 text-sm font-medium hover:bg-gray-50"
          >
            <span aria-hidden="true">☰</span> {project.name}
          </button>
          <StatusBadge tone="info" label={project.status} />
          {menuOpen ? (
            <ul
              role="menu"
              className="absolute left-0 top-12 z-10 w-72 rounded-sm border border-border bg-surface shadow-md"
            >
              {projects.map((p) => (
                <li key={p.id} role="none">
                  <button
                    role="menuitem"
                    onClick={() => {
                      setProjectId(p.id);
                      setMenuOpen(false);
                    }}
                    className={
                      "flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-gray-50 " +
                      (p.id === projectId ? "bg-cyan-50" : "")
                    }
                  >
                    <span>{p.name}</span>
                    <span className="text-xs text-gray-500">{p.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* Digital Twin Pipeline */}
          <section className="lg:col-span-2">
            <h2 className="mb-3 text-base font-bold">Digital Twin Pipeline</h2>
            <PipelineView stages={pipelineByProject[projectId]} />
          </section>

          {/* Progress tracker */}
          <section>
            <h2 className="mb-3 text-base font-bold">Progress Tracker</h2>
            <ul className="space-y-2">
              {docItems.map((d) => (
                <li
                  key={d.id}
                  className="rounded-sm border border-border bg-surface p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{d.name}</span>
                    <StatusBadge tone={statusTone[d.status]} label={d.status} />
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {d.category} · updated {d.updated}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {/* Q&A area */}
          <section>
            <h2 className="mb-3 text-base font-bold">
              Q&amp;A — routed by category
            </h2>
            <table className="w-full border-collapse rounded-sm border border-border bg-surface text-sm">
              <thead>
                <tr className="border-b border-border bg-gray-50 text-left text-xs uppercase text-gray-600">
                  <th scope="col" className="px-3 py-2">Category</th>
                  <th scope="col" className="px-3 py-2">Question</th>
                  <th scope="col" className="px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {qaItems.map((q) => (
                  <tr key={q.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2 font-medium">{q.category}</td>
                    <td className="px-3 py-2">{q.question}</td>
                    <td className="px-3 py-2">
                      <StatusBadge
                        tone={statusTone[q.status]}
                        label={q.status}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Document upload */}
          <section>
            <h2 className="mb-3 text-base font-bold">Document Upload</h2>
            <div className="rounded-sm border border-border bg-surface p-4">
              <label htmlFor="doc-cat" className="mb-1 block text-sm font-medium">
                Document category
              </label>
              <select
                id="doc-cat"
                className="mb-3 h-11 w-full rounded-sm border border-border bg-surface px-2 text-sm"
              >
                {docCategories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              <div className="rounded-sm border border-dashed border-border p-6 text-center text-sm text-gray-500">
                Drop files here or{" "}
                <button className="text-link underline underline-offset-2">
                  browse
                </button>
                <p className="mt-1 text-xs">(Preview mock — uploads disabled)</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
