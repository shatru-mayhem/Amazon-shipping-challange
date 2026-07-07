"use client";

import { useEffect, useState, useTransition } from "react";
import StatusBadge from "@/components/StatusBadge";
import { addEmployee, listRoster, type RosterEntry } from "@/app/actions/team";
import type { HierarchyLevel } from "@/lib/db-types";

// Head-account (Admin) panel: add employees and assign hierarchy.
// Server actions enforce the Admin check; non-admins see the denial message.
export default function TeamPanel() {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [email, setEmail] = useState("");
  const [level, setLevel] = useState<HierarchyLevel>("Associate");
  const [team, setTeam] = useState("");
  const [message, setMessage] = useState("");
  const [denied, setDenied] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    listRoster().then((res) => {
      if (res.ok && res.data) setRoster(res.data);
      else if (res.error?.includes("head account")) setDenied(true);
    });
  }, []);

  if (denied) return null; // hidden for non-admin employees

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await addEmployee({ email, hierarchy_level: level, team });
      if (!res.ok || !res.data) {
        setMessage(res.error ?? "Failed to add employee.");
        return;
      }
      setRoster((r) => [res.data!, ...r.filter((x) => x.email !== res.data!.email)]);
      setMessage("Added. They can now sign in with “Email me a code”.");
      setEmail("");
      setTeam("");
    });
  }

  return (
    <section>
      <h2 className="mb-3 text-base font-bold">Team Management (head account)</h2>
      <div className="rounded-sm border border-border bg-surface p-4">
        <form onSubmit={submit} className="grid gap-3" noValidate>
          <div>
            <label htmlFor="emp-email" className="mb-1 block text-sm font-medium">
              Employee email
            </label>
            <input
              id="emp-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-11 w-full rounded-sm border border-border px-3 text-sm"
              placeholder="employee@amazon.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="emp-level" className="mb-1 block text-sm font-medium">
                Hierarchy level
              </label>
              <select
                id="emp-level"
                value={level}
                onChange={(e) => setLevel(e.target.value as HierarchyLevel)}
                className="h-11 w-full rounded-sm border border-border bg-surface px-2 text-sm"
              >
                <option>Associate</option>
                <option>Manager</option>
                <option>Executive</option>
              </select>
            </div>
            <div>
              <label htmlFor="emp-team" className="mb-1 block text-sm font-medium">
                Team (optional)
              </label>
              <input
                id="emp-team"
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                className="h-11 w-full rounded-sm border border-border px-3 text-sm"
                placeholder="e.g. Lane Planning"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={pending}
            className="h-11 rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark disabled:opacity-60"
          >
            {pending ? "Adding…" : "Add employee"}
          </button>
          {message ? <p className="text-sm text-gray-600">{message}</p> : null}
        </form>

        {roster.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {roster.map((r) => (
              <li
                key={r.email}
                className="flex items-center justify-between rounded-sm border border-border p-2.5 text-sm"
              >
                <span className="truncate">{r.email}</span>
                <span className="flex items-center gap-2">
                  {r.team ? (
                    <span className="text-xs text-gray-500">{r.team}</span>
                  ) : null}
                  <StatusBadge tone="info" label={r.hierarchy_level} />
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
