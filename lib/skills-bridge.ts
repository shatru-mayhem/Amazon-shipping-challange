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
const SERVICE_URL = process.env.PYTHON_SKILLS_SERVICE_URL;
const SERVICE_TOKEN = process.env.PYTHON_SKILLS_SERVICE_TOKEN;

function runPythonLocal(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("python", args, { timeout: TIMEOUT_MS, cwd: process.cwd() }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function callRemote(endpoint: string, body: Record<string, unknown>): Promise<unknown> {
  if (!SERVICE_TOKEN) {
    throw new Error("PYTHON_SKILLS_SERVICE_TOKEN is not set — required alongside PYTHON_SKILLS_SERVICE_URL.");
  }
  const res = await fetch(`${SERVICE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Service-Token": SERVICE_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
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
