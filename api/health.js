import { readEnv } from "./_lib/env.js";
import { getLatestStateSnapshotMetadata } from "./_lib/state-store.js";

function json(response, status, payload) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.status(status).json(payload);
}

function requiredEnvStatus() {
  const missing = [];
  if (!readEnv("SUPABASE_URL")) missing.push("SUPABASE_URL");
  if (!readEnv("SUPABASE_SECRET_KEY") && !readEnv("SUPABASE_SERVICE_ROLE_KEY")) {
    missing.push("SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY");
  }

  return {
    ok: missing.length === 0,
    missing,
    hasOperatorSecret: Boolean(readEnv("OPERATOR_SYNC_SECRET")),
  };
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).send("Method Not Allowed");
    return;
  }

  const env = requiredEnvStatus();
  const server = {
    ok: true,
    runtime: "node",
    host: String(request.headers?.host || ""),
  };
  if (!env.ok) {
    json(response, 503, {
      ok: false,
      mode: "degraded",
      server,
      env,
      api: { state: "unavailable" },
      supabase: {
        ok: false,
        message: `Missing configuration: ${env.missing.join(", ")}`,
      },
    });
    return;
  }

  try {
    const snapshot = await getLatestStateSnapshotMetadata();
    json(response, 200, {
      ok: true,
      mode: "ready",
      server,
      env,
      api: { state: "reachable", health: "reachable" },
      supabase: {
        ok: true,
        message: "Shared state reachable",
        snapshotId: snapshot.snapshotId,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    json(response, 503, {
      ok: false,
      mode: "degraded",
      server,
      env,
      api: { state: "reachable", health: "reachable" },
      supabase: {
        ok: false,
        message,
      },
      updatedAt: new Date().toISOString(),
    });
  }
}
