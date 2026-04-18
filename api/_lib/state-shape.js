import crypto from "node:crypto";

const SCHEMA_VERSION = 4;

function isoNow() {
  return new Date().toISOString();
}

export function createSnapshotId() {
  const timestamp = isoNow().replace(/[:.]/g, "-");
  return `state-${timestamp}-${crypto.randomUUID()}`;
}

function normalizeTimestamp(value, fallback = null) {
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

function normalizeTeam(team, fallbackUpdatedAt) {
  if (!team || typeof team !== "object") return null;
  return {
    ...team,
    notes: String(team.notes || "").trim(),
    updatedAt: normalizeTimestamp(team.updatedAt, fallbackUpdatedAt),
  };
}

function normalizeFinish(entry, fallbackUpdatedAt) {
  if (!entry || typeof entry !== "object") return null;
  return {
    ...entry,
    updatedAt: normalizeTimestamp(entry.updatedAt, fallbackUpdatedAt),
  };
}

function normalizeTimingLogSequence(value) {
  const sequence = Number(value);
  return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

function cloneLogValue(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeTimingLogEntry(entry, source, fallbackUpdatedAt, sequenceState) {
  if (!entry || typeof entry !== "object") return null;
  const boatNumber = String(entry.boatNumber || "").trim().toUpperCase();
  const type = String(entry.type || "").trim();
  if (!boatNumber || !type) return null;

  const seq = normalizeTimingLogSequence(entry.seq) || sequenceState.next++;
  const recordedAt = normalizeTimestamp(entry.recordedAt, null);
  return {
    id: String(entry.id || `${source}-${seq}`),
    seq,
    ts: normalizeTimestamp(entry.ts, fallbackUpdatedAt),
    type,
    boatNumber,
    teamId: entry.teamId == null || entry.teamId === "" ? null : String(entry.teamId),
    source,
    recordedAt,
    displayedTime: entry.displayedTime == null || entry.displayedTime === "" ? null : String(entry.displayedTime),
    actor: String(entry.actor || "local-operator"),
    payload: cloneLogValue(entry.payload, {}) || {},
    before: cloneLogValue(entry.before, null),
    after: cloneLogValue(entry.after, null),
    scratchText: String(entry.scratchText || "").trim(),
  };
}

function normalizeTimingLogCollection(entries, source, fallbackUpdatedAt, sequenceState) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => normalizeTimingLogEntry(entry, source, fallbackUpdatedAt, sequenceState))
    .filter(Boolean)
    .sort((left, right) => {
      if (left.seq !== right.seq) return left.seq - right.seq;
      const leftTs = Date.parse(left.ts || "") || 0;
      const rightTs = Date.parse(right.ts || "") || 0;
      if (leftTs !== rightTs) return leftTs - rightTs;
      return left.id.localeCompare(right.id);
    });
}

function nextTimingLogSequenceValue(source = {}) {
  const maxSequence = [
    ...(Array.isArray(source.startLineLog) ? source.startLineLog : []),
    ...(Array.isArray(source.finishLineLog) ? source.finishLineLog : []),
  ].reduce((max, entry) => Math.max(max, normalizeTimingLogSequence(entry?.seq) || 0), 0);
  return maxSequence + 1 || 1;
}

export function getStateSchemaVersion() {
  return SCHEMA_VERSION;
}

export function createEmptyPersistedState() {
  const now = isoNow();
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    teams: [],
    finishes: [],
    startLineLog: [],
    finishLineLog: [],
    timingLogSequence: 1,
    scorecardCategoryOrderMain: [],
    scorecardCategoryOrderDisplay: [],
    scorecardCategoryOrderMainUpdatedAt: now,
    scorecardCategoryOrderDisplayUpdatedAt: now,
  };
}

export function normalizePersistedState(input) {
  const source = input && typeof input === "object" ? input : {};
  const fallbackUpdatedAt = normalizeTimestamp(source.updatedAt, isoNow());
  const highestExistingSequence = Math.max(
    ...[
      ...(Array.isArray(source.startLineLog) ? source.startLineLog : []),
      ...(Array.isArray(source.finishLineLog) ? source.finishLineLog : []),
    ].map((entry) => normalizeTimingLogSequence(entry?.seq) || 0),
    0,
  );
  const sequenceState = { next: highestExistingSequence + 1 };
  const startLineLog = normalizeTimingLogCollection(
    source.startLineLog,
    "start-line",
    fallbackUpdatedAt,
    sequenceState,
  );
  const finishLineLog = normalizeTimingLogCollection(
    source.finishLineLog,
    "finish",
    fallbackUpdatedAt,
    sequenceState,
  );

  return {
    schemaVersion: Number.isFinite(Number(source.schemaVersion))
      ? Number(source.schemaVersion)
      : SCHEMA_VERSION,
    updatedAt: fallbackUpdatedAt,
    teams: Array.isArray(source.teams)
      ? source.teams.map((team) => normalizeTeam(team, fallbackUpdatedAt)).filter(Boolean)
      : [],
    finishes: Array.isArray(source.finishes)
      ? source.finishes.map((entry) => normalizeFinish(entry, fallbackUpdatedAt)).filter(Boolean)
      : [],
    startLineLog,
    finishLineLog,
    timingLogSequence: Math.max(
      normalizeTimingLogSequence(source.timingLogSequence) || 0,
      nextTimingLogSequenceValue({ startLineLog, finishLineLog }),
      sequenceState.next,
    ),
    scorecardCategoryOrderMain: Array.isArray(source.scorecardCategoryOrderMain)
      ? source.scorecardCategoryOrderMain.filter(Boolean)
      : Array.isArray(source.scorecardCategoryOrder)
        ? source.scorecardCategoryOrder.filter(Boolean)
        : [],
    scorecardCategoryOrderDisplay: Array.isArray(source.scorecardCategoryOrderDisplay)
      ? source.scorecardCategoryOrderDisplay.filter(Boolean)
      : Array.isArray(source.scorecardCategoryOrder)
        ? source.scorecardCategoryOrder.filter(Boolean)
        : [],
    scorecardCategoryOrderMainUpdatedAt: normalizeTimestamp(
      source.scorecardCategoryOrderMainUpdatedAt,
      fallbackUpdatedAt,
    ),
    scorecardCategoryOrderDisplayUpdatedAt: normalizeTimestamp(
      source.scorecardCategoryOrderDisplayUpdatedAt,
      fallbackUpdatedAt,
    ),
  };
}

export function buildPublicScorecardState(input) {
  const source = normalizePersistedState(input);
  return {
    schemaVersion: source.schemaVersion,
    updatedAt: source.updatedAt,
    teams: source.teams.map((team) => ({
      id: team.id,
      boatNumber: team.boatNumber,
      category: team.category,
      racer1: team.racer1 ? { first: team.racer1.first || "", last: team.racer1.last || "" } : null,
      racer2: team.racer2 ? { first: team.racer2.first || "", last: team.racer2.last || "" } : null,
      startTime: team.startTime || null,
      finishTime: team.finishTime || null,
      penaltySeconds: Number(team.penaltySeconds) || 0,
      didNotFinish: Boolean(team.didNotFinish),
      updatedAt: team.updatedAt || source.updatedAt,
    })),
    finishes: [],
    scorecardCategoryOrderMain: source.scorecardCategoryOrderMain,
    scorecardCategoryOrderDisplay: source.scorecardCategoryOrderDisplay,
    scorecardCategoryOrderMainUpdatedAt: source.scorecardCategoryOrderMainUpdatedAt,
    scorecardCategoryOrderDisplayUpdatedAt: source.scorecardCategoryOrderDisplayUpdatedAt,
  };
}

export function buildPublicRaceControlState(input) {
  const source = normalizePersistedState(input);
  return {
    schemaVersion: source.schemaVersion,
    updatedAt: source.updatedAt,
    teams: source.teams.map((team) => ({
      id: team.id,
      boatNumber: team.boatNumber,
      category: team.category,
      checkedIn: Boolean(team.checkedIn),
      racer1: team.racer1 ? { first: team.racer1.first || "", last: team.racer1.last || "" } : null,
      racer2: team.racer2 ? { first: team.racer2.first || "", last: team.racer2.last || "" } : null,
      startTime: team.startTime || null,
      finishTime: team.finishTime || null,
      penaltySeconds: Number(team.penaltySeconds) || 0,
      didNotFinish: Boolean(team.didNotFinish),
      updatedAt: team.updatedAt || source.updatedAt,
    })),
  };
}
