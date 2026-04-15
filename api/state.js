import crypto from "node:crypto";
import { readEnv } from "./_lib/env.js";
import {
  normalizePersistedState,
} from "./_lib/state-shape.js";
import {
  createStateSnapshot,
  getLatestStateSnapshotMetadata,
  getLatestStateSnapshot,
} from "./_lib/state-store.js";

function applyJsonHeaders(response, snapshotId) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (snapshotId) {
    response.setHeader("X-Race-State-Snapshot", snapshotId);
  }
}

function requestUrl(request) {
  return new URL(request.url || "/", `https://${request.headers.host || "localhost"}`);
}

function requestHostname(request) {
  return String(request.headers.host || "").split(":")[0];
}

function isLocalHost(hostname) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1";
}

function timingSafeTextEqual(left, right) {
  const leftDigest = crypto.createHash("sha256").update(String(left)).digest();
  const rightDigest = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function requireOperatorWriteAccess(request, response) {
  const configuredSecret = readEnv("OPERATOR_SYNC_SECRET");
  if (!configuredSecret) {
    applyJsonHeaders(response);
    response.status(503).json({
      error: "write_access_unavailable",
      message: "OPERATOR_SYNC_SECRET is not configured.",
    });
    return false;
  }

  const providedSecret = String(request.headers["x-operator-secret"] || "");
  if (!providedSecret || !timingSafeTextEqual(providedSecret, configuredSecret)) {
    applyJsonHeaders(response);
    response.status(403).json({
      error: "operator_secret_required",
      message: "A valid operator sync key is required for race-data writes.",
    });
    return false;
  }

  return true;
}

function requireOperatorStateReadAccess(request, response) {
  if (isLocalHost(requestHostname(request))) return true;
  return requireOperatorWriteAccess(request, response);
}

export default async function handler(request, response) {
  try {
    if (request.method === "GET") {
      await handleGet(request, response);
      return;
    }

    if (request.method === "PUT") {
      if (!requireOperatorWriteAccess(request, response)) return;
      await handlePut(request, response);
      return;
    }

    response.setHeader("Allow", "GET, PUT");
    response.status(405).send("Method Not Allowed");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const unavailable = message.includes("Supabase state backend is not configured.");
    applyJsonHeaders(response);
    response.status(unavailable ? 503 : 500).json({
      error: unavailable ? "shared_state_unavailable" : "shared_state_error",
      message,
    });
  }
}

async function handleGet(request, response) {
  const since = requestUrl(request).searchParams.get("since");
  if (!requireOperatorStateReadAccess(request, response)) return;

  if (since) {
    const latest = await getLatestStateSnapshotMetadata();
    if (since === latest.snapshotId) {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Race-State-Snapshot", latest.snapshotId);
      response.status(204).end();
      return;
    }
  }

  const current = await getLatestStateSnapshot();

  applyJsonHeaders(response, current.snapshotId);
  response.status(200).json({
    state: current.state,
    snapshotId: current.snapshotId,
  });
}

async function handlePut(request, response) {
  const payload = request.body && typeof request.body === "object"
    ? request.body
    : JSON.parse(request.body || "{}");

  const nextState = normalizePersistedState(payload?.state ?? payload);
  const baseSnapshotId = typeof payload?.baseSnapshotId === "string" ? payload.baseSnapshotId : null;
  const current = await getLatestStateSnapshot();

  if (baseSnapshotId && baseSnapshotId !== current.snapshotId) {
    applyJsonHeaders(response, current.snapshotId);
    response.status(409).json({
      error: "state_conflict",
      state: current.state,
      snapshotId: current.snapshotId,
    });
    return;
  }

  const saved = await createStateSnapshot(nextState);
  applyJsonHeaders(response, saved.snapshotId);
  response.status(200).json({
    state: saved.state,
    snapshotId: saved.snapshotId,
  });
}
