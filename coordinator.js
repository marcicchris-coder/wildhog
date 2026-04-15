import {
  displayRosterName,
  formatClock,
  formatPenaltyMinutes,
  normalizeBoat,
  statusLabel,
  teamStatus,
} from "./js/shared/race-view.js";
import { fetchSnapshot } from "./js/shared/public-fetch.js";

const API_PATH = "/api/public-coordinator";
const POLL_MS = 15000;

const state = {
  payload: null,
  snapshotId: null,
  statusFilter: "all",
  categoryFilter: "all",
  searchQuery: "",
  refreshInFlight: false,
};

function teamSearchText(team) {
  return [
    team.boatNumber,
    team.category,
    displayRosterName(team),
    statusLabel(teamStatus(team)),
  ].join(" ").toLowerCase();
}

function setConnection(status, message) {
  const pill = document.querySelector("#connection-pill");
  if (!pill) return;
  pill.dataset.status = status;
  pill.textContent = message;
}

function setUpdatedAt(value) {
  const pill = document.querySelector("#updated-pill");
  if (!pill) return;
  if (!value) {
    pill.textContent = "Waiting for data";
    return;
  }
  const parsed = new Date(value);
  pill.textContent = Number.isNaN(parsed.getTime())
    ? "Waiting for data"
    : `Updated ${parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
}

function renderSummary(teams) {
  const counts = {
    total: teams.length,
    checkedIn: teams.filter((team) => team.checkedIn).length,
    racing: teams.filter((team) => teamStatus(team) === "racing").length,
    finished: teams.filter((team) => ["finished", "dnf"].includes(teamStatus(team))).length,
  };

  document.querySelector("#summary-total").textContent = String(counts.total);
  document.querySelector("#summary-checked-in").textContent = String(counts.checkedIn);
  document.querySelector("#summary-racing").textContent = String(counts.racing);
  document.querySelector("#summary-finished").textContent = String(counts.finished);
}

function renderCategoryOptions(teams) {
  const select = document.querySelector("#category-filter");
  if (!select) return;
  const categories = [...new Set(teams.map((team) => team.category || "Uncategorized"))]
    .sort((left, right) => left.localeCompare(right));

  select.innerHTML = [
    '<option value="all">All categories</option>',
    ...categories.map((category) => `<option value="${category}">${category}</option>`),
  ].join("");
  select.value = categories.includes(state.categoryFilter) ? state.categoryFilter : "all";
}

function renderTable(teams) {
  const tbody = document.querySelector("#board-table-body");
  const summary = document.querySelector("#table-summary");
  if (!tbody || !summary) return;

  const query = state.searchQuery.trim().toLowerCase();
  const filtered = teams
    .filter((team) => (state.statusFilter === "all" ? true : teamStatus(team) === state.statusFilter))
    .filter((team) => (state.categoryFilter === "all" ? true : (team.category || "Uncategorized") === state.categoryFilter))
    .filter((team) => (query ? teamSearchText(team).includes(query) : true))
    .sort((left, right) => normalizeBoat(left.boatNumber).localeCompare(normalizeBoat(right.boatNumber), undefined, { numeric: true }));

  summary.textContent = `${filtered.length} of ${teams.length} team(s) shown`;

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-cell">No teams match the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((team) => {
    const status = teamStatus(team);
    return `
      <tr>
        <td><span class="boat-pill">${team.boatNumber || "-"}</span></td>
        <td>
          <div class="racers">
            <span class="racer-line">${displayRosterName(team)}</span>
          </div>
        </td>
        <td>${team.category || "Uncategorized"}</td>
        <td><span class="status-pill" data-status="${status}">${statusLabel(status)}</span></td>
        <td>${formatClock(team.startTime)}</td>
        <td>${formatClock(team.finishTime)}</td>
        <td>${formatPenaltyMinutes(team.penaltySeconds)}</td>
      </tr>
    `;
  }).join("");
}

function render() {
  const teams = state.payload?.state?.teams || [];
  renderSummary(teams);
  renderCategoryOptions(teams);
  renderTable(teams);
  setUpdatedAt(state.payload?.state?.updatedAt || null);
}

async function refreshData() {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  const refreshButton = document.querySelector("#refresh-button");
  if (refreshButton) refreshButton.disabled = true;
  setConnection("loading", "Checking feed");
  try {
    const result = await fetchSnapshot(API_PATH, state.snapshotId);
    state.snapshotId = result.snapshotId || state.snapshotId;
    if (result.changed && result.payload) {
      state.payload = result.payload;
      render();
    }
    setConnection("live", "Published");
  } catch {
    setConnection("offline", "Offline");
  } finally {
    state.refreshInFlight = false;
    if (refreshButton) refreshButton.disabled = false;
  }
}

document.querySelector("#refresh-button")?.addEventListener("click", () => {
  void refreshData();
});

document.querySelector("#search-input")?.addEventListener("input", (event) => {
  state.searchQuery = event.currentTarget.value;
  render();
});

document.querySelector("#status-filter")?.addEventListener("change", (event) => {
  state.statusFilter = event.currentTarget.value;
  render();
});

document.querySelector("#category-filter")?.addEventListener("change", (event) => {
  state.categoryFilter = event.currentTarget.value;
  render();
});

window.setInterval(() => {
  void refreshData();
}, POLL_MS);

void refreshData();
