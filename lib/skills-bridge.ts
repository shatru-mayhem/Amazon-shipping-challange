import { execFile } from "child_process";
import path from "path";

// Shared by app/api/skill/route.ts and app/api/retrieve/route.ts: run a
// skills/*.py script either as a local subprocess (dev, and any host that
// actually has Python installed) or via HTTP against a separately-hosted
// Python service (service/app.py) — needed on Vercel, whose Node.js
// serverless functions have no Python interpreter, no psycopg2/faiss, and
// no path to a local Ollama server. Sett PYTHON_SKILLS_SERVICE_URL to
// switch to the remote path; unset (local dev default) keeps the
// subprocess behavior unchanged.

const TIMEOUT_MS = 120_000;
// persist_opportunity() makes one retrieval call (each potentially an LLM
// call) per opportunity_features field plus every constraint catalog type
// — SKILL.md is explicit that neither local nor cloud generation is
// reliably fast, so the standard 2-minute timeout above is too tight for
// this one, multi-call pipeline run.
const PERSIST_TIMEOUT_MS = 600_000;
const SERVICE_URL = process.env.PYTHON_SKILLS_SERVICE_URL;
const SERVICE_TOKEN = process.env.PYTHON_SKILLS_SERVICE_TOKEN;

function runPythonLocal(args: string[], timeoutMs: number = TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("python", args, { timeout: timeoutMs, cwd: process.cwd() }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function callRemote(endpoint: string, body: Record<string, unknown>, timeoutMs: number = TIMEOUT_MS): Promise<unknown> {
  if (!SERVICE_TOKEN) {
    throw new Error("PYTHON_SKILLS_SERVICE_TOKEN is not set — required alongside PYTHON_SKILLS_SERVICE_URL.");
  }
  const res = await fetch(`${SERVICE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((json && (json.detail || json.error)) || `Skills service returned ${res.status}`);
  }
  return json;
}

export async function callSkillByName(
  skillName: string,
  skillScriptRelativePath: string,
  opportunityId: string | undefined,
  extraArgs: string[] | undefined,
): Promise<unknown> {
  if (SERVICE_URL) {
    return callRemote("/skill", { skill: skillName, opportunity_id: opportunityId, extra_args: extraArgs });
  }
  const scriptPath = path.join(process.cwd(), "skills", skillScriptRelativePath);
  const cliArgs = [scriptPath, ...(opportunityId ? [opportunityId] : []), ...(extraArgs ?? [])];
  return JSON.parse(await runPythonLocal(cliArgs));
}

export async function callRetrieve(
  opportunityId: string,
  table: string,
  field: string | undefined,
): Promise<unknown> {
  if (SERVICE_URL) {
    return callRemote("/retrieve", { opportunity_id: opportunityId, table, field });
  }
  const scriptPath = path.join(process.cwd(), "skills", "retrieval", "retrieval.py");
  const cliArgs = [scriptPath, opportunityId, table, ...(field ? [field] : [])];
  return JSON.parse(await runPythonLocal(cliArgs));
}

// nl_query_gemini.py lives at the project root (not under skills/) — it's
// a standalone NL-to-SQL wrapper (Gemini writes SQL, runs read-only
// against Supabase), not one of the dashboard skills. Same subprocess vs.
// remote-service split as the calls above.
export async function callNlQuery(question: string): Promise<unknown> {
  if (SERVICE_URL) {
    return callRemote("/nl_query", { question });
  }
  const scriptPath = path.join(process.cwd(), "nl_query_gemini.py");
  return JSON.parse(await runPythonLocal([scriptPath, "--json", question]));
}

// skills/exploration/historical_archetypes.py: PCA + clustering over
// core.historical_tenders, surfaced on the historical-insights page.
// updateRequirementsDoc writes a real repo file (RETRIEVAL_REQUIREMENTS.md)
// — fine for local dev and the long-running service container, but note
// that on the remote service the write lands in that container's checkout,
// not back in this Next.js deployment's source tree.
export async function callHistoricalAnalysis(options: {
  clusters?: number;
  saveModel?: boolean;
  updateRequirementsDoc?: boolean;
}): Promise<unknown> {
  const { clusters, saveModel, updateRequirementsDoc } = options;
  if (SERVICE_URL) {
    return callRemote("/historical_analysis", {
      clusters,
      save_model: saveModel,
      update_requirements_doc: updateRequirementsDoc,
    });
  }
  const scriptPath = path.join(process.cwd(), "skills", "exploration", "historical_archetypes.py");
  const cliArgs = [
    scriptPath,
    "--json",
    ...(clusters ? ["--clusters", String(clusters)] : []),
    ...(saveModel ? ["--save-model"] : []),
    ...(updateRequirementsDoc ? ["--update-requirements-doc"] : []),
  ];
  return JSON.parse(await runPythonLocal(cliArgs));
}

// skills/retrieval/persist.py: runs retrieval on every opportunity_features
// field + every constraint catalog type + client_highlights + email
// resolutions, then writes the found values into the real tables (plus
// derived constraint_compliance_results / signal_check_results). Existed
// as a CLI-only script — this is what makes it reachable from an upload,
// so "upload a document" actually results in the pipeline running instead
// of just landing a file + chunks with nothing downstream reading them.
export async function callPersistOpportunity(opportunityId: string): Promise<unknown> {
  if (SERVICE_URL) {
    return callRemote("/persist", { opportunity_id: opportunityId }, PERSIST_TIMEOUT_MS);
  }
  const scriptPath = path.join(process.cwd(), "skills", "retrieval", "persist.py");
  return JSON.parse(await runPythonLocal([scriptPath, opportunityId], PERSIST_TIMEOUT_MS));
}

// Raw bytes of the serialized model — either read straight off disk
// (local/service filesystem) or proxied from the remote service.
export async function getHistoricalModelFile(): Promise<Buffer> {
  if (SERVICE_URL) {
    if (!SERVICE_TOKEN) {
      throw new Error("PYTHON_SKILLS_SERVICE_TOKEN is not set — required alongside PYTHON_SKILLS_SERVICE_URL.");
    }
    const res = await fetch(`${SERVICE_URL}/historical_model`, {
      headers: { "X-Service-Token": SERVICE_TOKEN },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Skills service returned ${res.status} fetching the model file`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
  const fs = await import("fs/promises");
  const modelPath = path.join(process.cwd(), "skills", "exploration", "historical_archetypes_model.joblib");
  return fs.readFile(modelPath);
}
