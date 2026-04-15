import {
  buildPublicScorecardState,
} from "./_lib/state-shape.js";
import {
  getLatestStateSnapshotMetadata,
  getLatestStateSnapshot,
} from "./_lib/state-store.js";

function requestUrl(request) {
  return new URL(request.url || "/", `https://${request.headers.host || "localhost"}`);
}

export default async function handler(request, response) {
  try {
    const since = requestUrl(request).searchParams.get("since");
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
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("X-Race-State-Snapshot", current.snapshotId);
    response.status(200).json({
      state: buildPublicScorecardState(current.state),
      snapshotId: current.snapshotId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const unavailable = message.includes("Supabase state backend is not configured.");
    response.setHeader("Cache-Control", "no-store");
    response.status(unavailable ? 503 : 500).json({
      error: unavailable ? "public_scorecard_unavailable" : "public_scorecard_error",
      message,
    });
  }
}
