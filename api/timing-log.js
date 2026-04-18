import {
  normalizePersistedState,
} from "./_lib/state-shape.js";
import {
  appendTimingLogFiles,
} from "./_lib/local-timing-log-store.js";

function applyJsonHeaders(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
}

function requestHostname(request) {
  return String(request.headers.host || "").split(":")[0];
}

function isLocalHost(hostname) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1";
}

function requireLocalHost(request, response) {
  if (isLocalHost(requestHostname(request))) return true;
  applyJsonHeaders(response);
  response.status(403).json({
    error: "local_timing_log_unavailable",
    message: "Local timing log files can only be written from the local operator server.",
  });
  return false;
}

export default async function handler(request, response) {
  try {
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      response.status(405).send("Method Not Allowed");
      return;
    }

    if (!requireLocalHost(request, response)) return;

    const payload = request.body && typeof request.body === "object"
      ? request.body
      : JSON.parse(request.body || "{}");
    const normalized = normalizePersistedState({
      startLineLog: payload?.startEvents,
      finishLineLog: payload?.finishEvents,
      timingLogSequence: payload?.timingLogSequence,
      updatedAt: payload?.updatedAt || new Date().toISOString(),
    });

    const result = await appendTimingLogFiles({
      startEvents: normalized.startLineLog,
      finishEvents: normalized.finishLineLog,
    });

    applyJsonHeaders(response);
    response.status(200).json({
      ok: true,
      appended: {
        startLineLog: result.startCount,
        finishLineLog: result.finishCount,
      },
      files: result.files,
    });
  } catch (error) {
    applyJsonHeaders(response);
    response.status(500).json({
      error: "local_timing_log_write_failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

