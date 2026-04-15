import crypto from "node:crypto";

const SCHEMA_VERSION = 3;

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
    scorecardCategoryOrderMain: [],
    scorecardCategoryOrderDisplay: [],
    scorecardCategoryOrderMainUpdatedAt: now,
    scorecardCategoryOrderDisplayUpdatedAt: now,
  };
}

export function normalizePersistedState(input) {
  const source = input && typeof input === "object" ? input : {};
  const fallbackUpdatedAt = normalizeTimestamp(source.updatedAt, isoNow());

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
