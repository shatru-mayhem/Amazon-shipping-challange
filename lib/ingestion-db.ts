import { Pool } from "pg";

// Direct Postgres connection for the tender-upload / email-import server
// actions, using the app_ingestion role (see supabase/schema_hardening.sql
// §2) — NOT the Supabase JS client, because 'core'/'constraints' aren't
// exposed via PostgREST and RLS on these tables only grants SELECT to
// nl_query_readonly. Same reasoning as the Python side's SUPABASE_DB_URL,
// just write-capable and scoped to a different role.

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.APP_INGESTION_DB_URL;
    if (!connectionString) {
      throw new Error(
        "APP_INGESTION_DB_URL is not set — see supabase/schema_hardening.sql §2 and SETUP.md.",
      );
    }
    // Supabase's pooler requires SSL; without an explicit ssl option, pg
    // doesn't negotiate it at all and the pooler rejects the connection
    // with a misleading "password authentication failed" instead of a
    // real SSL/TLS error — the actual credentials were never the problem.
    // rejectUnauthorized: false because the pooler's cert chain isn't in
    // Node's default trust store (same as the discrete-field connection
    // that proved this out), not because we don't want encryption.
    pool = new Pool({ connectionString, max: 5, ssl: { rejectUnauthorized: false } });
  }
  return pool;
}

export async function ingestionQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await getPool().connect();
  try {
    // Supabase's transaction-mode pooler (port 6543) may route each
    // standalone statement to a DIFFERENT backend connection, so a bare
    // "SET search_path" does not persist to the next query. Wrapping in a
    // transaction pins one backend, and SET LOCAL scopes the path to it.
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path TO core, constraints");
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result.rows as T[];
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function ingestionQueryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await ingestionQuery<T>(sql, params);
  return rows[0] ?? null;
}
