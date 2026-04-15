const STORAGE_KEY = "race-timekeeper-v1";
const EVENT_LOG_STORAGE_KEY = "race-timekeeper-event-log-v1";
const OPERATOR_SYNC_SECRET_STORAGE_KEY = "race-timekeeper-operator-sync-secret";
const OPERATOR_SYNC_ENABLED_STORAGE_KEY = "race-timekeeper-operator-sync-enabled";
const SYNC_QUEUE_STORAGE_KEY = "race-timekeeper-sync-queue-v1";
const SHARED_STATE_API_PATH = "/api/state";
const PUBLIC_SCORECARD_API_PATH = "/api/public-scorecard";
const HEALTH_API_PATH = "/api/health";
const OPERATOR_SHARED_STATE_POLL_MS = 7000;
const PUBLIC_SHARED_STATE_POLL_MS = 15000;
const SHARED_STATE_SAVE_DEBOUNCE_MS = 750;
const SCORECARD_DISPLAY_WINDOW_NAME = "scorecardDisplay";
const SCORECARD_SYNC_CHANNEL_NAME = "race-timekeeper-scorecard-sync";
const SCORECARD_SYNC_MESSAGE_TYPE = "scorecard-state-sync";
const SHARED_STATE_SCHEMA_VERSION = 3;
const LOCAL_EVENT_LOG_SCHEMA_VERSION = 1;
const WINDOW_INSTANCE_ID = newId();

const state = {
  teams: [],
  finishes: [],
  editingTeamId: null,
  editingStartTeamId: null,
  editingFinishId: null,
  registrationQuery: "",
  registrationFilter: "all",
  startQueueFilterBoats: [],
  startQueueStatusFilter: "all",
  finishEntryFilter: "all",
  finishCapturedTimeIso: null,
  scorecardCategoryOrderMain: [],
  scorecardCategoryOrderDisplay: [],
  scorecardCategoryOrderMainUpdatedAt: null,
  scorecardCategoryOrderDisplayUpdatedAt: null,
  sharedStateUpdatedAt: null,
};
let draggingScoreCategory = null;
let draggingScoreCard = null;
let dragDropCommitted = false;
let scorecardDisplayWindow = null;
let scorecardSyncChannel = null;
const sharedStateSync = {
  enabled: false,
  initializing: false,
  saveInFlight: false,
  saveQueued: false,
  saveTimerId: null,
  queue: [],
  snapshotId: null,
  lastPublishedSignature: null,
  pollTimerId: null,
  conflictNotified: false,
  status: "local",
  message: "Browser-only data",
};
const localEventJournal = {
  events: [],
};
const runtimeHealth = {
  checking: false,
  payload: null,
};

function timekeeperConfig() {
  return window.__TIMEKEEPER_CONFIG && typeof window.__TIMEKEEPER_CONFIG === "object"
    ? window.__TIMEKEEPER_CONFIG
    : {};
}

function isProxyManagedSyncEnabled() {
  return Boolean(timekeeperConfig().proxyManagedSync);
}

function newId() {
  return Math.random().toString(36).slice(2, 10);
}

function isPublicScorecardMode() {
  const params = new URLSearchParams(window.location.search);
  return window.location.pathname === "/scorecard"
    || params.get("public") === "scorecard";
}

function isLocalOperatorHost() {
  const hostname = window.location.hostname;
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1";
}

function shouldAllowOperatorApp() {
  return isLocalOperatorHost();
}

function redirectHostedOperatorRoute() {
  if (isPublicScorecardMode() || isScorecardDisplayMode()) return;
  if (window.location.pathname === "/coordinator") return;
  if (shouldAllowOperatorApp()) return;
  window.location.replace("/");
}

function currentISOTime() {
  return new Date().toISOString();
}

function normalizeTimestamp(value, fallback = null) {
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? fallback : new Date(parsed).toISOString();
}

function normalizeBoat(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeRegistrationNotes(value) {
  return String(value || "").trim();
}

function hasRegistrationNotes(team) {
  return Boolean(normalizeRegistrationNotes(team?.notes));
}

function renderNotesIndicator(team) {
  return hasRegistrationNotes(team)
    ? '<span class="notes-indicator" aria-label="Internal notes on file" title="Internal notes on file">Notes</span>'
    : "";
}

function setRegistrationNotesIndicatorVisible(visible) {
  document.querySelector("#registration-notes-indicator")?.classList.toggle("hidden", !visible);
}

function isPaid(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "paid" || normalized === "true" || normalized === "yes";
}

function formatPhoneInput(value) {
  const digits = String(value || "").replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits ? `(${digits}` : "";
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function normalizeCategoryName(value) {
  return String(value || "")
    .replace(/\s*\((single|two)\s+participants?\)\s*/gi, "")
    .replace(/\s*\(-?\$?\d+(?:\.\d+)?\)\s*/g, "")
    .trim();
}

function isSingleParticipantClass(category) {
  const normalized = normalizeCategoryName(category).toLowerCase();
  return ["paddle board", "men's kayak", "women's kayak", "senior kayak", "one-man canoe"].includes(normalized);
}

function ensureCategoryOption(selectEl, value) {
  if (!selectEl || !value) return;
  const exists = Array.from(selectEl.options).some((option) => option.value === value);
  if (exists) return;
  const option = document.createElement("option");
  option.value = value;
  option.textContent = `${value} (legacy)`;
  selectEl.append(option);
}

function updateRacerFieldAvailability(form) {
  if (!form) return;
  const singleParticipant = isSingleParticipantClass(form.category.value);
  const racer2Fields = form.querySelectorAll("[data-racer2-field]");
  racer2Fields.forEach((field) => {
    field.hidden = singleParticipant;
    const input = field.querySelector("input");
    if (!input) return;
    input.disabled = singleParticipant;
    input.required = !singleParticipant;
    if (singleParticipant) {
      input.value = "";
    }
  });
  syncRegistrationTabOrder(form);
}

function syncRegistrationTabOrder(form) {
  if (!form) return;
  const singleParticipant = isSingleParticipantClass(form.category.value);
  const submitButton = form.querySelector('button[type="submit"]');
  const clearButton = document.querySelector("#clear-form");
  const assignNextBoatButton = document.querySelector("#assign-next-boat");
  const orderedFields = [
    form.boatNumber,
    form.category,
    form.phone,
    form.racer1_given_name,
    form.racer1_family_name,
    ...(singleParticipant ? [] : [form.racer2_given_name, form.racer2_family_name]),
    form.checkedIn,
    form.paidStatus,
    form.sponsorName,
    form.sponsorship,
    form.notes,
    assignNextBoatButton,
    submitButton,
    clearButton,
  ].filter(Boolean);

  orderedFields.forEach((field, index) => {
    field.tabIndex = index + 1;
  });

  [form.racer2_given_name, form.racer2_family_name].forEach((field) => {
    if (!field) return;
    field.tabIndex = singleParticipant ? -1 : field.tabIndex;
  });
}

function teamSearchText(team) {
  const parts = [
    team.boatNumber,
    team.category,
    team.sponsorship,
    team.sponsorName,
    team.phone,
    team.checkedIn ? "checked in" : "not checked in",
    isPaid(team.paidStatus) ? "paid" : "not paid",
    team.racer1?.first,
    team.racer1?.last,
    team.racer2?.first,
    team.racer2?.last,
  ];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function getNextBoatNumber() {
  const numericBoats = state.teams
    .map((team) => normalizeBoat(team.boatNumber))
    .filter((boat) => /^\d+$/.test(boat))
    .map((boat) => Number(boat));
  const max = numericBoats.length ? Math.max(...numericBoats) : 0;
  return String(max + 1);
}

function loadTeamIntoRegistrationForm(team) {
  if (!team) return;
  const form = document.querySelector("#team-form");
  if (!form) return;
  form.boatNumber.value = team.boatNumber;
  ensureCategoryOption(form.category, normalizeCategoryName(team.category || ""));
  form.category.value = normalizeCategoryName(team.category || "");
  form.sponsorship.value = team.sponsorship || "";
  form.sponsorName.value = team.sponsorName || "";
  form.phone.value = team.phone || "";
  form.paidStatus.checked = isPaid(team.paidStatus);
  form.checkedIn.checked = Boolean(team.checkedIn);
  form.racer1_given_name.value = team.racer1?.first || "";
  form.racer1_family_name.value = team.racer1?.last || "";
  form.racer2_given_name.value = team.racer2?.first || "";
  form.racer2_family_name.value = team.racer2?.last || "";
  form.notes.value = normalizeRegistrationNotes(team.notes);
  setRegistrationNotesIndicatorVisible(hasRegistrationNotes(team));
  updateRacerFieldAvailability(form);
  state.editingTeamId = team.id;
}

function resetRegistrationForm({ assignNextBoat = false } = {}) {
  const form = document.querySelector("#team-form");
  if (!form) return;
  form.reset();
  form.paidStatus.checked = false;
  form.checkedIn.checked = false;
  if (assignNextBoat) {
    form.boatNumber.value = getNextBoatNumber();
  }
  setRegistrationNotesIndicatorVisible(false);
  updateRacerFieldAvailability(form);
  state.editingTeamId = null;
}

function displayTeamName(team) {
  const sponsorName = String(team?.sponsorName || "").trim();
  if (sponsorName) return sponsorName;

  const shortName = (racer) => {
    if (!racer) return "";
    const first = String(racer.first || "").trim();
    const last = String(racer.last || "").trim();
    const initial = first ? `${first[0].toUpperCase()}.` : "";
    return `${initial} ${last}`.trim();
  };

  const r1 = shortName(team.racer1);
  if (!team.racer2) return r1;
  const r2 = shortName(team.racer2);
  return [r1, r2].filter(Boolean).join(" & ");
}

function displayAwardTeamName(team) {
  const fullName = (racer) => {
    if (!racer) return "";
    const first = String(racer.first || "").trim();
    const last = String(racer.last || "").trim();
    return `${first} ${last}`.trim();
  };

  const r1 = fullName(team?.racer1);
  const r2 = fullName(team?.racer2);
  const joined = [r1, r2].filter(Boolean).join(" & ");
  return joined || displayTeamName(team);
}

function displayRegistrationMembers(team) {
  const fullName = (racer) => {
    if (!racer) return "";
    const first = String(racer.first || "").trim();
    const last = String(racer.last || "").trim();
    return `${first} ${last}`.trim();
  };
  const r1 = fullName(team?.racer1);
  const r2 = fullName(team?.racer2);
  return [r1, r2].filter(Boolean).join(" & ") || "-";
}

function toLocalInputValue(isoValue) {
  if (!isoValue) return "";
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return "";
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 19);
}

function parseDateInput(raw) {
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function parseDateInputOrNull(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toLocalTimeInputValue(isoValue) {
  if (!isoValue) return "";
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function withLocalTime(referenceIso, timeValue) {
  const match = String(timeValue || "").trim().match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const ss = Number(match[3] || 0);
  if (hh > 23 || mm > 59 || ss > 59) return null;

  const ref = new Date(referenceIso || Date.now());
  if (Number.isNaN(ref.getTime())) return null;
  ref.setHours(hh, mm, ss, 0);
  return ref.toISOString();
}

function parseBoatNumbers(raw) {
  const seen = new Set();
  return String(raw || "")
    .split(/[\s,;]+/)
    .map((value) => normalizeBoat(value))
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function currentRoundedSecondISO() {
  const now = Date.now();
  const roundedMs = Math.round(now / 1000) * 1000;
  return new Date(roundedMs).toISOString();
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function fitScorecardToViewport() {
  if (!isScorecardDisplayMode()) return;
  const groups = document.querySelector("#score-groups");
  if (!groups) return;
  groups.style.zoom = "1";
  groups.style.transform = "";
}

function formatClock(isoValue) {
  if (!isoValue) return "-";
  const d = new Date(isoValue);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "-";
  const s = Math.round(seconds);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatPenaltyMinutes(seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  return String(Math.max(minutes, 0));
}

function computeElapsedSeconds(team) {
  if (!team.startTime || !team.finishTime) return null;
  const diff = (new Date(team.finishTime).getTime() - new Date(team.startTime).getTime()) / 1000;
  if (!Number.isFinite(diff) || diff < 0) return null;
  return diff + (Number(team.penaltySeconds) || 0);
}

function isNonFinishNote(note) {
  const value = String(note || "").trim().toLowerCase();
  return ["dnf", "dq", "quit", "did not finish", "disqualified"].includes(value);
}

function getNowTimestamp() {
  return currentISOTime();
}

function updateSharedStateTimestamp(at = getNowTimestamp()) {
  state.sharedStateUpdatedAt = at;
  return at;
}

function touchTeam(team, at = getNowTimestamp()) {
  if (!team) return at;
  team.updatedAt = at;
  updateSharedStateTimestamp(at);
  return at;
}

function touchFinish(entry, at = getNowTimestamp()) {
  if (!entry) return at;
  entry.updatedAt = at;
  updateSharedStateTimestamp(at);
  return at;
}

function touchScorecardOrder(mode, at = getNowTimestamp()) {
  if (mode === "display") {
    state.scorecardCategoryOrderDisplayUpdatedAt = at;
  } else {
    state.scorecardCategoryOrderMainUpdatedAt = at;
  }
  updateSharedStateTimestamp(at);
  return at;
}

function buildPersistedState() {
  return {
    schemaVersion: SHARED_STATE_SCHEMA_VERSION,
    updatedAt: state.sharedStateUpdatedAt || getNowTimestamp(),
    teams: state.teams,
    finishes: state.finishes,
    scorecardCategoryOrderMain: state.scorecardCategoryOrderMain,
    scorecardCategoryOrderDisplay: state.scorecardCategoryOrderDisplay,
    scorecardCategoryOrderMainUpdatedAt: state.scorecardCategoryOrderMainUpdatedAt || state.sharedStateUpdatedAt || null,
    scorecardCategoryOrderDisplayUpdatedAt: state.scorecardCategoryOrderDisplayUpdatedAt || state.sharedStateUpdatedAt || null,
  };
}

function hasMeaningfulRaceData(source = buildPersistedState()) {
  return Array.isArray(source.teams) && source.teams.length
    || Array.isArray(source.finishes) && source.finishes.length
    || Array.isArray(source.scorecardCategoryOrderMain) && source.scorecardCategoryOrderMain.length
    || Array.isArray(source.scorecardCategoryOrderDisplay) && source.scorecardCategoryOrderDisplay.length;
}

function isMeaningfullyEmptyRaceData(source = buildPersistedState()) {
  return !hasMeaningfulRaceData(source);
}

function scorecardOrderUpdatedAt(mode, source) {
  if (mode === "display") {
    return normalizeTimestamp(source.scorecardCategoryOrderDisplayUpdatedAt, source.updatedAt || null);
  }
  return normalizeTimestamp(source.scorecardCategoryOrderMainUpdatedAt, source.updatedAt || null);
}

function chooseMoreRecentRecord(left, right) {
  if (!left) return right;
  if (!right) return left;

  const leftTime = Date.parse(left.updatedAt || 0);
  const rightTime = Date.parse(right.updatedAt || 0);
  if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) return right;
  if (Number.isNaN(leftTime)) return right;
  if (Number.isNaN(rightTime)) return left;
  return leftTime > rightTime ? left : right;
}

function mergeRecordArrays(remoteItems, localItems, fallbackKeyBuilder) {
  const merged = new Map();
  const remember = (item) => {
    if (!item || typeof item !== "object") return;
    const key = item.id || fallbackKeyBuilder(item);
    if (!key) return;
    merged.set(key, chooseMoreRecentRecord(merged.get(key), item));
  };

  remoteItems.forEach(remember);
  localItems.forEach(remember);

  return Array.from(merged.values());
}

function mergePersistedStates(remoteState, localState) {
  const remote = remoteState && typeof remoteState === "object" ? remoteState : {};
  const local = localState && typeof localState === "object" ? localState : {};
  const mergedUpdatedAt = [remote.updatedAt, local.updatedAt]
    .map((value) => normalizeTimestamp(value))
    .filter(Boolean)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .at(-1) || getNowTimestamp();

  const remoteMainOrderTime = scorecardOrderUpdatedAt("main", remote);
  const localMainOrderTime = scorecardOrderUpdatedAt("main", local);
  const remoteDisplayOrderTime = scorecardOrderUpdatedAt("display", remote);
  const localDisplayOrderTime = scorecardOrderUpdatedAt("display", local);

  return {
    schemaVersion: Math.max(
      Number(remote.schemaVersion) || 1,
      Number(local.schemaVersion) || 1,
      SHARED_STATE_SCHEMA_VERSION,
    ),
    updatedAt: mergedUpdatedAt,
    teams: mergeRecordArrays(remote.teams || [], local.teams || [], (team) => `boat:${normalizeBoat(team.boatNumber)}`),
    finishes: mergeRecordArrays(remote.finishes || [], local.finishes || [], (entry) => `finish:${entry.teamId || normalizeBoat(entry.boatNumber)}:${entry.capturedAt || entry.finishTime || ""}`),
    scorecardCategoryOrderMain:
      !remoteMainOrderTime || (localMainOrderTime && Date.parse(localMainOrderTime) >= Date.parse(remoteMainOrderTime))
        ? [...(local.scorecardCategoryOrderMain || [])]
        : [...(remote.scorecardCategoryOrderMain || [])],
    scorecardCategoryOrderDisplay:
      !remoteDisplayOrderTime || (localDisplayOrderTime && Date.parse(localDisplayOrderTime) >= Date.parse(remoteDisplayOrderTime))
        ? [...(local.scorecardCategoryOrderDisplay || [])]
        : [...(remote.scorecardCategoryOrderDisplay || [])],
    scorecardCategoryOrderMainUpdatedAt: localMainOrderTime && (!remoteMainOrderTime || Date.parse(localMainOrderTime) >= Date.parse(remoteMainOrderTime))
      ? localMainOrderTime
      : remoteMainOrderTime || mergedUpdatedAt,
    scorecardCategoryOrderDisplayUpdatedAt: localDisplayOrderTime && (!remoteDisplayOrderTime || Date.parse(localDisplayOrderTime) >= Date.parse(remoteDisplayOrderTime))
      ? localDisplayOrderTime
      : remoteDisplayOrderTime || mergedUpdatedAt,
  };
}

function renderSyncStatus() {
  const badge = document.querySelector("#shared-sync-status");
  if (!badge) return;

  badge.dataset.status = sharedStateSync.status;
  badge.textContent = sharedStateSync.message;
}

function setSharedSyncStatus(status, message) {
  sharedStateSync.status = status;
  sharedStateSync.message = message;
  renderSyncStatus();
}

function clonePersistedSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

function snapshotSignature(snapshot) {
  try {
    return JSON.stringify(snapshot || {});
  } catch {
    return "";
  }
}

function createEmptyPersistedState() {
  const now = getNowTimestamp();
  return {
    schemaVersion: SHARED_STATE_SCHEMA_VERSION,
    updatedAt: now,
    teams: [],
    finishes: [],
    scorecardCategoryOrderMain: [],
    scorecardCategoryOrderDisplay: [],
    scorecardCategoryOrderMainUpdatedAt: now,
    scorecardCategoryOrderDisplayUpdatedAt: now,
  };
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeStatePatch(patch) {
  const source = patch && typeof patch === "object" ? patch : {};
  const normalized = {
    updatedAt: normalizeTimestamp(source.updatedAt, getNowTimestamp()),
    upsertTeams: Array.isArray(source.upsertTeams)
      ? source.upsertTeams.map((team) => clonePersistedSnapshot(team)).filter(Boolean)
      : [],
    deleteTeamIds: Array.isArray(source.deleteTeamIds)
      ? source.deleteTeamIds.map((id) => String(id || "")).filter(Boolean)
      : [],
    upsertFinishes: Array.isArray(source.upsertFinishes)
      ? source.upsertFinishes.map((entry) => clonePersistedSnapshot(entry)).filter(Boolean)
      : [],
    deleteFinishIds: Array.isArray(source.deleteFinishIds)
      ? source.deleteFinishIds.map((id) => String(id || "")).filter(Boolean)
      : [],
  };

  if (Object.prototype.hasOwnProperty.call(source, "scorecardCategoryOrderMain")) {
    normalized.scorecardCategoryOrderMain = Array.isArray(source.scorecardCategoryOrderMain)
      ? [...source.scorecardCategoryOrderMain]
      : [];
  }
  if (Object.prototype.hasOwnProperty.call(source, "scorecardCategoryOrderDisplay")) {
    normalized.scorecardCategoryOrderDisplay = Array.isArray(source.scorecardCategoryOrderDisplay)
      ? [...source.scorecardCategoryOrderDisplay]
      : [];
  }
  if (Object.prototype.hasOwnProperty.call(source, "scorecardCategoryOrderMainUpdatedAt")) {
    normalized.scorecardCategoryOrderMainUpdatedAt = normalizeTimestamp(
      source.scorecardCategoryOrderMainUpdatedAt,
      normalized.updatedAt,
    );
  }
  if (Object.prototype.hasOwnProperty.call(source, "scorecardCategoryOrderDisplayUpdatedAt")) {
    normalized.scorecardCategoryOrderDisplayUpdatedAt = normalizeTimestamp(
      source.scorecardCategoryOrderDisplayUpdatedAt,
      normalized.updatedAt,
    );
  }

  return normalized;
}

function normalizeLocalEvent(event) {
  if (!event || typeof event !== "object") return null;
  const type = String(event.type || "");
  if (!["state_patch", "state_checkpoint"].includes(type)) return null;

  const normalized = {
    id: String(event.id || newId()),
    schemaVersion: LOCAL_EVENT_LOG_SCHEMA_VERSION,
    type,
    at: normalizeTimestamp(event.at, getNowTimestamp()),
    note: String(event.note || ""),
  };

  if (type === "state_checkpoint") {
    const snapshot = event.payload?.snapshot;
    if (!snapshot || typeof snapshot !== "object") return null;
    normalized.payload = {
      snapshot: clonePersistedSnapshot(snapshot),
    };
    return normalized;
  }

  normalized.payload = {
    patch: normalizeStatePatch(event.payload?.patch),
  };
  return normalized;
}

function persistLocalEventJournal() {
  try {
    if (!localEventJournal.events.length) {
      window.localStorage.removeItem(EVENT_LOG_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(EVENT_LOG_STORAGE_KEY, JSON.stringify(localEventJournal.events));
  } catch {
    // Ignore event journal persistence failures; latest snapshot storage still remains.
  }
}

function replaceLocalEventJournal(events) {
  localEventJournal.events = (Array.isArray(events) ? events : [])
    .map(normalizeLocalEvent)
    .filter(Boolean);
  persistLocalEventJournal();
  return localEventJournal.events;
}

function loadLocalEventJournal() {
  try {
    const raw = window.localStorage.getItem(EVENT_LOG_STORAGE_KEY);
    if (!raw) {
      localEventJournal.events = [];
      return localEventJournal.events;
    }
    return replaceLocalEventJournal(JSON.parse(raw));
  } catch {
    localEventJournal.events = [];
    return localEventJournal.events;
  }
}

function appendLocalEvent(event) {
  const normalized = normalizeLocalEvent(event);
  if (!normalized) return null;
  localEventJournal.events = [...localEventJournal.events, normalized];
  persistLocalEventJournal();
  return normalized;
}

function buildCheckpointEvent(snapshot, note = "") {
  return {
    id: newId(),
    schemaVersion: LOCAL_EVENT_LOG_SCHEMA_VERSION,
    type: "state_checkpoint",
    at: normalizeTimestamp(snapshot?.updatedAt, getNowTimestamp()),
    note,
    payload: {
      snapshot: clonePersistedSnapshot(snapshot),
    },
  };
}

function applyStatePatchToSnapshot(snapshot, patch) {
  const next = clonePersistedSnapshot(snapshot && typeof snapshot === "object" ? snapshot : createEmptyPersistedState());
  const normalizedPatch = normalizeStatePatch(patch);
  const deletedTeamIds = new Set(normalizedPatch.deleteTeamIds);
  const deletedFinishIds = new Set(normalizedPatch.deleteFinishIds);

  if (deletedTeamIds.size) {
    next.teams = next.teams.filter((team) => !deletedTeamIds.has(team.id));
    next.finishes = next.finishes.filter((entry) => !deletedTeamIds.has(entry.teamId));
  }
  if (deletedFinishIds.size) {
    next.finishes = next.finishes.filter((entry) => !deletedFinishIds.has(entry.id));
  }
  if (normalizedPatch.upsertTeams.length) {
    const teamMap = new Map(next.teams.map((team) => [team.id, team]));
    normalizedPatch.upsertTeams.forEach((team) => {
      if (team?.id) teamMap.set(team.id, clonePersistedSnapshot(team));
    });
    next.teams = Array.from(teamMap.values());
  }
  if (normalizedPatch.upsertFinishes.length) {
    const finishMap = new Map(next.finishes.map((entry) => [entry.id, entry]));
    normalizedPatch.upsertFinishes.forEach((entry) => {
      if (entry?.id) finishMap.set(entry.id, clonePersistedSnapshot(entry));
    });
    next.finishes = Array.from(finishMap.values());
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "scorecardCategoryOrderMain")) {
    next.scorecardCategoryOrderMain = [...normalizedPatch.scorecardCategoryOrderMain];
    next.scorecardCategoryOrderMainUpdatedAt = normalizedPatch.scorecardCategoryOrderMainUpdatedAt || normalizedPatch.updatedAt;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedPatch, "scorecardCategoryOrderDisplay")) {
    next.scorecardCategoryOrderDisplay = [...normalizedPatch.scorecardCategoryOrderDisplay];
    next.scorecardCategoryOrderDisplayUpdatedAt = normalizedPatch.scorecardCategoryOrderDisplayUpdatedAt || normalizedPatch.updatedAt;
  }
  next.updatedAt = normalizedPatch.updatedAt;
  return next;
}

function rebuildPersistedStateFromEventJournal(events = localEventJournal.events) {
  let snapshot = createEmptyPersistedState();
  let applied = false;

  (Array.isArray(events) ? events : []).forEach((event) => {
    const normalized = normalizeLocalEvent(event);
    if (!normalized) return;
    if (normalized.type === "state_checkpoint") {
      snapshot = clonePersistedSnapshot(normalized.payload.snapshot);
      applied = true;
      return;
    }
    snapshot = applyStatePatchToSnapshot(snapshot, normalized.payload.patch);
    applied = true;
  });

  return applied ? snapshot : null;
}

function ensureEventJournalBaseline(snapshot = buildPersistedState()) {
  if (localEventJournal.events.length || !hasMeaningfulRaceData(snapshot)) return;
  replaceLocalEventJournal([buildCheckpointEvent(snapshot, "seeded-from-local-snapshot")]);
}

function recordLocalStateChange(change, snapshot) {
  if (!change || typeof change !== "object") {
    ensureEventJournalBaseline(snapshot);
    return;
  }

  if (change.mode === "checkpoint") {
    if (Array.isArray(change.importedEventLog) && change.importedEventLog.length) {
      replaceLocalEventJournal(change.importedEventLog);
      appendLocalEvent(buildCheckpointEvent(snapshot, change.note || "imported-checkpoint"));
      return;
    }
    replaceLocalEventJournal([buildCheckpointEvent(snapshot, change.note || "")]);
    return;
  }

  const patch = normalizeStatePatch(change.patch);
  appendLocalEvent({
    id: newId(),
    schemaVersion: LOCAL_EVENT_LOG_SCHEMA_VERSION,
    type: "state_patch",
    at: patch.updatedAt || snapshot?.updatedAt || getNowTimestamp(),
    note: change.note || "",
    payload: { patch },
  });
}

function loadBestLocalSnapshot() {
  const snapshot = loadState();
  loadLocalEventJournal();

  if (snapshot && !localEventJournal.events.length && hasMeaningfulRaceData(snapshot)) {
    ensureEventJournalBaseline(snapshot);
    return snapshot;
  }

  const replayed = rebuildPersistedStateFromEventJournal();
  if (!replayed) return snapshot;
  if (!snapshot || timestampMs(replayed.updatedAt) > timestampMs(snapshot.updatedAt)) {
    applyPersistedState(replayed);
    persistLocalCache(replayed);
    return buildPersistedState();
  }
  if (snapshot && timestampMs(snapshot.updatedAt) > timestampMs(replayed.updatedAt)) {
    replaceLocalEventJournal([buildCheckpointEvent(snapshot, "resynced-from-local-snapshot")]);
  }
  return snapshot;
}

function getOperatorSyncSecret() {
  try {
    return String(window.localStorage.getItem(OPERATOR_SYNC_SECRET_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

function hasOperatorSyncSecret() {
  return Boolean(getOperatorSyncSecret());
}

function isOperatorSyncEnabled() {
  try {
    const raw = String(window.localStorage.getItem(OPERATOR_SYNC_ENABLED_STORAGE_KEY) || "").trim().toLowerCase();
    return raw ? !["0", "false", "off", "no"].includes(raw) : true;
  } catch {
    return true;
  }
}

function saveOperatorSyncEnabled(enabled) {
  try {
    window.localStorage.setItem(OPERATOR_SYNC_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore local preference persistence failures.
  }
}

function normalizeQueuedSyncEntry(entry) {
  if (!entry || typeof entry !== "object" || !entry.state || typeof entry.state !== "object") return null;
  return {
    id: String(entry.id || newId()),
    queuedAt: normalizeTimestamp(entry.queuedAt, getNowTimestamp()),
    baseSnapshotId: typeof entry.baseSnapshotId === "string" ? entry.baseSnapshotId : null,
    state: clonePersistedSnapshot(entry.state),
  };
}

function persistSyncQueue() {
  try {
    if (!sharedStateSync.queue.length) {
      window.localStorage.removeItem(SYNC_QUEUE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SYNC_QUEUE_STORAGE_KEY, JSON.stringify(sharedStateSync.queue));
  } catch {
    // Ignore localStorage failures; race operations should continue.
  }
}

function loadSyncQueue() {
  try {
    const raw = window.localStorage.getItem(SYNC_QUEUE_STORAGE_KEY);
    if (!raw) {
      sharedStateSync.queue = [];
      return sharedStateSync.queue;
    }

    const parsed = JSON.parse(raw);
    sharedStateSync.queue = (Array.isArray(parsed) ? parsed : [parsed])
      .map(normalizeQueuedSyncEntry)
      .filter(Boolean)
      .slice(-1);
    persistSyncQueue();
    return sharedStateSync.queue;
  } catch {
    sharedStateSync.queue = [];
    return sharedStateSync.queue;
  }
}

function getPendingSyncEntry() {
  return sharedStateSync.queue.at(-1) || null;
}

function hasPendingSyncQueue() {
  return Boolean(getPendingSyncEntry());
}

function clearPendingSyncQueue() {
  sharedStateSync.queue = [];
  persistSyncQueue();
}

function queuePendingSyncSnapshot(snapshot = buildPersistedState()) {
  const nextSignature = snapshotSignature(snapshot);
  const existing = getPendingSyncEntry();
  const existingSignature = existing ? snapshotSignature(existing.state) : "";
  if (nextSignature && (nextSignature === existingSignature || nextSignature === sharedStateSync.lastPublishedSignature)) {
    return false;
  }
  sharedStateSync.queue = [{
    id: newId(),
    queuedAt: getNowTimestamp(),
    baseSnapshotId: sharedStateSync.snapshotId || existing?.baseSnapshotId || null,
    state: clonePersistedSnapshot(snapshot),
  }];
  persistSyncQueue();
  return true;
}

function setOfflineSyncStatus() {
  if (hasPendingSyncQueue()) {
    setSharedSyncStatus("offline", "Offline - cloud sync queued");
    return;
  }
  setSharedSyncStatus("offline", "Shared sync offline");
}

function saveOperatorSyncSecret(secret) {
  try {
    if (secret) {
      window.localStorage.setItem(OPERATOR_SYNC_SECRET_STORAGE_KEY, secret);
    } else {
      window.localStorage.removeItem(OPERATOR_SYNC_SECRET_STORAGE_KEY);
    }
  } catch {
    // Ignore localStorage failures; sync will remain read-only.
  }
}

function connectedSyncStatus() {
  if (!isOperatorSyncEnabled()) {
    return { status: "paused", message: "Sync paused" };
  }
  if (hasPendingSyncQueue() && (hasOperatorSyncSecret() || isProxyManagedSyncEnabled())) {
    return { status: "queued", message: "Cloud sync queued" };
  }
  return hasOperatorSyncSecret() || isProxyManagedSyncEnabled()
    ? {
      status: "live",
      message: isProxyManagedSyncEnabled() ? "Shared data live (local proxy)" : "Shared data live",
    }
    : { status: "readonly", message: "Connected - set sync key to publish" };
}

function applyConnectedSyncStatus() {
  const next = connectedSyncStatus();
  setSharedSyncStatus(next.status, next.message);
}

function renderShellState() {
  const shell = document.querySelector("#app-shell");
  const syncKeyButton = document.querySelector("#sync-key-button");
  const syncToggleButton = document.querySelector("#sync-toggle-button");
  const body = document.body;
  if (!shell || !body) return;

  const publicMode = isPublicScorecardMode() || isScorecardDisplayMode();
  shell.hidden = false;
  body.classList.toggle("public-scorecard-mode", publicMode);

  if (syncKeyButton) {
    syncKeyButton.hidden = publicMode || isProxyManagedSyncEnabled();
    syncKeyButton.textContent = hasOperatorSyncSecret() ? "Update Sync Key" : "Set Sync Key";
  }
  if (syncToggleButton) {
    const showToggle = !publicMode && (hasOperatorSyncSecret() || isProxyManagedSyncEnabled());
    syncToggleButton.hidden = !showToggle;
    syncToggleButton.textContent = isOperatorSyncEnabled() ? "Pause Sync" : "Sync paused";
  }
}

function activeSharedStateApiPath() {
  return isPublicScorecardMode() || isScorecardDisplayMode()
    ? PUBLIC_SCORECARD_API_PATH
    : SHARED_STATE_API_PATH;
}

function sharedStatePollIntervalMs() {
  return isPublicScorecardMode() || isScorecardDisplayMode()
    ? PUBLIC_SHARED_STATE_POLL_MS
    : OPERATOR_SHARED_STATE_POLL_MS;
}

function shouldUseLocalStateBroadcast() {
  return !isPublicScorecardMode() || isScorecardDisplayMode();
}

function applySharedSnapshot(result) {
  if (!result || typeof result !== "object" || !result.state) return false;
  const snapshotId = typeof result.snapshotId === "string" ? result.snapshotId : sharedStateSync.snapshotId;
  applyPersistedState(result.state);
  sharedStateSync.snapshotId = snapshotId || null;
  sharedStateSync.lastPublishedSignature = snapshotSignature(buildPersistedState());
  persistLocalCache();
  return true;
}

async function fetchSharedStateSnapshot(options = {}) {
  const {
    silent = false,
  } = options;
  const url = new URL(activeSharedStateApiPath(), window.location.origin);
  if (sharedStateSync.snapshotId) {
    url.searchParams.set("since", sharedStateSync.snapshotId);
  }

  const headers = {
    Accept: "application/json",
  };
  if (!isPublicScorecardMode() && !isScorecardDisplayMode() && !isProxyManagedSyncEnabled()) {
    const operatorSyncSecret = getOperatorSyncSecret();
    if (operatorSyncSecret) headers["X-Operator-Secret"] = operatorSyncSecret;
  }

  const response = await fetch(url.toString(), {
    cache: "no-store",
    credentials: "same-origin",
    headers,
  });

  if (response.status === 204) {
    if (!silent) applyConnectedSyncStatus();
    return { changed: false };
  }

  if (!response.ok) {
    throw new Error(`Shared state fetch failed (${response.status}).`);
  }

  const payload = await response.json();
  const preservePendingLocalState = !isPublicScorecardMode()
    && !isScorecardDisplayMode()
    && hasPendingSyncQueue();
  if (preservePendingLocalState) {
    sharedStateSync.snapshotId = typeof payload.snapshotId === "string"
      ? payload.snapshotId
      : sharedStateSync.snapshotId;
    if (!silent) applyConnectedSyncStatus();
    return { changed: false, payload };
  }

  const changed = applySharedSnapshot(payload);
  if (!silent) applyConnectedSyncStatus();
  return { changed, payload };
}

function scheduleSharedStatePolling() {
  if (sharedStateSync.pollTimerId) window.clearInterval(sharedStateSync.pollTimerId);
  sharedStateSync.pollTimerId = window.setInterval(async () => {
    if (!sharedStateSync.enabled || sharedStateSync.saveInFlight) return;
    try {
      const result = await fetchSharedStateSnapshot({ silent: true });
      if (result.changed) renderAll();
      renderSyncStatus();
    } catch {
      setOfflineSyncStatus();
    }
  }, sharedStatePollIntervalMs());
}

async function flushSharedStateSave() {
  if (!sharedStateSync.enabled || sharedStateSync.saveInFlight || isPublicScorecardMode() || isScorecardDisplayMode()) return;
  const pending = getPendingSyncEntry();
  if (!pending) {
    applyConnectedSyncStatus();
    return;
  }
  if (!isOperatorSyncEnabled()) {
    applyConnectedSyncStatus();
    return;
  }
  const operatorSyncSecret = getOperatorSyncSecret();
  if (!operatorSyncSecret && !isProxyManagedSyncEnabled()) {
    applyConnectedSyncStatus();
    return;
  }

  sharedStateSync.saveInFlight = true;
  setSharedSyncStatus("syncing", "Syncing shared data...");
  const localSnapshot = pending.state;

  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (operatorSyncSecret && !isProxyManagedSyncEnabled()) {
      headers["X-Operator-Secret"] = operatorSyncSecret;
    }

    const response = await fetch(SHARED_STATE_API_PATH, {
      method: "PUT",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        baseSnapshotId: pending.baseSnapshotId || sharedStateSync.snapshotId,
        state: localSnapshot,
      }),
    });

    if (response.status === 409) {
      const conflict = await response.json();
      const merged = mergePersistedStates(conflict.state, localSnapshot);
      sharedStateSync.snapshotId = conflict.snapshotId || sharedStateSync.snapshotId;
      applyPersistedState(merged);
      persistLocalCache(merged);
      queuePendingSyncSnapshot(merged);
      if (!sharedStateSync.conflictNotified) {
        sharedStateSync.conflictNotified = true;
        alert("Another device updated the shared race data. The app merged the latest shared state and is retrying your change.");
      }
      renderAll();
      return;
    }

    if (response.status === 403) {
      setSharedSyncStatus("offline", "Sync key rejected");
      return;
    }

    if (!response.ok) {
      throw new Error(`Shared state save failed (${response.status}).`);
    }

    sharedStateSync.conflictNotified = false;
    const payload = await response.json();
    clearPendingSyncQueue();
    applySharedSnapshot(payload);
    applyConnectedSyncStatus();
  } catch {
    setOfflineSyncStatus();
  } finally {
    sharedStateSync.saveInFlight = false;
    if (sharedStateSync.saveQueued) {
      sharedStateSync.saveQueued = false;
      void flushSharedStateSave();
    }
  }
}

function queueSharedStateSave() {
  if (!sharedStateSync.enabled) return Promise.resolve();
  if (sharedStateSync.saveTimerId) {
    window.clearTimeout(sharedStateSync.saveTimerId);
    sharedStateSync.saveTimerId = null;
  }
  if (sharedStateSync.saveInFlight) {
    sharedStateSync.saveQueued = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    sharedStateSync.saveTimerId = window.setTimeout(() => {
      sharedStateSync.saveTimerId = null;
      resolve(flushSharedStateSave());
    }, SHARED_STATE_SAVE_DEBOUNCE_MS);
  });
}

async function initializeSharedStateSync(localSnapshot) {
  if (sharedStateSync.initializing) return;
  sharedStateSync.initializing = true;
  setSharedSyncStatus("syncing", "Connecting shared data...");

  try {
    const remote = await fetchSharedStateSnapshot();
    sharedStateSync.enabled = true;
    const remoteState = remote.payload?.state || buildPersistedState();
    const pending = getPendingSyncEntry();
    const pendingState = pending?.state || null;

    if (!isPublicScorecardMode() && !isScorecardDisplayMode() && pendingState && hasMeaningfulRaceData(pendingState)) {
      applyPersistedState(pendingState);
      persistLocalCache(pendingState);
      renderAll();
    } else if (!isPublicScorecardMode() && !isScorecardDisplayMode() && isMeaningfullyEmptyRaceData(remoteState) && hasMeaningfulRaceData(localSnapshot)) {
      applyPersistedState(localSnapshot);
      persistLocalCache(localSnapshot);
      queuePendingSyncSnapshot(localSnapshot);
      renderAll();
    } else if (remote.changed) {
      renderAll();
    }

    scheduleSharedStatePolling();
    applyConnectedSyncStatus();
    if (!isPublicScorecardMode() && !isScorecardDisplayMode() && hasPendingSyncQueue() && (hasOperatorSyncSecret() || isProxyManagedSyncEnabled())) {
      void queueSharedStateSave();
    }
  } catch {
    sharedStateSync.enabled = false;
    setSharedSyncStatus("local", "Browser-only data");
  } finally {
    sharedStateSync.initializing = false;
    renderSyncStatus();
  }
}

function setupSyncControls() {
  const syncKeyButton = document.querySelector("#sync-key-button");
  const syncToggleButton = document.querySelector("#sync-toggle-button");
  if (syncKeyButton) {
    syncKeyButton.addEventListener("click", () => {
      const currentValue = getOperatorSyncSecret();
      const nextValue = window.prompt(
        "Enter the operator sync key used for cloud writes. Leave blank to clear the saved key on this laptop.",
        currentValue,
      );
      if (nextValue === null) return;

      saveOperatorSyncSecret(String(nextValue).trim());
      renderShellState();
      if (sharedStateSync.enabled) {
        applyConnectedSyncStatus();
        void queueSharedStateSave();
      }
    });
  }
  if (syncToggleButton) {
    syncToggleButton.addEventListener("click", () => {
      const nextEnabled = !isOperatorSyncEnabled();
      saveOperatorSyncEnabled(nextEnabled);
      renderShellState();
      if (sharedStateSync.enabled) {
        applyConnectedSyncStatus();
        if (nextEnabled && hasPendingSyncQueue() && (hasOperatorSyncSecret() || isProxyManagedSyncEnabled())) {
          void queueSharedStateSave();
        }
      } else {
        renderSyncStatus();
      }
    });
  }
}

function getScorecardSyncChannel() {
  if (typeof window === "undefined" || typeof window.BroadcastChannel !== "function") return null;
  if (!scorecardSyncChannel) {
    scorecardSyncChannel = new window.BroadcastChannel(SCORECARD_SYNC_CHANNEL_NAME);
  }
  return scorecardSyncChannel;
}

function syncScorecardDisplayState() {
  const payload = {
    type: SCORECARD_SYNC_MESSAGE_TYPE,
    sourceId: WINDOW_INSTANCE_ID,
    state: buildPersistedState(),
  };

  try {
    if (scorecardDisplayWindow && !scorecardDisplayWindow.closed) {
      scorecardDisplayWindow.postMessage(payload, window.location.origin);
    }
  } catch {
    // Ignore direct messaging failures and fall back to shared browser channels.
  }

  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(payload, window.location.origin);
    }
  } catch {
    // Ignore opener messaging failures and fall back to shared browser channels.
  }

  try {
    getScorecardSyncChannel()?.postMessage(payload);
  } catch {
    // Ignore broadcast channel failures.
  }
}

function persistLocalCache(snapshot = buildPersistedState()) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore local cache failures; race operations should continue in-memory.
  }
}

function persistSnapshotAndSync(snapshot = buildPersistedState()) {
  persistLocalCache(snapshot);
  const queued = queuePendingSyncSnapshot(snapshot);
  syncScorecardDisplayState();
  if (queued) {
    void queueSharedStateSave();
  }
}

function saveState(change = null) {
  updateSharedStateTimestamp();
  const snapshot = buildPersistedState();
  recordLocalStateChange(change, snapshot);
  persistSnapshotAndSync(snapshot);
}

function saveStatePatch(patch, note = "") {
  saveState({
    mode: "patch",
    note,
    patch,
  });
}

function saveStateCheckpoint(note = "", importedEventLog = null) {
  saveState({
    mode: "checkpoint",
    note,
    importedEventLog,
  });
}

function applyPersistedState(parsed) {
  const source = parsed && typeof parsed.data === "object" ? parsed.data : parsed;
  if (!source || typeof source !== "object") {
    throw new Error("Backup file is not valid.");
  }

  const rawFinishes = Array.isArray(source.finishes) ? source.finishes : [];
  state.finishes = rawFinishes.map((entry) => ({
    ...entry,
    id: entry.id || newId(),
    boatNumber: normalizeBoat(entry.boatNumber),
    penaltySeconds: Number.isFinite(Number(entry.penaltySeconds)) ? Number(entry.penaltySeconds) : 0,
    didNotFinish: Boolean(entry.didNotFinish) || isNonFinishNote(entry.notes),
    notes: entry.notes || "",
    capturedAt: entry.capturedAt || entry.finishTime || getNowTimestamp(),
    updatedAt: normalizeTimestamp(entry.updatedAt, entry.capturedAt || entry.finishTime || source.updatedAt || getNowTimestamp()),
  }));

  state.teams = Array.isArray(source.teams)
    ? source.teams.map((team) => {
        const latestFinish = state.finishes
          .filter((entry) => entry.teamId === team.id)
          .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt))
          .at(-1);
        return {
          ...team,
          id: team.id || newId(),
          boatNumber: normalizeBoat(team.boatNumber),
          category: normalizeCategoryName(team.category),
          sponsorship: team.sponsorship || "",
          sponsorName: team.sponsorName || "",
          phone: team.phone || "",
          notes: normalizeRegistrationNotes(team.notes),
          paidStatus: isPaid(team.paidStatus),
          checkedIn: Boolean(team.checkedIn),
          racer1: {
            first: team.racer1?.first || "",
            last: team.racer1?.last || "",
          },
          racer2: team.racer2
            ? {
                first: team.racer2.first || "",
                last: team.racer2.last || "",
              }
            : null,
          startTime: team.startTime || null,
          finishTime: team.finishTime || null,
          penaltySeconds: Number.isFinite(Number(team.penaltySeconds)) ? Number(team.penaltySeconds) : 0,
          didNotFinish: Boolean(team.didNotFinish) || Boolean(latestFinish?.didNotFinish),
          updatedAt: normalizeTimestamp(team.updatedAt, latestFinish?.updatedAt || source.updatedAt || getNowTimestamp()),
        };
      })
    : [];

  const boatToTeamId = new Map(state.teams.map((team) => [normalizeBoat(team.boatNumber), team.id]));
  state.finishes = state.finishes.map((entry) => ({
    ...entry,
    teamId: entry.teamId || boatToTeamId.get(normalizeBoat(entry.boatNumber)) || null,
  }));
  const syntheticFinishes = state.teams
    .filter((team) => {
      if (!team.id) return false;
      if (!team.finishTime && !team.didNotFinish) return false;
      return !state.finishes.some((entry) => entry.teamId === team.id);
    })
    .map((team) => ({
      id: newId(),
      teamId: team.id,
      boatNumber: normalizeBoat(team.boatNumber),
      finishTime: team.didNotFinish ? null : team.finishTime || null,
      penaltySeconds: Number.isFinite(Number(team.penaltySeconds)) ? Number(team.penaltySeconds) : 0,
      didNotFinish: Boolean(team.didNotFinish),
      notes: team.didNotFinish ? "Recovered from team state" : "",
      capturedAt: team.finishTime || team.updatedAt || source.updatedAt || getNowTimestamp(),
      updatedAt: normalizeTimestamp(team.updatedAt, team.finishTime || source.updatedAt || getNowTimestamp()),
    }));
  if (syntheticFinishes.length) {
    state.finishes = [...state.finishes, ...syntheticFinishes];
  }
  state.teams = state.teams.map((team) => {
    const latestFinish = state.finishes
      .filter((entry) => entry.teamId === team.id)
      .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt))
      .at(-1);
    return {
      ...team,
      didNotFinish: Boolean(team.didNotFinish) || Boolean(latestFinish?.didNotFinish),
    };
  });

  state.scorecardCategoryOrderMain = Array.isArray(source.scorecardCategoryOrderMain)
    ? source.scorecardCategoryOrderMain
    : Array.isArray(source.scorecardCategoryOrder)
      ? source.scorecardCategoryOrder
      : [];
  state.scorecardCategoryOrderDisplay = Array.isArray(source.scorecardCategoryOrderDisplay)
    ? source.scorecardCategoryOrderDisplay
    : Array.isArray(source.scorecardCategoryOrder)
      ? source.scorecardCategoryOrder
      : [];
  state.scorecardCategoryOrderMainUpdatedAt = normalizeTimestamp(source.scorecardCategoryOrderMainUpdatedAt, source.updatedAt || getNowTimestamp());
  state.scorecardCategoryOrderDisplayUpdatedAt = normalizeTimestamp(source.scorecardCategoryOrderDisplayUpdatedAt, source.updatedAt || getNowTimestamp());
  state.sharedStateUpdatedAt = normalizeTimestamp(source.updatedAt, getNowTimestamp());
}

function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    applyPersistedState(JSON.parse(raw));
    return buildPersistedState();
  } catch {
    // Ignore malformed storage.
    return null;
  }
}

function findTeamByBoat(boatNumber) {
  const key = normalizeBoat(boatNumber);
  return state.teams.find((t) => normalizeBoat(t.boatNumber) === key) || null;
}

function hasFinishEntry(teamId) {
  return state.finishes.some((entry) => entry.teamId === teamId);
}

function deleteTeam(teamId) {
  state.teams = state.teams.filter((t) => t.id !== teamId);
  state.finishes = state.finishes.filter((f) => f.teamId !== teamId);
  saveStatePatch({
    deleteTeamIds: [teamId],
    updatedAt: state.sharedStateUpdatedAt || getNowTimestamp(),
  }, "team-deleted");
  renderAll();
}

function clearTeamFinish(team) {
  if (!team) return;
  const at = getNowTimestamp();
  team.finishTime = null;
  team.penaltySeconds = 0;
  team.didNotFinish = false;
  touchTeam(team, at);
}

function applyFinishEntryToTeam(team, entry) {
  if (!team || !entry) return;
  team.finishTime = entry.finishTime;
  team.penaltySeconds = Number(entry.penaltySeconds) || 0;
  team.didNotFinish = Boolean(entry.didNotFinish);
  touchTeam(team, entry.updatedAt || getNowTimestamp());
}

function reconcileTeamFinish(teamId) {
  const team = state.teams.find((t) => t.id === teamId);
  if (!team) return;
  const entries = state.finishes
    .filter((entry) => entry.teamId === teamId)
    .sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
  if (!entries.length) {
    clearTeamFinish(team);
    return;
  }
  applyFinishEntryToTeam(team, entries[entries.length - 1]);
}

function deleteFinishEntry(entryId) {
  const idx = state.finishes.findIndex((entry) => entry.id === entryId);
  if (idx < 0) return;
  const [removed] = state.finishes.splice(idx, 1);
  reconcileTeamFinish(removed.teamId);
  const team = state.teams.find((item) => item.id === removed.teamId);
  saveStatePatch({
    deleteFinishIds: [removed.id],
    upsertTeams: team ? [team] : [],
    updatedAt: state.sharedStateUpdatedAt || removed.updatedAt || getNowTimestamp(),
  }, "finish-deleted");
  renderAll();
}

function editFinishEntry(entryId) {
  const entry = state.finishes.find((item) => item.id === entryId);
  if (!entry) return;
  const modal = document.querySelector("#finish-edit-modal");
  const form = document.querySelector("#finish-edit-form");
  if (!modal || !form) return;

  state.editingFinishId = entry.id;
  form.boatNumber.value = entry.boatNumber;
  form.finishTime.value = toLocalTimeInputValue(entry.finishTime);
  form.penaltyMinutes.value = formatPenaltyMinutes(entry.penaltySeconds);
  form.dnf.checked = Boolean(entry.didNotFinish);
  form.notes.value = entry.notes || "";
  modal.classList.remove("hidden");
  form.boatNumber.focus();
}

function editStartEntry(teamId) {
  const team = state.teams.find((item) => item.id === teamId);
  if (!team || !team.startTime) return;
  const modal = document.querySelector("#start-edit-modal");
  const form = document.querySelector("#start-edit-form");
  if (!modal || !form) return;

  state.editingStartTeamId = team.id;
  form.boatNumber.value = team.boatNumber;
  form.startTime.value = toLocalTimeInputValue(team.startTime);
  modal.classList.remove("hidden");
  form.boatNumber.focus();
}

function closeStartEditModal() {
  const modal = document.querySelector("#start-edit-modal");
  const form = document.querySelector("#start-edit-form");
  if (!modal || !form) return;
  state.editingStartTeamId = null;
  form.reset();
  modal.classList.add("hidden");
}

function deleteStartEntry(teamId) {
  const team = state.teams.find((item) => item.id === teamId);
  if (!team || !team.startTime) return;
  const at = getNowTimestamp();
  const removedFinishIds = [];

  if (team.finishTime) {
    if (!window.confirm(`Boat ${team.boatNumber} already has a finish. Delete both start and finish records?`)) return;
    team.finishTime = null;
    team.penaltySeconds = 0;
    team.didNotFinish = false;
    state.finishes = state.finishes.filter((entry) => {
      if (entry.teamId !== team.id) return true;
      removedFinishIds.push(entry.id);
      return false;
    });
  }

  team.startTime = null;
  touchTeam(team, at);
  saveStatePatch({
    upsertTeams: [team],
    deleteFinishIds: removedFinishIds,
    updatedAt: at,
  }, "start-deleted");
  renderAll();
}

function setupStartEditModal() {
  const modal = document.querySelector("#start-edit-modal");
  const form = document.querySelector("#start-edit-form");
  if (!modal || !form) return;

  const cancelButton = document.querySelector("#cancel-start-edit");
  const closeButton = document.querySelector("#close-start-edit");
  const close = () => closeStartEditModal();
  if (cancelButton) cancelButton.addEventListener("click", close);
  if (closeButton) closeButton.addEventListener("click", close);

  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
      close();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const currentTeam = state.teams.find((item) => item.id === state.editingStartTeamId);
    if (!currentTeam) {
      close();
      return;
    }

    const boatNumber = normalizeBoat(form.boatNumber.value);
    const targetTeam = findTeamByBoat(boatNumber);
    if (!targetTeam) {
      alert(`Boat ${boatNumber} not found.`);
      return;
    }

    const duplicateStart = state.teams.some((team) => team.id !== currentTeam.id && team.id === targetTeam.id && team.startTime);
    if (duplicateStart) {
      alert(`Boat ${boatNumber} already has a start entry.`);
      return;
    }

    const startTime = withLocalTime(currentTeam.startTime || new Date().toISOString(), form.startTime.value);
    if (!startTime) {
      alert("Start time must be in HH:MM or HH:MM:SS format.");
      form.startTime.focus();
      return;
    }

    const removedFinishIds = [];
    if (targetTeam.id !== currentTeam.id) {
      // Move the start record to a different boat.
      const at = getNowTimestamp();
      currentTeam.startTime = null;
      if (currentTeam.finishTime) {
        currentTeam.finishTime = null;
        currentTeam.penaltySeconds = 0;
        currentTeam.didNotFinish = false;
        state.finishes = state.finishes.filter((entry) => {
          if (entry.teamId !== currentTeam.id) return true;
          removedFinishIds.push(entry.id);
          return false;
        });
      }
      touchTeam(currentTeam, at);
    }

    targetTeam.startTime = startTime;
    if (targetTeam.finishTime && new Date(targetTeam.finishTime) < new Date(targetTeam.startTime)) {
      targetTeam.finishTime = null;
      targetTeam.penaltySeconds = 0;
      targetTeam.didNotFinish = false;
      state.finishes = state.finishes.filter((entry) => {
        if (entry.teamId !== targetTeam.id) return true;
        removedFinishIds.push(entry.id);
        return false;
      });
    }
    touchTeam(targetTeam);

    const upsertTeams = targetTeam.id !== currentTeam.id
      ? [currentTeam, targetTeam]
      : [targetTeam];
    saveStatePatch({
      upsertTeams,
      deleteFinishIds: removedFinishIds,
      updatedAt: state.sharedStateUpdatedAt || getNowTimestamp(),
    }, "start-edited");
    renderAll();
    close();
  });
}

function closeFinishEditModal() {
  const modal = document.querySelector("#finish-edit-modal");
  const form = document.querySelector("#finish-edit-form");
  if (!modal || !form) return;
  state.editingFinishId = null;
  form.reset();
  form.penaltyMinutes.value = 0;
  form.dnf.checked = false;
  modal.classList.add("hidden");
}

function setupFinishEditModal() {
  const modal = document.querySelector("#finish-edit-modal");
  const form = document.querySelector("#finish-edit-form");
  if (!modal || !form) return;

  const cancelButton = document.querySelector("#cancel-finish-edit");
  const closeButton = document.querySelector("#close-finish-edit");

  const close = () => closeFinishEditModal();
  if (cancelButton) cancelButton.addEventListener("click", close);
  if (closeButton) closeButton.addEventListener("click", close);

  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
      close();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const entry = state.finishes.find((item) => item.id === state.editingFinishId);
    if (!entry) {
      close();
      return;
    }

    const boatNumber = normalizeBoat(form.boatNumber.value);
    const team = findTeamByBoat(boatNumber);
    if (!team) {
      alert(`Boat ${boatNumber} not found.`);
      return;
    }

    const duplicateForTeam = state.finishes.some((item) => item.id !== entry.id && item.teamId === team.id);
    if (duplicateForTeam) {
      alert(`Boat ${boatNumber} already has a finish entry.`);
      return;
    }

    const didNotFinish = Boolean(form.dnf.checked);
    const finishTime = didNotFinish
      ? null
      : withLocalTime(entry.finishTime || new Date().toISOString(), form.finishTime.value);
    if (!didNotFinish && !finishTime) {
      alert("Finish time must be in HH:MM or HH:MM:SS format.");
      form.finishTime.focus();
      return;
    }

    const penaltyMinutes = Number(form.penaltyMinutes.value);
    if (!Number.isFinite(penaltyMinutes) || penaltyMinutes < 0 || !Number.isInteger(penaltyMinutes)) {
      alert("Penalty minutes must be a whole number (0 or greater).");
      form.penaltyMinutes.focus();
      return;
    }

    const originalTeamId = entry.teamId;
    const at = getNowTimestamp();
    entry.teamId = team.id;
    entry.boatNumber = team.boatNumber;
    entry.finishTime = finishTime;
    entry.penaltySeconds = penaltyMinutes * 60;
    entry.didNotFinish = didNotFinish;
    entry.notes = form.notes.value.trim();
    touchFinish(entry, at);

    if (finishTime && !team.startTime) {
      team.startTime = new Date(new Date(finishTime).getTime() - 60 * 60 * 1000).toISOString();
    }
    touchTeam(team, at);

    reconcileTeamFinish(originalTeamId);
    reconcileTeamFinish(team.id);
    const patchedTeams = originalTeamId && originalTeamId !== team.id
      ? [team, ...state.teams.filter((item) => item.id === originalTeamId)]
      : [team];
    saveStatePatch({
      upsertTeams: patchedTeams,
      upsertFinishes: [entry],
      updatedAt: at,
    }, "finish-edited");
    renderAll();
    close();
  });
}

function renderTabs() {
  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.tab;
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === button));
      document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === target));
    });
  });
}

function renderCategories() {
  // Categories are now a fixed dropdown in the registration form.
}

function renderRegistrationTable() {
  const tbody = document.querySelector("#registration-table tbody");
  const allTeams = [...state.teams].sort((a, b) => normalizeBoat(a.boatNumber).localeCompare(normalizeBoat(b.boatNumber), undefined, { numeric: true }));
  const query = String(state.registrationQuery || "").trim().toLowerCase();
  const statusFilter = String(state.registrationFilter || "all");
  const matchesFilter = (team) => {
    if (statusFilter === "checked-in") return Boolean(team.checkedIn);
    if (statusFilter === "not-checked-in") return !team.checkedIn;
    if (statusFilter === "ready") return Boolean(team.checkedIn) && !team.startTime && !team.finishTime;
    if (statusFilter === "racing") return Boolean(team.startTime) && !team.finishTime && !team.didNotFinish;
    if (statusFilter === "finished") return Boolean(team.finishTime) || Boolean(team.didNotFinish);
    return true;
  };
  const teams = allTeams.filter((team) => {
    if (query && !teamSearchText(team).includes(query)) return false;
    return matchesFilter(team);
  });
  const summary = document.querySelector("#registration-search-summary");
  if (summary) {
    const filterLabel = statusFilter === "all" ? "all statuses" : statusFilter.replaceAll("-", " ");
    summary.textContent = `${teams.length} of ${allTeams.length} team(s) shown (${filterLabel}).`;
  }

  if (!teams.length) {
    tbody.innerHTML = '<tr><td colspan="6">No teams match your search.</td></tr>';
    return;
  }

  tbody.innerHTML = teams
    .map((team) => {
      const status = team.didNotFinish ? "DNF" : team.finishTime ? "Finished" : team.startTime ? "Racing" : "Ready";
      return `
        <tr>
          <td><span class="boat-number-with-indicator">${team.boatNumber}${renderNotesIndicator(team)}</span></td>
          <td>${displayRegistrationMembers(team)}</td>
          <td>${team.category || "-"}</td>
          <td>${team.checkedIn ? "Yes" : "No"}</td>
          <td>${status}</td>
          <td>
            <button class="edit-team" data-id="${team.id}">Edit</button>
            <button class="delete-team danger" data-id="${team.id}">Delete</button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll(".edit-team").forEach((button) => {
    button.addEventListener("click", () => {
      const team = state.teams.find((t) => t.id === button.dataset.id);
      if (!team) return;
      loadTeamIntoRegistrationForm(team);
      const leftPane = document.querySelector(".registration-left-pane");
      if (leftPane) leftPane.scrollTo({ top: 0, behavior: "smooth" });
      const form = document.querySelector("#team-form");
      form?.category?.focus();
    });
  });

  tbody.querySelectorAll(".delete-team").forEach((button) => {
    button.addEventListener("click", () => {
      const team = state.teams.find((t) => t.id === button.dataset.id);
      if (!team) return;
      if (window.confirm(`Delete boat ${team.boatNumber}?`)) {
        deleteTeam(team.id);
      }
    });
  });
}

function renderStartTable() {
  const tbody = document.querySelector("#start-table tbody");
  const summary = document.querySelector("#start-queue-summary");
  const statusFilter = String(state.startQueueStatusFilter || "all");
  let teams = [...state.teams].sort((a, b) => {
    if (a.startTime && b.startTime) return new Date(b.startTime) - new Date(a.startTime);
    if (a.startTime) return -1;
    if (b.startTime) return 1;
    return normalizeBoat(a.boatNumber).localeCompare(normalizeBoat(b.boatNumber), undefined, { numeric: true });
  });
  const allTeams = teams;
  teams = teams.filter((team) => {
    if (statusFilter === "launched") return Boolean(team.startTime);
    if (statusFilter === "unlaunched") return !team.startTime;
    return true;
  });
  if (state.startQueueFilterBoats.length) {
    const filterSet = new Set(state.startQueueFilterBoats.map((boat) => normalizeBoat(boat)));
    teams = teams.filter((team) => filterSet.has(normalizeBoat(team.boatNumber)));
  }
  if (summary) {
    const filterLabel = statusFilter === "all" ? "all boats" : statusFilter;
    summary.textContent = `${teams.length} of ${allTeams.length} boat(s) shown (${filterLabel}).`;
  }

  if (!teams.length) {
    tbody.innerHTML = '<tr><td colspan="6">No boats match the current start queue filter.</td></tr>';
    return;
  }

  tbody.innerHTML = teams
    .map(
      (team) => `
        <tr>
          <td>${team.boatNumber}</td>
          <td>${displayRegistrationMembers(team)}</td>
          <td>${team.category || "-"}</td>
          <td>${formatClock(team.startTime)}</td>
          <td>${formatClock(team.finishTime)}</td>
          <td>
            ${
              team.startTime
                ? `<button class="icon-button edit-start" data-id="${team.id}" title="Edit start entry" aria-label="Edit start entry">✎</button>
                   <button class="icon-button danger delete-start" data-id="${team.id}" title="Delete start entry" aria-label="Delete start entry">🗑</button>`
                : "-"
            }
          </td>
        </tr>
      `,
    )
    .join("");

  tbody.querySelectorAll(".edit-start").forEach((button) => {
    button.addEventListener("click", () => {
      editStartEntry(button.dataset.id);
    });
  });

  tbody.querySelectorAll(".delete-start").forEach((button) => {
    button.addEventListener("click", () => {
      const team = state.teams.find((item) => item.id === button.dataset.id);
      if (!team) return;
      if (!window.confirm(`Delete start entry for boat ${team.boatNumber}?`)) return;
      deleteStartEntry(team.id);
    });
  });
}

function renderFinishTable() {
  const tbody = document.querySelector("#finish-table tbody");
  const summary = document.querySelector("#finish-entry-summary");
  const filter = String(state.finishEntryFilter || "all");
  const allRows = [...state.finishes].sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt));
  const rows = allRows.filter((entry) => {
    if (filter === "completed") return !entry.didNotFinish;
    if (filter === "dnf") return Boolean(entry.didNotFinish);
    if (filter === "penalty") return (Number(entry.penaltySeconds) || 0) > 0;
    return true;
  });

  if (summary) {
    const filterLabel = filter === "all" ? "all finish entries" : filter;
    summary.textContent = `${rows.length} of ${allRows.length} entry(s) shown (${filterLabel}).`;
  }

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9">No finish entries match the current filter.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map((entry, idx) => {
      const team = state.teams.find((item) => item.id === entry.teamId) || findTeamByBoat(entry.boatNumber);
      return `
        <tr>
          <td>${idx + 1}</td>
          <td>${entry.boatNumber}</td>
          <td>${team ? displayRegistrationMembers(team) : "-"}</td>
          <td>${formatClock(team?.startTime)}</td>
          <td>${entry.didNotFinish ? "DNF" : formatClock(entry.finishTime)}</td>
          <td>${formatPenaltyMinutes(entry.penaltySeconds)}</td>
          <td>${entry.didNotFinish ? "Yes" : "No"}</td>
          <td>${entry.notes || ""}</td>
          <td>
            <button class="icon-button edit-finish" data-id="${entry.id}" title="Edit finish entry" aria-label="Edit finish entry">✎</button>
            <button class="icon-button danger delete-finish" data-id="${entry.id}" title="Delete finish entry" aria-label="Delete finish entry">🗑</button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll(".edit-finish").forEach((button) => {
    button.addEventListener("click", () => {
      editFinishEntry(button.dataset.id);
    });
  });

  tbody.querySelectorAll(".delete-finish").forEach((button) => {
    button.addEventListener("click", () => {
      const entry = state.finishes.find((item) => item.id === button.dataset.id);
      if (!entry) return;
      if (!window.confirm(`Delete finish entry for boat ${entry.boatNumber}?`)) return;
      deleteFinishEntry(entry.id);
    });
  });
}

function buildScoreRows() {
  const complete = state.teams
    .map((team) => ({
      team,
      elapsedSeconds: computeElapsedSeconds(team),
    }))
    .filter((row) => row.elapsedSeconds != null && !row.team.didNotFinish)
    .sort((a, b) => a.elapsedSeconds - b.elapsedSeconds);

  const byCategory = new Map();
  complete.forEach((row) => {
    const key = row.team.category || "Uncategorized";
    const bucket = byCategory.get(key) || [];
    bucket.push(row);
    byCategory.set(key, bucket);
  });

  byCategory.forEach((rows) => rows.sort((a, b) => a.elapsedSeconds - b.elapsedSeconds));

  return complete.map((row, idx) => {
    const catRows = byCategory.get(row.team.category || "Uncategorized") || [];
    const place = catRows.findIndex((x) => x.team.id === row.team.id) + 1;
    return {
      overall: idx + 1,
      categoryPlace: place,
      ...row,
    };
  });
}

function renderScorecard() {
  const groups = document.querySelector("#score-groups");
  const summary = document.querySelector("#score-summary");
  const standings = buildScoreRows();
  const categorySelect = document.querySelector('#team-form select[name="category"]');
  const configuredCategories = categorySelect
    ? Array.from(categorySelect.options).map((option) => option.value).filter(Boolean)
    : [];
  const teamCategories = [...new Set(state.teams.map((team) => team.category || "Uncategorized"))];
  const discoveredCategories = [...new Set([...configuredCategories, ...teamCategories])];
  const orderList = isScorecardDisplayMode() ? state.scorecardCategoryOrderDisplay : state.scorecardCategoryOrderMain;
  const orderedKnown = orderList.filter((category) => discoveredCategories.includes(category));
  const orderedNew = discoveredCategories.filter((category) => !orderedKnown.includes(category));
  const allCategories = [...orderedKnown, ...orderedNew];
  const overallByTeam = new Map(standings.map((row) => [row.team.id, row.overall]));
  const placeByTeam = new Map(standings.map((row) => [row.team.id, row.categoryPlace]));

  summary.textContent = `${standings.length} finished / ${Math.max(state.teams.length - standings.length, 0)} remaining`;
  if (!groups) return;

  if (!allCategories.length) {
    groups.innerHTML = "<p>No categories found.</p>";
    return;
  }

  groups.innerHTML = allCategories
    .map((category) => {
      const catTeams = state.teams
        .filter((team) => (team.category || "Uncategorized") === category)
        .sort((a, b) => {
          const aFinished = overallByTeam.has(a.id);
          const bFinished = overallByTeam.has(b.id);
          if (aFinished && !bFinished) return -1;
          if (!aFinished && bFinished) return 1;
          if (aFinished && bFinished) {
            return (computeElapsedSeconds(a) || 0) - (computeElapsedSeconds(b) || 0);
          }
          return normalizeBoat(a.boatNumber).localeCompare(normalizeBoat(b.boatNumber), undefined, { numeric: true });
        });

      const body = catTeams.length
        ? catTeams
            .map(
              (team) => {
                const overall = overallByTeam.get(team.id);
                const place = placeByTeam.get(team.id);
                const isFinished = Number.isFinite(overall);
                const isRecreation = (team.category || "").trim().toLowerCase() === "recreation";
                const maxHighlightedPlace = isRecreation ? 5 : 3;
                const placeClass = isFinished && place <= maxHighlightedPlace ? ` podium-place-${place}` : "";
                const rankClass = isFinished && overall <= 3 ? ` podium-rank-${overall}` : "";
                const placeDisplay = isFinished ? place : team.didNotFinish ? "DNF" : "-";
                const rankDisplay = isFinished ? overall : "-";
                const timeDisplay = isFinished ? formatDuration(computeElapsedSeconds(team)) : "-";
                return `
                <tr>
                  <td>${team.boatNumber}</td>
                  <td>${displayTeamName(team)}</td>
                  <td>${timeDisplay}</td>
                  <td class="podium-cell${placeClass}">${placeDisplay}</td>
                  <td class="podium-cell${rankClass}">${rankDisplay}</td>
                </tr>
              `;
              },
            )
            .join("")
        : '<tr><td colspan="5" class="score-empty">No teams registered</td></tr>';

      return `
        <article class="score-group" draggable="true" data-category="${category}">
          <h3>${category}</h3>
          <table class="score-group-table">
            <colgroup>
              <col class="col-boat" />
              <col class="col-team" />
              <col class="col-time" />
              <col class="col-place" />
              <col class="col-rank" />
            </colgroup>
            <thead>
              <tr>
                <th title="Boat">🛶</th>
                <th>Team</th>
                <th title="Time">🕒</th>
                <th title="Place">🏁</th>
                <th title="Rank">★</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </article>
      `;
    })
    .join("");

  setupScorecardDragDrop(allCategories);

  requestAnimationFrame(() => {
    fitScorecardToViewport();
  });
}

function renderAwards() {
  const summary = document.querySelector("#awards-summary");
  const overallEl = document.querySelector("#awards-overall");
  const categoriesEl = document.querySelector("#awards-categories");
  if (!summary || !overallEl || !categoriesEl) return;

  const rows = buildScoreRows();
  const categorySelect = document.querySelector('#team-form select[name="category"]');
  const configuredCategories = categorySelect
    ? Array.from(categorySelect.options).map((option) => option.value).filter(Boolean)
    : [];
  const teamCategories = [...new Set(state.teams.map((team) => team.category || "Uncategorized"))];
  const discoveredCategories = [...new Set([...configuredCategories, ...teamCategories])];

  summary.textContent = rows.length
    ? `Live awards: ${rows.length} finished team(s).`
    : "No finished teams yet. Awards will populate as finishers are recorded.";

  const overallTop = rows.slice(0, 3);
  overallEl.innerHTML = `
    <h3>Overall Top 3</h3>
    <table class="awards-table awards-table-overall">
      <colgroup>
        <col class="aw-col-rank" />
        <col class="aw-col-boat" />
        <col class="aw-col-team" />
        <col class="aw-col-category" />
        <col class="aw-col-time" />
      </colgroup>
      <thead>
        <tr>
          <th>Rank</th>
          <th>Boat</th>
          <th>Team</th>
          <th>Category</th>
          <th>Time</th>
        </tr>
      </thead>
      <tbody>
        ${
          overallTop.length
            ? overallTop
                .map(
                  (row) => `
	                    <tr>
	                      <td>${row.overall}</td>
	                      <td>${row.team.boatNumber}</td>
	                      <td>${displayAwardTeamName(row.team)}</td>
	                      <td>${row.team.category || "Uncategorized"}</td>
	                      <td>${formatDuration(row.elapsedSeconds)}</td>
	                    </tr>
                  `,
                )
                .join("")
            : '<tr><td colspan="5" class="score-empty">No overall results yet</td></tr>'
        }
      </tbody>
    </table>
  `;

  categoriesEl.innerHTML = discoveredCategories
    .map((category) => {
      const categoryKey = normalizeCategoryName(category).toLowerCase();
      const isRecreation = categoryKey.includes("recreation");
      const maxPlaces = isRecreation ? 5 : 3;
      const categoryRows = rows
        .filter((row) => normalizeCategoryName(row.team.category || "Uncategorized").toLowerCase() === categoryKey)
        .slice(0, maxPlaces);

      return `
        <article class="awards-category-card">
          <h3>${category} (${isRecreation ? "Top 5" : "Top 3"})</h3>
          <table class="awards-table awards-table-category">
            <colgroup>
              <col class="aw-col-place" />
              <col class="aw-col-boat" />
              <col class="aw-col-team" />
              <col class="aw-col-time" />
              <col class="aw-col-rank" />
            </colgroup>
            <thead>
              <tr>
                <th>Place</th>
                <th>Boat</th>
                <th>Team</th>
                <th>Time</th>
                <th>Rank</th>
              </tr>
            </thead>
            <tbody>
              ${
                categoryRows.length
                  ? categoryRows
                      .map(
                        (row) => `
	                          <tr>
	                            <td>${row.categoryPlace}</td>
	                            <td>${row.team.boatNumber}</td>
	                            <td>${displayAwardTeamName(row.team)}</td>
	                            <td>${formatDuration(row.elapsedSeconds)}</td>
	                            <td>${row.overall}</td>
	                          </tr>
                        `,
                      )
                      .join("")
                  : '<tr><td colspan="5" class="score-empty">No finishers yet</td></tr>'
              }
            </tbody>
          </table>
        </article>
      `;
    })
    .join("");
}

function setupScorecardDragDrop(currentCategories) {
  const groups = document.querySelector("#score-groups");
  if (!groups) return;
  groups.dataset.currentCategories = JSON.stringify(currentCategories);

  if (groups.dataset.dndBound === "true") return;
  groups.dataset.dndBound = "true";

  groups.addEventListener("dragstart", (event) => {
    const card = event.target.closest(".score-group[data-category]");
    if (!card) return;
    draggingScoreCategory = card.dataset.category;
    draggingScoreCard = card;
    dragDropCommitted = false;
    card.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggingScoreCategory || "");
    }
  });

  groups.addEventListener("dragend", () => {
    groups.querySelectorAll(".score-group.is-dragging").forEach((card) => card.classList.remove("is-dragging"));
    draggingScoreCard = null;
    draggingScoreCategory = null;
    if (!dragDropCommitted) {
      // Preview-only drag was canceled; redraw saved layout.
      renderScorecard();
    }
  });

  groups.addEventListener("dragover", (event) => {
    if (!draggingScoreCard) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";

    const targetCard = event.target.closest(".score-group[data-category]");
    if (!targetCard || targetCard === draggingScoreCard) return;

    // Live preview: move cards while dragging to show final placement before drop.
    const rect = targetCard.getBoundingClientRect();
    const placeAfter = event.clientY > rect.top + rect.height / 2;
    if (placeAfter) {
      groups.insertBefore(draggingScoreCard, targetCard.nextSibling);
    } else {
      groups.insertBefore(draggingScoreCard, targetCard);
    }
  });

  groups.addEventListener("drop", (event) => {
    if (!draggingScoreCard) return;
    event.preventDefault();

    const newOrder = Array.from(groups.querySelectorAll(".score-group[data-category]"))
      .map((node) => node.dataset.category)
      .filter(Boolean);
    if (!newOrder.length) return;

    dragDropCommitted = true;
    if (isScorecardDisplayMode()) {
      state.scorecardCategoryOrderDisplay = newOrder;
      touchScorecardOrder("display");
    } else {
      state.scorecardCategoryOrderMain = newOrder;
      touchScorecardOrder("main");
    }
    saveStatePatch({
      ...(isScorecardDisplayMode()
        ? {
            scorecardCategoryOrderDisplay: state.scorecardCategoryOrderDisplay,
            scorecardCategoryOrderDisplayUpdatedAt: state.scorecardCategoryOrderDisplayUpdatedAt || state.sharedStateUpdatedAt || getNowTimestamp(),
          }
        : {
            scorecardCategoryOrderMain: state.scorecardCategoryOrderMain,
            scorecardCategoryOrderMainUpdatedAt: state.scorecardCategoryOrderMainUpdatedAt || state.sharedStateUpdatedAt || getNowTimestamp(),
          }),
      updatedAt: state.sharedStateUpdatedAt || getNowTimestamp(),
    }, "scorecard-order-updated");
    renderScorecard();
  });
}

function renderAll() {
  renderSyncStatus();
  renderCategories();
  renderRegistrationTable();
  renderStartTable();
  renderFinishTable();
  renderScorecard();
  renderAwards();
}

function setupForms() {
  const teamForm = document.querySelector("#team-form");
  const clearButton = document.querySelector("#clear-form");
  const registrationSearchInput = document.querySelector("#registration-search");
  const clearRegistrationSearchButton = document.querySelector("#clear-registration-search");
  const registrationFilterChips = document.querySelectorAll(".filter-chip[data-status-filter]");
  const startQueueFilterChips = document.querySelectorAll(".filter-chip[data-start-status-filter]");
  const finishEntryFilterChips = document.querySelectorAll(".filter-chip[data-finish-filter]");
  const lookupBoatButton = document.querySelector("#lookup-boat");
  const assignNextBoatButton = document.querySelector("#assign-next-boat");
  const registrationHelper = document.querySelector("#registration-helper");
  const phoneInput = teamForm.phone;
  const categorySelect = teamForm.category;
  const boatInput = teamForm.boatNumber;

  const setRegistrationHelper = (message) => {
    if (!registrationHelper) return;
    registrationHelper.textContent = message || "";
  };

  const lookupBoat = () => {
    const boatNumber = normalizeBoat(boatInput.value);
    if (!boatNumber) {
      if (state.editingTeamId && teamForm.notes) teamForm.notes.value = "";
      state.editingTeamId = null;
      setRegistrationNotesIndicatorVisible(false);
      setRegistrationHelper("Enter a boat number to load a pre-registered team.");
      return null;
    }
    const team = findTeamByBoat(boatNumber);
    if (!team) {
      if (state.editingTeamId && teamForm.notes) teamForm.notes.value = "";
      state.editingTeamId = null;
      setRegistrationNotesIndicatorVisible(false);
      setRegistrationHelper(`Boat ${boatNumber} not found. Use Assign Next Boat # for a walk-up team.`);
      return null;
    }
    loadTeamIntoRegistrationForm(team);
    setRegistrationHelper(
      hasRegistrationNotes(team)
        ? `Loaded boat ${team.boatNumber}. Internal notes on file. Review details, mark paid/check-in, then Save Team.`
        : `Loaded boat ${team.boatNumber}. Review details, mark paid/check-in, then Save Team.`,
    );
    return team;
  };

  phoneInput.addEventListener("input", () => {
    phoneInput.value = formatPhoneInput(phoneInput.value);
  });
  teamForm.notes?.addEventListener("input", () => {
    setRegistrationNotesIndicatorVisible(Boolean(normalizeRegistrationNotes(teamForm.notes.value)));
  });
  categorySelect.addEventListener("change", () => updateRacerFieldAvailability(teamForm));
  boatInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    lookupBoat();
  });
  boatInput.addEventListener("change", lookupBoat);
  if (registrationSearchInput) {
    registrationSearchInput.addEventListener("input", () => {
      state.registrationQuery = registrationSearchInput.value.trim();
      renderRegistrationTable();
    });
  }
  if (clearRegistrationSearchButton) {
    clearRegistrationSearchButton.addEventListener("click", () => {
      state.registrationQuery = "";
      if (registrationSearchInput) registrationSearchInput.value = "";
      renderRegistrationTable();
    });
  }
  registrationFilterChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      state.registrationFilter = chip.dataset.statusFilter || "all";
      registrationFilterChips.forEach((item) => item.classList.toggle("active", item === chip));
      renderRegistrationTable();
    });
  });
  startQueueFilterChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      state.startQueueStatusFilter = chip.dataset.startStatusFilter || "all";
      startQueueFilterChips.forEach((item) => item.classList.toggle("active", item === chip));
      renderStartTable();
    });
  });
  finishEntryFilterChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      state.finishEntryFilter = chip.dataset.finishFilter || "all";
      finishEntryFilterChips.forEach((item) => item.classList.toggle("active", item === chip));
      renderFinishTable();
    });
  });
  if (lookupBoatButton) {
    lookupBoatButton.addEventListener("click", lookupBoat);
  }
  if (assignNextBoatButton) {
    assignNextBoatButton.addEventListener("click", () => {
      resetRegistrationForm({ assignNextBoat: true });
      setRegistrationHelper(`Walk-up mode: assigned boat #${teamForm.boatNumber.value}.`);
      teamForm.category.focus();
    });
  }
  document.addEventListener("keydown", (event) => {
    const registrationPanel = document.querySelector("#registration.panel.active");
    if (!registrationPanel) return;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      teamForm.requestSubmit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      resetRegistrationForm();
      setRegistrationHelper("Cleared.");
    }
  });
  updateRacerFieldAvailability(teamForm);

  teamForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    let boatNumber = normalizeBoat(form.boatNumber.value);
    if (!boatNumber && !state.editingTeamId) {
      boatNumber = getNextBoatNumber();
      form.boatNumber.value = boatNumber;
      setRegistrationHelper(`Assigned new boat #${boatNumber} for walk-up registration.`);
    }
    if (!boatNumber) return;

    const existing = state.teams.find((t) => t.id !== state.editingTeamId && normalizeBoat(t.boatNumber) === boatNumber);
    if (existing) {
      alert(`Boat ${boatNumber} already exists.`);
      return;
    }

    const payload = {
      boatNumber,
      category: normalizeCategoryName(form.category.value),
      sponsorship: form.sponsorship.value,
      sponsorName: form.sponsorName.value.trim(),
      phone: formatPhoneInput(form.phone.value),
      notes: normalizeRegistrationNotes(form.notes.value),
      paidStatus: form.paidStatus.checked,
      checkedIn: form.checkedIn.checked,
      racer1: {
        first: form.racer1_given_name.value.trim(),
        last: form.racer1_family_name.value.trim(),
      },
      racer2: form.racer2_given_name.value.trim() || form.racer2_family_name.value.trim()
        ? {
            first: form.racer2_given_name.value.trim(),
            last: form.racer2_family_name.value.trim(),
          }
        : null,
    };

    const wasEditingTeam = state.editingTeamId;
    let savedTeam = null;
    if (wasEditingTeam) {
      const idx = state.teams.findIndex((t) => t.id === state.editingTeamId);
      if (idx >= 0) {
        state.teams[idx] = {
          ...state.teams[idx],
          ...payload,
        };
        touchTeam(state.teams[idx]);
        savedTeam = state.teams[idx];
      }
    } else {
      savedTeam = {
        id: newId(),
        ...payload,
        startTime: null,
        finishTime: null,
        penaltySeconds: 0,
        didNotFinish: false,
        updatedAt: getNowTimestamp(),
      };
      state.teams.push(savedTeam);
    }

    resetRegistrationForm();
    setRegistrationHelper("Saved.");
    if (savedTeam) {
      saveStatePatch({
        upsertTeams: [savedTeam],
        updatedAt: savedTeam.updatedAt,
      }, wasEditingTeam ? "team-updated" : "team-created");
    }
    renderAll();
  });

  clearButton.addEventListener("click", () => {
    resetRegistrationForm();
    setRegistrationHelper("Cleared.");
  });

  const startForm = document.querySelector("#start-form");
  const launchTimePreview = startForm.querySelector("[data-launch-time-preview]");
  const updateLaunchTimePreview = () => {
    if (!launchTimePreview) return;
    launchTimePreview.textContent = `Launch Time: ${formatClock(currentRoundedSecondISO())}`;
  };
  const applyLiveStartQueueFilter = () => {
    const liveBoats = parseBoatNumbers(startForm.boatNumbers.value);
    state.startQueueFilterBoats = liveBoats;
    renderStartTable();
  };
  startForm.boatNumbers.addEventListener("input", applyLiveStartQueueFilter);
  updateLaunchTimePreview();
  window.setInterval(updateLaunchTimePreview, 1000);

  startForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const boatNumbers = parseBoatNumbers(form.boatNumbers.value);
    if (!boatNumbers.length) {
      alert("Enter at least one boat number.");
      return;
    }

    const startTime = currentRoundedSecondISO();
    const updatedAt = getNowTimestamp();
    const missing = [];
    const alreadyLaunched = [];
    let startedCount = 0;

    boatNumbers.forEach((boatNumber) => {
      const team = findTeamByBoat(boatNumber);
      if (!team) {
        missing.push(boatNumber);
        return;
      }
      if (team.startTime) {
        alreadyLaunched.push(team.boatNumber);
        return;
      }
      team.startTime = startTime;
      touchTeam(team, updatedAt);
      startedCount += 1;
      if (team.finishTime && new Date(team.finishTime) < new Date(team.startTime)) {
        team.finishTime = null;
        team.penaltySeconds = 0;
        team.didNotFinish = false;
      }
    });

    if (!startedCount && !alreadyLaunched.length && missing.length === boatNumbers.length) {
      state.startQueueFilterBoats = [];
      alert(`No matching boats found: ${missing.join(", ")}.`);
      renderAll();
      return;
    }

    if (alreadyLaunched.length) {
      state.startQueueFilterBoats = [...new Set(alreadyLaunched.map((boat) => normalizeBoat(boat)))];
    } else {
      state.startQueueFilterBoats = [];
    }

    if (startedCount) {
      saveStatePatch({
        upsertTeams: state.teams.filter((team) => boatNumbers.includes(normalizeBoat(team.boatNumber)) && team.startTime === startTime),
        updatedAt,
      }, "start-recorded");
    }
    renderAll();

    if (!alreadyLaunched.length) {
      form.reset();
    }

    const notices = [];
    if (startedCount) notices.push(`Started ${startedCount} boat(s).`);
    if (alreadyLaunched.length) {
      notices.push(`Already launched: ${alreadyLaunched.join(", ")}.`);
      notices.push("Launch queue is now filtered to that boat number.");
    }
    if (missing.length) notices.push(`Not found: ${missing.join(", ")}.`);
    if (notices.length) alert(notices.join("\n"));
  });

  const finishCapturedTimeDisplay = document.querySelector("#finish-captured-time");
  const finishTimeStatePill = document.querySelector("#finish-time-state");
  const finishCaptureHint = document.querySelector("#finish-capture-hint");
  const clearFinishLanesButton = document.querySelector("#clear-finish-lanes");
  const finishLaneForms = Array.from(document.querySelectorAll(".finish-lane-form"));

  const setFinishCaptureHint = (message, warning = false) => {
    if (!finishCaptureHint) return;
    finishCaptureHint.textContent = message || "";
    finishCaptureHint.style.color = warning ? "var(--danger)" : "";
  };

  const renderCapturedFinishTime = () => {
    if (!state.finishCapturedTimeIso) {
      state.finishCapturedTimeIso = currentRoundedSecondISO();
    } else {
      state.finishCapturedTimeIso = currentRoundedSecondISO();
    }
    if (finishCapturedTimeDisplay) {
      finishCapturedTimeDisplay.textContent = formatClock(state.finishCapturedTimeIso);
    }
    if (finishTimeStatePill) {
      finishTimeStatePill.textContent = "LIVE";
      finishTimeStatePill.classList.remove("locked");
      finishTimeStatePill.classList.add("live");
    }
  };

  const getNextLaneBoatInput = (currentForm) => {
    const index = finishLaneForms.indexOf(currentForm);
    const nextIndex = index < 0 ? 0 : (index + 1) % finishLaneForms.length;
    return finishLaneForms[nextIndex]?.boatNumber || null;
  };

  const setLaneStatus = (pill, status) => {
    if (!pill) return;
    pill.classList.remove("racing", "finished", "unlaunched", "unknown");
    if (status === "Racing") pill.classList.add("racing");
    else if (status === "Finished") pill.classList.add("finished");
    else if (status === "Not Launched") pill.classList.add("unlaunched");
    else pill.classList.add("unknown");
    pill.textContent = status;
  };

  const clearLane = (form) => {
    if (!form) return;
    form.reset();
    form.penaltyMinutes.value = 0;
    form.dnf.checked = false;
    form.dataset.overrideAllowed = "false";
    updateLanePreview(form);
  };

  const clearAllFinishLanes = () => {
    finishLaneForms.forEach((form) => clearLane(form));
  };

  function updateLanePreview(form) {
    if (!form) return;
    const teamPreview = form.querySelector("[data-team-preview]");
    const teamCategory = form.querySelector("[data-team-category]");
    const statusPill = form.querySelector("[data-lane-status]");
    const overrideButton = form.querySelector("[data-override-finish]");
    const recordButton = form.querySelector(".lane-record");
    const boatNumber = normalizeBoat(form.boatNumber.value);
    const team = findTeamByBoat(boatNumber);
    const overrideAllowed = form.dataset.overrideAllowed === "true";

    form.classList.remove("is-missing", "is-duplicate", "is-unlaunched");
    if (!boatNumber) {
      teamPreview.textContent = "-";
      teamPreview.title = "-";
      if (teamCategory) {
        teamCategory.hidden = true;
        teamCategory.textContent = "-";
      }
      setLaneStatus(statusPill, "Unknown");
      if (overrideButton) overrideButton.classList.add("hidden");
      if (recordButton) recordButton.disabled = true;
      return;
    }
    if (!team) {
      form.classList.add("is-missing");
      teamPreview.textContent = "Boat not found";
      teamPreview.title = "Boat not found";
      if (teamCategory) {
        teamCategory.hidden = true;
        teamCategory.textContent = "-";
      }
      setLaneStatus(statusPill, "Unknown");
      if (overrideButton) overrideButton.classList.add("hidden");
      if (recordButton) recordButton.disabled = true;
      return;
    }

    const fullTeamName = displayRegistrationMembers(team) || "-";
    teamPreview.textContent = fullTeamName;
    teamPreview.title = fullTeamName;
    if (teamCategory) {
      teamCategory.hidden = false;
      teamCategory.textContent = team.category || "Uncategorized";
    }

    if (hasFinishEntry(team.id)) {
      form.classList.add("is-duplicate");
      setLaneStatus(statusPill, "Finished");
      if (overrideButton) overrideButton.classList.toggle("hidden", overrideAllowed);
      if (recordButton) recordButton.disabled = !overrideAllowed;
      return;
    }

    if (overrideButton) overrideButton.classList.add("hidden");
    if (!team.startTime) {
      form.classList.add("is-unlaunched");
      setLaneStatus(statusPill, "Not Launched");
      if (recordButton) recordButton.disabled = false;
      return;
    }

    setLaneStatus(statusPill, "Racing");
    if (recordButton) recordButton.disabled = false;
  }

  state.finishCapturedTimeIso = currentRoundedSecondISO();
  renderCapturedFinishTime();

  window.setInterval(() => {
    state.finishCapturedTimeIso = currentRoundedSecondISO();
    renderCapturedFinishTime();
  }, 1000);

  if (clearFinishLanesButton) {
    clearFinishLanesButton.addEventListener("click", () => {
      clearAllFinishLanes();
      finishLaneForms[0]?.boatNumber?.focus();
      setFinishCaptureHint("All lanes cleared.", false);
    });
  }

  finishLaneForms.forEach((finishForm) => {
    const boatInput = finishForm.boatNumber;
    const overrideButton = finishForm.querySelector("[data-override-finish]");

    const resetOverride = () => {
      finishForm.dataset.overrideAllowed = "false";
    };

    boatInput.addEventListener("input", () => {
      resetOverride();
      updateLanePreview(finishForm);
    });

    boatInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      resetOverride();
      updateLanePreview(finishForm);
      finishForm.penaltyMinutes.focus();
    });

    if (overrideButton) {
      overrideButton.addEventListener("click", () => {
        finishForm.dataset.overrideAllowed = "true";
        updateLanePreview(finishForm);
      });
    }

    finishForm.addEventListener("submit", (event) => {
      event.preventDefault();

      const form = event.currentTarget;
      const boatNumber = normalizeBoat(form.boatNumber.value);
      const team = findTeamByBoat(boatNumber);
      if (!team) {
        setFinishCaptureHint(`Boat ${boatNumber || "?"} not found.`, true);
        updateLanePreview(form);
        form.boatNumber.focus();
        return;
      }
      if (hasFinishEntry(team.id) && form.dataset.overrideAllowed !== "true") {
        setFinishCaptureHint(`Boat ${boatNumber} already has a finish. Use Override to re-record.`, true);
        updateLanePreview(form);
        return;
      }

      const penaltyInput = Number(form.penaltyMinutes.value);
      if (!Number.isFinite(penaltyInput) || penaltyInput < 0 || !Number.isInteger(penaltyInput)) {
        setFinishCaptureHint("Penalty minutes must be a whole number (0 or greater).", true);
        form.penaltyMinutes.focus();
        return;
      }

      const didNotFinish = Boolean(form.dnf.checked);
      const finishTime = didNotFinish ? null : state.finishCapturedTimeIso;
      const notes = form.notes.value.trim();
      const penaltySeconds = penaltyInput * 60;
      const updatedAt = getNowTimestamp();

      team.finishTime = finishTime;
      team.penaltySeconds = penaltySeconds;
      team.didNotFinish = didNotFinish;
      touchTeam(team, updatedAt);

      state.finishes.push({
        id: newId(),
        teamId: team.id,
        boatNumber: team.boatNumber,
        finishTime,
        penaltySeconds,
        didNotFinish,
        notes,
        capturedAt: state.finishCapturedTimeIso,
        updatedAt,
      });

      saveStatePatch({
        upsertTeams: [team],
        upsertFinishes: [state.finishes[state.finishes.length - 1]],
        updatedAt,
      }, "finish-recorded");
      renderAll();
      clearLane(form);
      const nextInput = getNextLaneBoatInput(form);
      if (nextInput) nextInput.focus();
      setFinishCaptureHint(`Recorded boat ${team.boatNumber}.`, false);
    });

    updateLanePreview(finishForm);
  });

  document.addEventListener("keydown", (event) => {
    const finishPanel = document.querySelector("#finish.panel.active");
    if (!finishPanel || event.key !== "Escape") return;

    if (event.shiftKey) {
      event.preventDefault();
      clearAllFinishLanes();
      finishLaneForms[0]?.boatNumber?.focus();
      setFinishCaptureHint("All lanes cleared.", false);
      return;
    }

    const activeLane = document.activeElement?.closest(".finish-lane-form");
    if (!activeLane) return;
    event.preventDefault();
    clearLane(activeLane);
    activeLane.boatNumber.focus();
    setFinishCaptureHint(`Lane ${activeLane.dataset.laneIndex} cleared.`, false);
  });

  finishLaneForms[0]?.boatNumber?.focus();
}

function setupDataButtons() {
  const loadBackupButton = document.querySelector("#load-backup");
  const backupFileInput = document.querySelector("#backup-file-input");
  loadBackupButton.addEventListener("click", () => {
    backupFileInput.value = "";
    backupFileInput.click();
  });
  backupFileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text());
      const source = parsed && typeof parsed.data === "object" ? parsed.data : parsed;
      if (!Array.isArray(source?.teams) && !Array.isArray(source?.finishes)) {
        throw new Error("Backup file does not contain teams or finishes.");
      }

      applyPersistedState(parsed);
      state.editingTeamId = null;
      state.editingStartTeamId = null;
      state.editingFinishId = null;
      state.registrationQuery = "";
      state.registrationFilter = "all";
      state.startQueueFilterBoats = [];
      state.startQueueStatusFilter = "all";
      state.finishEntryFilter = "all";
      saveStateCheckpoint(`backup-loaded:${file.name}`, Array.isArray(parsed?.eventLog) ? parsed.eventLog : null);
      renderAll();

      const registrationSearchInput = document.querySelector("#registration-search");
      if (registrationSearchInput) registrationSearchInput.value = "";
      const startForm = document.querySelector("#start-form");
      if (startForm) startForm.reset();
      document.querySelectorAll(".filter-chip[data-status-filter]").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.statusFilter === "all");
      });
      document.querySelectorAll(".filter-chip[data-start-status-filter]").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.startStatusFilter === "all");
      });
      document.querySelectorAll(".filter-chip[data-finish-filter]").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.finishFilter === "all");
      });
      resetRegistrationForm();

      alert(`Loaded backup from ${file.name}.`);
    } catch (error) {
      alert(`Could not load backup: ${error.message}`);
    }
  });

  document.querySelector("#randomize-finishes").addEventListener("click", () => {
    if (!state.teams.length) {
      alert("No teams to randomize. Load or add teams first.");
      return;
    }
    if (!window.confirm("Randomize finish times for all teams (2-4 hours from launch)?")) return;

    const teams = [...state.teams].sort((a, b) =>
      normalizeBoat(a.boatNumber).localeCompare(normalizeBoat(b.boatNumber), undefined, { numeric: true }),
    );
    const baseStartMs = Date.now() - (4 * 60 * 60 + 15 * 60) * 1000;
    const generatedFinishes = [];

    teams.forEach((team, idx) => {
      const updatedAt = getNowTimestamp();
      // Keep existing launch times; synthesize only when missing so every team can be scored.
      if (!team.startTime) {
        team.startTime = new Date(baseStartMs + idx * 30 * 1000).toISOString();
      }
      const elapsedSeconds = randomInt(2 * 60 * 60, 4 * 60 * 60);
      const finishTime = new Date(new Date(team.startTime).getTime() + elapsedSeconds * 1000).toISOString();
      const penaltySeconds = Number(team.penaltySeconds) || 0;
      const didNotFinish = false;
      const notes = "";

      team.finishTime = finishTime;
      team.penaltySeconds = penaltySeconds;
      team.didNotFinish = didNotFinish;
      touchTeam(team, updatedAt);

      generatedFinishes.push({
        id: newId(),
        teamId: team.id,
        boatNumber: team.boatNumber,
        finishTime,
        penaltySeconds,
        didNotFinish,
        notes,
        capturedAt: finishTime,
        updatedAt,
      });
    });

    state.finishes = generatedFinishes.sort((a, b) => new Date(a.finishTime) - new Date(b.finishTime));
    saveStateCheckpoint("randomized-finishes");
    renderAll();
    alert(`Randomized finish times for ${teams.length} team(s).`);
  });

  document.querySelector("#export-json").addEventListener("click", () => {
    const payload = {
      backupType: "race-backup",
      storageKey: STORAGE_KEY,
      eventLogStorageKey: EVENT_LOG_STORAGE_KEY,
      exportedAt: new Date().toISOString(),
      data: buildPersistedState(),
      eventLog: localEventJournal.events,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `race-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.querySelector("#clear-all").addEventListener("click", () => {
    if (!window.confirm("Clear all saved teams and finishes?")) return;
    state.teams = [];
    state.finishes = [];
    state.editingTeamId = null;
    updateSharedStateTimestamp();
    saveStateCheckpoint("all-data-cleared");
    renderAll();
  });
}

function setDiagnosticValue(selector, text, status = "") {
  const element = document.querySelector(selector);
  if (!element) return;
  element.textContent = text;
  if (status) {
    element.dataset.status = status;
  } else {
    delete element.dataset.status;
  }
}

function renderRuntimeHealth() {
  const payload = runtimeHealth.payload;
  setDiagnosticValue("#diag-mode", isLocalOperatorHost() ? "Local operator" : "Hosted redirect", "ok");

  if (!payload) {
    const pendingLabel = runtimeHealth.checking ? "Checking..." : "Waiting...";
    const pendingStatus = runtimeHealth.checking ? "warn" : "";
    setDiagnosticValue("#diag-api", pendingLabel, pendingStatus);
    setDiagnosticValue("#diag-supabase", pendingLabel, pendingStatus);
    setDiagnosticValue("#diag-snapshot", "Waiting...");
    const message = document.querySelector("#diag-message");
    if (message) {
      message.textContent = runtimeHealth.checking
        ? "Verifying local API and shared-state connectivity."
        : "Health checks will appear here after startup.";
    }
    return;
  }

  const apiOk = payload.api?.health === "reachable" && payload.api?.state === "reachable";
  const supabaseOk = Boolean(payload.supabase?.ok);
  setDiagnosticValue("#diag-api", apiOk ? "Reachable" : "Issue detected", apiOk ? "ok" : "error");
  setDiagnosticValue("#diag-supabase", supabaseOk ? "Connected" : "Needs attention", supabaseOk ? "ok" : "error");
  setDiagnosticValue("#diag-snapshot", payload.supabase?.snapshotId || "Unavailable", payload.supabase?.snapshotId ? "ok" : "warn");

  const message = document.querySelector("#diag-message");
  if (!message) return;
  if (payload.ok) {
    message.textContent = "Local API is reachable and Supabase shared state is responding.";
    return;
  }
  message.textContent = payload.supabase?.message || "Health check reported a configuration or connectivity problem.";
}

async function refreshRuntimeHealth() {
  if (runtimeHealth.checking) return;
  runtimeHealth.checking = true;
  renderRuntimeHealth();
  try {
    const response = await fetch(HEALTH_API_PATH, {
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
    });
    runtimeHealth.payload = await response.json();
  } catch (error) {
    runtimeHealth.payload = {
      ok: false,
      api: { health: "unreachable", state: "unreachable" },
      supabase: {
        ok: false,
        message: error instanceof Error ? error.message : "Health request failed.",
      },
    };
  } finally {
    runtimeHealth.checking = false;
    renderRuntimeHealth();
  }
}

function setupRuntimeDiagnostics() {
  document.querySelector("#refresh-health")?.addEventListener("click", () => {
    void refreshRuntimeHealth();
  });
  renderRuntimeHealth();
}

function isScorecardDisplayMode() {
  const params = new URLSearchParams(window.location.search);
  return params.get("view") === "scorecard"
    || window.location.hash === "#scorecard-display"
    || window.name === SCORECARD_DISPLAY_WINDOW_NAME;
}

function setupScorecardDisplayControls() {
  const popoutButton = document.querySelector("#popout-scorecard");
  const organizeButton = document.querySelector("#auto-organize-scorecard");
  const MIN_SCORE_TILE_WIDTH = 320;
  const ESTIMATED_TILE_HEADER = 76;
  const ESTIMATED_TILE_ROW = 28;

  const getOrganizeTargetWidth = () => {
    if (!scorecardDisplayWindow || scorecardDisplayWindow.closed) return null;
    try {
      const frame = scorecardDisplayWindow.document.querySelector("#score-fit-frame");
      return frame?.clientWidth || scorecardDisplayWindow.innerWidth || null;
    } catch {
      return null;
    }
  };

  if (organizeButton) {
    organizeButton.addEventListener("click", () => {
      const organizeForWidth = (width, mode) => {
        const rows = buildScoreRows();
        const categorySelect = document.querySelector('#team-form select[name="category"]');
        const configuredCategories = categorySelect
          ? Array.from(categorySelect.options).map((option) => option.value).filter(Boolean)
          : [];
        const teamCategories = [...new Set(state.teams.map((team) => team.category || "Uncategorized"))];
        const rowCategories = [...new Set(rows.map((row) => row.team.category || "Uncategorized"))];
        const discoveredCategories = [...new Set([...configuredCategories, ...teamCategories, ...rowCategories])];
        if (!discoveredCategories.length) return;

        const columns = Math.max(1, Math.floor((width || MIN_SCORE_TILE_WIDTH) / MIN_SCORE_TILE_WIDTH));
        const countByCategory = new Map();
        discoveredCategories.forEach((category) => countByCategory.set(category, 0));
        state.teams.forEach((team) => {
          const key = team.category || "Uncategorized";
          countByCategory.set(key, (countByCategory.get(key) || 0) + 1);
        });

        const weighted = discoveredCategories
          .map((category) => ({
            category,
            height: ESTIMATED_TILE_HEADER + (countByCategory.get(category) || 0) * ESTIMATED_TILE_ROW,
          }))
          .sort((a, b) => b.height - a.height);

        const buckets = Array.from({ length: columns }, () => ({ height: 0, categories: [] }));
        weighted.forEach((item) => {
          const target = buckets.reduce((best, bucket) => (bucket.height < best.height ? bucket : best), buckets[0]);
          target.categories.push(item.category);
          target.height += item.height;
        });

        const order = buckets.flatMap((bucket) => bucket.categories);
        if (mode === "display") {
          state.scorecardCategoryOrderDisplay = order;
          touchScorecardOrder("display");
        } else {
          state.scorecardCategoryOrderMain = order;
          touchScorecardOrder("main");
        }
      };

      const scoreFrame = document.querySelector("#score-fit-frame");
      const mainWidth = scoreFrame?.clientWidth || window.innerWidth || MIN_SCORE_TILE_WIDTH;
      organizeForWidth(mainWidth, "main");

      const popoutWidth = getOrganizeTargetWidth();
      if (popoutWidth) {
        organizeForWidth(popoutWidth, "display");
        try {
          scorecardDisplayWindow.postMessage({ type: "scorecard-organized" }, window.location.origin);
        } catch {
          // Ignore popout messaging failures.
        }
      }

      saveStatePatch({
        scorecardCategoryOrderMain: state.scorecardCategoryOrderMain,
        scorecardCategoryOrderDisplay: state.scorecardCategoryOrderDisplay,
        scorecardCategoryOrderMainUpdatedAt: state.scorecardCategoryOrderMainUpdatedAt || state.sharedStateUpdatedAt || getNowTimestamp(),
        scorecardCategoryOrderDisplayUpdatedAt: state.scorecardCategoryOrderDisplayUpdatedAt || state.sharedStateUpdatedAt || getNowTimestamp(),
        updatedAt: state.sharedStateUpdatedAt || getNowTimestamp(),
      }, "scorecard-organized");
      renderAll();
    });
  }

  if (!popoutButton) return;

  popoutButton.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "scorecard");
    url.hash = "scorecard-display";
    scorecardDisplayWindow = window.open(url.toString(), SCORECARD_DISPLAY_WINDOW_NAME, "width=1700,height=950");
    if (scorecardDisplayWindow) scorecardDisplayWindow.focus();
  });
}

function applyScorecardDisplayMode() {
  if (!isScorecardDisplayMode()) return;

  window.name = SCORECARD_DISPLAY_WINDOW_NAME;
  document.body.classList.add("scorecard-display");
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === "scorecard");
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === "scorecard");
  });
  document.title = "Wild Hog Canoe Race Official Scorecard";

  window.addEventListener("resize", () => {
    fitScorecardToViewport();
  });
}

function setupCrossWindowSync() {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) {
      if (!shouldUseLocalStateBroadcast()) return;
      loadState();
      renderAll();
      return;
    }
    if (event.key === EVENT_LOG_STORAGE_KEY) {
      if (!shouldUseLocalStateBroadcast()) return;
      loadLocalEventJournal();
      return;
    }
    if (event.key === SYNC_QUEUE_STORAGE_KEY) {
      loadSyncQueue();
      renderShellState();
      if (sharedStateSync.enabled) {
        applyConnectedSyncStatus();
      } else {
        renderSyncStatus();
      }
      return;
    }
    if (event.key === OPERATOR_SYNC_SECRET_STORAGE_KEY) {
      renderShellState();
      if (sharedStateSync.enabled) {
        applyConnectedSyncStatus();
      } else {
        renderSyncStatus();
      }
      return;
    }
    if (event.key === OPERATOR_SYNC_ENABLED_STORAGE_KEY) {
      renderShellState();
      if (sharedStateSync.enabled) {
        applyConnectedSyncStatus();
      } else {
        renderSyncStatus();
      }
    }
  });

  window.addEventListener("message", (event) => {
    if (!shouldUseLocalStateBroadcast()) return;
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === SCORECARD_SYNC_MESSAGE_TYPE) {
      if (event.data.sourceId === WINDOW_INSTANCE_ID || !event.data.state) return;
      try {
        applyPersistedState(event.data.state);
        renderAll();
      } catch {
        // Ignore malformed sync payloads.
      }
      return;
    }
    if (event.data?.type !== "scorecard-organized") return;
    loadState();
    renderAll();
  });

  getScorecardSyncChannel()?.addEventListener("message", (event) => {
    if (!shouldUseLocalStateBroadcast()) return;
    if (event.data?.type !== SCORECARD_SYNC_MESSAGE_TYPE) return;
    if (event.data.sourceId === WINDOW_INSTANCE_ID || !event.data.state) return;
    try {
      applyPersistedState(event.data.state);
      renderAll();
    } catch {
      // Ignore malformed sync payloads.
    }
  });

  window.addEventListener("online", () => {
    setSharedSyncStatus("syncing", "Reconnecting shared data...");
    void initializeSharedStateSync(loadBestLocalSnapshot() || buildPersistedState());
  });

  window.addEventListener("offline", () => {
    if (sharedStateSync.enabled || hasPendingSyncQueue()) setOfflineSyncStatus();
  });
}

function updateRegistrationConsoleHeight() {
  const registration = document.querySelector("#registration");
  const header = document.querySelector(".app-header");
  const tabs = document.querySelector(".tabs");
  const main = document.querySelector("main");
  if (!registration || !main) return;
  const mainStyle = getComputedStyle(main);
  const chromeHeight = (header?.offsetHeight || 0)
    + (tabs?.offsetHeight || 0)
    + (parseFloat(mainStyle.paddingTop) || 0)
    + (parseFloat(mainStyle.paddingBottom) || 0)
    + 8;
  registration.style.setProperty("--registration-console-h", `calc(100vh - ${Math.round(chromeHeight)}px)`);
}

async function init() {
  redirectHostedOperatorRoute();
  const localSnapshot = loadBestLocalSnapshot() || buildPersistedState();
  loadSyncQueue();
  renderShellState();
  renderTabs();
  setupForms();
  setupStartEditModal();
  setupFinishEditModal();
  setupDataButtons();
  setupRuntimeDiagnostics();
  setupSyncControls();
  setupScorecardDisplayControls();
  setupCrossWindowSync();
  applyScorecardDisplayMode();
  updateRegistrationConsoleHeight();
  window.addEventListener("resize", updateRegistrationConsoleHeight);
  renderAll();

  await refreshRuntimeHealth();
  await initializeSharedStateSync(localSnapshot);
  renderShellState();
  renderAll();
}

void init();
