import { readEnv } from "./env.js";
import {
  createEmptyPersistedState,
  createSnapshotId,
  getStateSchemaVersion,
  normalizePersistedState,
} from "./state-shape.js";

const SUPABASE_ROW_ID_FALLBACK = "main";
const SNAPSHOT_CACHE_TTL_MS = 1000;

let latestStateCache = null;
let latestMetadataCache = null;

function isoNow() {
  return new Date().toISOString();
}

function freshCache(cache) {
  if (!cache) return null;
  return Date.now() - cache.cachedAt <= SNAPSHOT_CACHE_TTL_MS ? cache : null;
}

function cacheSnapshotMetadata(snapshot) {
  if (!snapshot?.snapshotId) return;
  latestMetadataCache = {
    snapshotId: snapshot.snapshotId,
    row: snapshot.row || null,
    cachedAt: Date.now(),
  };
}

function cacheStateSnapshot(snapshot) {
  if (!snapshot?.snapshotId || !snapshot?.state) return;
  latestStateCache = {
    snapshotId: snapshot.snapshotId,
    row: snapshot.row || null,
    state: snapshot.state,
    cachedAt: Date.now(),
  };
  cacheSnapshotMetadata(snapshot);
}

function getSupabaseConfig() {
  const url = readEnv("SUPABASE_URL").replace(/\/$/, "");
  const apiKey = readEnv("SUPABASE_SECRET_KEY") || readEnv("SUPABASE_SERVICE_ROLE_KEY");
  const table = readEnv("SUPABASE_STATE_TABLE", "race_state_current");
  const rowId = readEnv("SUPABASE_STATE_ROW_ID", SUPABASE_ROW_ID_FALLBACK);

  if (!url || !apiKey) {
    throw new Error(
      "Supabase state backend is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  return { url, apiKey, table, rowId };
}

function isJwtLike(value) {
  return /^[^.]+\.[^.]+\.[^.]+$/.test(value);
}

function buildSupabaseHeaders({ prefer } = {}) {
  const config = getSupabaseConfig();
  const headers = {
    apikey: config.apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (isJwtLike(config.apiKey)) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  if (prefer) headers.Prefer = prefer;
  return headers;
}

function supabaseTableUrl(config, query = "") {
  return `${config.url}/rest/v1/${encodeURIComponent(config.table)}${query}`;
}

async function supabaseRequest(method, query = "", { body, headers } = {}) {
  const config = getSupabaseConfig();
  const response = await fetch(supabaseTableUrl(config, query), {
    method,
    headers: {
      ...buildSupabaseHeaders(),
      ...headers,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  if (response.ok) return response;

  const message = await response.text();
  throw new Error(`Supabase state request failed (${response.status}): ${message || response.statusText}`);
}

async function fetchStateRow({ metadataOnly = false } = {}) {
  const cached = metadataOnly
    ? freshCache(latestMetadataCache) || freshCache(latestStateCache)
    : freshCache(latestStateCache);
  if (cached) {
    return {
      snapshotId: cached.snapshotId,
      row: cached.row,
      state: metadataOnly ? null : cached.state,
    };
  }

  const config = getSupabaseConfig();
  const response = await supabaseRequest(
    "GET",
    `?id=eq.${encodeURIComponent(config.rowId)}&select=${metadataOnly ? "id,snapshot_id,updated_at" : "id,snapshot_id,state,updated_at"}`,
  );
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;

  const snapshot = {
    snapshotId: String(row.snapshot_id || createSnapshotId()),
    row,
    state: metadataOnly ? null : normalizePersistedState(row.state),
  };
  if (metadataOnly) {
    cacheSnapshotMetadata(snapshot);
  } else {
    cacheStateSnapshot(snapshot);
  }
  return snapshot;
}

async function writeStateRow(nextState) {
  const config = getSupabaseConfig();
  const state = normalizePersistedState({
    ...nextState,
    schemaVersion: getStateSchemaVersion(),
    updatedAt: isoNow(),
  });
  const snapshotId = createSnapshotId();

  const response = await supabaseRequest("POST", "?on_conflict=id", {
    body: {
      id: config.rowId,
      snapshot_id: snapshotId,
      state,
      updated_at: state.updatedAt,
    },
    headers: buildSupabaseHeaders({
      prefer: "resolution=merge-duplicates,return=representation",
    }),
  });
  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;

  return {
    snapshotId: String(row?.snapshot_id || snapshotId),
    row,
    state,
  };
}

export async function getLatestStateSnapshot() {
  const existing = await fetchStateRow();
  if (existing) return existing;
  const created = await writeStateRow(createEmptyPersistedState());
  cacheStateSnapshot(created);
  return created;
}

export async function createStateSnapshot(nextState) {
  const saved = await writeStateRow(nextState);
  cacheStateSnapshot(saved);
  return saved;
}

export async function getLatestStateSnapshotMetadata() {
  const existing = await fetchStateRow({ metadataOnly: true });
  if (existing) return existing;
  const created = await writeStateRow(createEmptyPersistedState());
  cacheStateSnapshot(created);
  return {
    snapshotId: created.snapshotId,
    row: created.row,
    state: null,
  };
}
