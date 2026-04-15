export function normalizeBoat(value) {
  return String(value || "").trim().toUpperCase();
}

export function normalizeCategoryName(value) {
  return String(value || "")
    .replace(/\s*\((single|two)\s+participants?\)\s*/gi, "")
    .replace(/\s*\(-?\$?\d+(?:\.\d+)?\)\s*/g, "")
    .trim();
}

export function formatClock(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "-";
  const rounded = Math.round(seconds);
  const hh = String(Math.floor(rounded / 3600)).padStart(2, "0");
  const mm = String(Math.floor((rounded % 3600) / 60)).padStart(2, "0");
  const ss = String(rounded % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function formatPenaltyMinutes(seconds) {
  const value = Number(seconds) || 0;
  return value ? `${Math.round(value / 60)} min` : "-";
}

function shortName(racer) {
  if (!racer) return "";
  const first = String(racer.first || "").trim();
  const last = String(racer.last || "").trim();
  const initial = first ? `${first[0].toUpperCase()}.` : "";
  return `${initial} ${last}`.trim();
}

function fullName(racer) {
  if (!racer) return "";
  return `${String(racer.first || "").trim()} ${String(racer.last || "").trim()}`.trim();
}

export function displayTeamName(team) {
  const sponsor = String(team?.sponsorName || "").trim();
  if (sponsor) return sponsor;

  const racers = [shortName(team?.racer1), shortName(team?.racer2)].filter(Boolean);
  return racers.join(" & ") || "Unnamed Team";
}

export function displayRosterName(team) {
  const racers = [fullName(team?.racer1), fullName(team?.racer2)].filter(Boolean);
  return racers.join(" & ") || "No racers listed";
}

export function computeElapsedSeconds(team) {
  if (!team?.startTime || !team?.finishTime) return null;
  const diff = (new Date(team.finishTime).getTime() - new Date(team.startTime).getTime()) / 1000;
  if (!Number.isFinite(diff) || diff < 0) return null;
  return diff + (Number(team.penaltySeconds) || 0);
}

export function buildScoreRows(teams = []) {
  const complete = teams
    .map((team) => ({
      team,
      elapsedSeconds: computeElapsedSeconds(team),
    }))
    .filter((row) => row.elapsedSeconds != null && !row.team.didNotFinish)
    .sort((left, right) => left.elapsedSeconds - right.elapsedSeconds);

  const byCategory = new Map();
  complete.forEach((row) => {
    const key = row.team.category || "Uncategorized";
    const bucket = byCategory.get(key) || [];
    bucket.push(row);
    byCategory.set(key, bucket);
  });

  return complete.map((row, index) => {
    const categoryRows = byCategory.get(row.team.category || "Uncategorized") || [];
    const categoryPlace = categoryRows.findIndex((candidate) => candidate.team.id === row.team.id) + 1;
    return {
      overall: index + 1,
      categoryPlace,
      ...row,
    };
  });
}

export function orderedCategories(teams = [], order = []) {
  const categories = [...new Set(teams.map((team) => normalizeCategoryName(team.category || "Uncategorized")))];
  const orderedKnown = order.filter((category) => categories.includes(category));
  const orderedNew = categories.filter((category) => !orderedKnown.includes(category));
  return [...orderedKnown, ...orderedNew];
}

export function teamStatus(team) {
  if (team?.didNotFinish) return "dnf";
  if (team?.finishTime) return "finished";
  if (team?.startTime) return "racing";
  if (team?.checkedIn) return "ready";
  return "registered";
}

export function statusLabel(status) {
  if (status === "dnf") return "DNF";
  if (status === "finished") return "Finished";
  if (status === "racing") return "Racing";
  if (status === "ready") return "Ready";
  return "Registered";
}
