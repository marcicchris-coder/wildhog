import {
  buildScoreRows,
  displayRosterName,
  displayTeamName,
  formatClock,
  formatDuration,
  formatPenaltyMinutes,
  normalizeBoat,
  normalizeCategoryName,
  orderedCategories,
  statusLabel,
  teamStatus,
} from "./js/shared/race-view.js";
import { fetchSnapshot } from "./js/shared/public-fetch.js";

const API_PATH = "/api/public-racecontrol";
const POLL_MS = 15000;
const HIGHLIGHT_LIMIT = 5;
const OVERALL_AWARDS_LIMIT = 3;

const state = {
  payload: null,
  snapshotId: null,
  statusFilter: "all",
  categoryFilter: "all",
  searchQuery: "",
  refreshInFlight: false,
  activeView: "overview",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizedCategory(team) {
  return normalizeCategoryName(team?.category || "Uncategorized");
}

function teamSearchText(team) {
  return [
    team.boatNumber,
    team.category,
    displayRosterName(team),
    statusLabel(teamStatus(team)),
  ].join(" ").toLowerCase();
}

function teamNeedsAttention(team) {
  return Boolean(team?.didNotFinish)
    || Number(team?.penaltySeconds || 0) > 0
    || Boolean(team?.finishTime && !team?.startTime);
}

function attentionReason(team) {
  if (team?.didNotFinish) return "DNF";
  if (Number(team?.penaltySeconds || 0) > 0) return formatPenaltyMinutes(team.penaltySeconds);
  if (team?.finishTime && !team?.startTime) return "Finish time missing start";
  return "Needs review";
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
    finished: teams.filter((team) => teamStatus(team) === "finished").length,
    dnf: teams.filter((team) => teamStatus(team) === "dnf").length,
    attention: teams.filter(teamNeedsAttention).length,
  };

  document.querySelector("#summary-total").textContent = String(counts.total);
  document.querySelector("#summary-checked-in").textContent = String(counts.checkedIn);
  document.querySelector("#summary-racing").textContent = String(counts.racing);
  document.querySelector("#summary-finished").textContent = String(counts.finished);
  document.querySelector("#summary-dnf").textContent = String(counts.dnf);
  document.querySelector("#summary-attention").textContent = String(counts.attention);
}

function renderCategoryOptions(teams) {
  const select = document.querySelector("#category-filter");
  if (!select) return;
  const categories = [...new Set(teams.map((team) => team.category || "Uncategorized"))]
    .sort((left, right) => left.localeCompare(right));

  select.innerHTML = [
    '<option value="all">All categories</option>',
    ...categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`),
  ].join("");
  select.value = categories.includes(state.categoryFilter) ? state.categoryFilter : "all";
}

function renderEmptyState(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function renderStillRacing(teams) {
  const container = document.querySelector("#still-racing-list");
  const summary = document.querySelector("#still-racing-summary");
  if (!container || !summary) return;

  const rows = teams
    .filter((team) => teamStatus(team) === "racing")
    .sort((left, right) => new Date(left.startTime).getTime() - new Date(right.startTime).getTime());

  summary.textContent = `${rows.length} boat${rows.length === 1 ? "" : "s"} on course`;

  if (!rows.length) {
    container.innerHTML = renderEmptyState("No boats are currently racing.");
    return;
  }

  container.innerHTML = rows.map((team) => `
    <article class="dashboard-row">
      <span class="boat-pill">Boat ${escapeHtml(team.boatNumber || "-")}</span>
      <div class="dashboard-row-main">
        <p class="dashboard-row-title">
          <span>${escapeHtml(displayTeamName(team))}</span>
          <span class="status-pill" data-status="racing">Racing</span>
        </p>
        <p class="dashboard-row-meta">${escapeHtml(normalizedCategory(team))}</p>
      </div>
      <div class="dashboard-row-side">
        <strong>${escapeHtml(formatClock(team.startTime))}</strong>
        <span class="muted">Started</span>
      </div>
    </article>
  `).join("");
}

function renderLatestFinishers(teams) {
  const container = document.querySelector("#latest-finishers-list");
  const summary = document.querySelector("#latest-finishers-summary");
  if (!container || !summary) return;

  const rows = teams
    .filter((team) => teamStatus(team) === "finished")
    .sort((left, right) => new Date(right.finishTime).getTime() - new Date(left.finishTime).getTime())
    .slice(0, HIGHLIGHT_LIMIT);

  summary.textContent = rows.length ? `${rows.length} most recent finishers` : "Waiting for finishers";

  if (!rows.length) {
    container.innerHTML = renderEmptyState("Finishers will appear here as boats cross the line.");
    return;
  }

  container.innerHTML = rows.map((team) => `
    <article class="dashboard-row">
      <span class="boat-pill">Boat ${escapeHtml(team.boatNumber || "-")}</span>
      <div class="dashboard-row-main">
        <p class="dashboard-row-title">
          <span>${escapeHtml(displayTeamName(team))}</span>
          <span class="status-pill" data-status="finished">Finished</span>
        </p>
        <p class="dashboard-row-meta">${escapeHtml(normalizedCategory(team))}</p>
      </div>
      <div class="dashboard-row-side">
        <strong>${escapeHtml(formatClock(team.finishTime))}</strong>
        <span class="muted">At finish</span>
      </div>
    </article>
  `).join("");
}

function renderAttention(teams) {
  const container = document.querySelector("#attention-list");
  const summary = document.querySelector("#attention-summary");
  if (!container || !summary) return;

  const rows = teams
    .filter(teamNeedsAttention)
    .sort((left, right) => normalizeBoat(left.boatNumber).localeCompare(normalizeBoat(right.boatNumber), undefined, { numeric: true }));

  summary.textContent = rows.length
    ? `${rows.length} team${rows.length === 1 ? "" : "s"} with penalties`
    : "No teams with penalties";

  if (!rows.length) {
    container.innerHTML = renderEmptyState("No teams with penalties right now.");
    return;
  }

  container.innerHTML = rows.map((team) => {
    const status = teamStatus(team);
    return `
      <article class="dashboard-row">
        <span class="boat-pill">Boat ${escapeHtml(team.boatNumber || "-")}</span>
        <div class="dashboard-row-main">
          <p class="dashboard-row-title">
            <span>${escapeHtml(displayTeamName(team))}</span>
            <span class="status-pill" data-status="${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
          </p>
          <p class="dashboard-row-meta">${escapeHtml(normalizedCategory(team))}</p>
        </div>
        <div class="dashboard-row-side">
          <strong class="attention-badge">${escapeHtml(attentionReason(team))}</strong>
        </div>
      </article>
    `;
  }).join("");
}

function renderCategoryProgress(teams, source) {
  const container = document.querySelector("#category-progress-list");
  const summary = document.querySelector("#category-progress-summary");
  if (!container || !summary) return;

  const categories = orderedCategories(
    teams,
    source?.scorecardCategoryOrderDisplay || source?.scorecardCategoryOrderMain || [],
  );

  summary.textContent = `${categories.length} categor${categories.length === 1 ? "y" : "ies"} in rotation`;

  if (!categories.length) {
    container.innerHTML = renderEmptyState("Category progress will appear when teams are available.");
    return;
  }

  container.innerHTML = categories.map((category) => {
    const categoryTeams = teams.filter((team) => normalizedCategory(team) === category);
    const totals = {
      total: categoryTeams.length,
      racing: categoryTeams.filter((team) => teamStatus(team) === "racing").length,
      finished: categoryTeams.filter((team) => teamStatus(team) === "finished").length,
      dnf: categoryTeams.filter((team) => teamStatus(team) === "dnf").length,
    };

    return `
      <article class="progress-card">
        <h3>${escapeHtml(category)}</h3>
        <p class="progress-meta">${totals.total} total teams</p>
        <div class="progress-counts">
          <span class="count-chip">${totals.racing} racing</span>
          <span class="count-chip">${totals.finished} finished</span>
          <span class="count-chip">${totals.dnf} DNF</span>
        </div>
      </article>
    `;
  }).join("");
}

function placeBadgeClass(place) {
  if (place === 1) return "place-1";
  if (place === 2) return "place-2";
  if (place === 3) return "place-3";
  if (place === 4) return "place-4";
  if (place === 5) return "place-5";
  return "place-default";
}

function renderAwards(teams, source) {
  const summary = document.querySelector("#awards-summary");
  const overallEl = document.querySelector("#awards-overall");
  const categoriesEl = document.querySelector("#awards-categories");
  if (!summary || !overallEl || !categoriesEl) return;

  const rows = buildScoreRows(teams);
  const categories = orderedCategories(
    teams,
    source?.scorecardCategoryOrderDisplay || source?.scorecardCategoryOrderMain || [],
  );

  summary.textContent = rows.length
    ? `Awards from ${rows.length} completed finish${rows.length === 1 ? "" : "ers"}.`
    : "No completed finishers yet. Awards populate automatically from current results.";

  const overallRows = rows.slice(0, OVERALL_AWARDS_LIMIT);
  overallEl.innerHTML = overallRows.length
    ? overallRows.map((row) => `
        <article class="award-row">
          <span class="place-badge ${placeBadgeClass(row.overall)}">${row.overall}</span>
          <div class="award-row-main">
            <h3>${escapeHtml(displayTeamName(row.team))}</h3>
            <p class="award-row-meta">Boat ${escapeHtml(row.team.boatNumber || "-")} · ${escapeHtml(normalizedCategory(row.team))}</p>
          </div>
          <div class="award-row-side">
            <strong>${escapeHtml(formatDuration(row.elapsedSeconds))}</strong>
            <span class="muted">Overall</span>
          </div>
        </article>
      `).join("")
    : renderEmptyState("Overall winners will appear once finish times are recorded.");

  const categoryCards = categories.map((category) => {
    const categoryKey = normalizeCategoryName(category).toLowerCase();
    const isRecreation = categoryKey.includes("recreation");
    const limit = isRecreation ? 5 : 3;
    const winners = rows
      .filter((row) => normalizeCategoryName(row.team.category || "Uncategorized").toLowerCase() === categoryKey)
      .slice(0, limit);

    return `
      <article class="progress-card">
        <h3>${escapeHtml(category)}</h3>
        <p class="progress-meta">${isRecreation ? "Places 1 through 5" : "Places 1 through 3"}</p>
        <div class="panel-list">
          ${winners.length
            ? winners.map((row) => `
                <article class="award-row">
                  <span class="place-badge ${placeBadgeClass(row.categoryPlace)}">${row.categoryPlace}</span>
                  <div class="award-row-main">
                    <h3>${escapeHtml(displayTeamName(row.team))}</h3>
                    <p class="award-row-meta">Boat ${escapeHtml(row.team.boatNumber || "-")}</p>
                  </div>
                  <div class="award-row-side">
                    <strong>${escapeHtml(formatDuration(row.elapsedSeconds))}</strong>
                    <span class="muted">${escapeHtml(normalizedCategory(row.team))}</span>
                  </div>
                </article>
              `).join("")
            : renderEmptyState("No finishers yet")}
        </div>
      </article>
    `;
  });

  categoriesEl.innerHTML = categoryCards.length
    ? categoryCards.join("")
    : renderEmptyState("Category awards will appear when results are available.");
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
        <td><span class="boat-pill">${escapeHtml(team.boatNumber || "-")}</span></td>
        <td>
          <div class="racers">
            <span class="racer-line">${escapeHtml(displayRosterName(team))}</span>
          </div>
        </td>
        <td>${escapeHtml(team.category || "Uncategorized")}</td>
        <td><span class="status-pill" data-status="${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span></td>
        <td>${escapeHtml(formatClock(team.startTime))}</td>
        <td>${escapeHtml(formatClock(team.finishTime))}</td>
        <td>${escapeHtml(formatPenaltyMinutes(team.penaltySeconds))}</td>
      </tr>
    `;
  }).join("");
}

function renderViewState() {
  document.querySelectorAll(".view-tab").forEach((button) => {
    const isActive = button.dataset.view === state.activeView;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== state.activeView;
    panel.classList.toggle("is-active", panel.dataset.viewPanel === state.activeView);
  });
}

function render() {
  const source = state.payload?.state || {};
  const teams = Array.isArray(source.teams) ? source.teams : [];

  renderSummary(teams);
  renderCategoryOptions(teams);
  renderStillRacing(teams);
  renderLatestFinishers(teams);
  renderAttention(teams);
  renderCategoryProgress(teams, source);
  renderAwards(teams, source);
  renderTable(teams);
  renderViewState();
  setUpdatedAt(source.updatedAt || null);
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

document.querySelectorAll(".view-tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.activeView = button.dataset.view || "overview";
    renderViewState();
  });
});

document.querySelector("#search-input")?.addEventListener("input", (event) => {
  state.searchQuery = event.currentTarget.value;
  renderTable(state.payload?.state?.teams || []);
});

document.querySelector("#status-filter")?.addEventListener("change", (event) => {
  state.statusFilter = event.currentTarget.value;
  renderTable(state.payload?.state?.teams || []);
});

document.querySelector("#category-filter")?.addEventListener("change", (event) => {
  state.categoryFilter = event.currentTarget.value;
  renderTable(state.payload?.state?.teams || []);
});

window.setInterval(() => {
  void refreshData();
}, POLL_MS);

renderViewState();
void refreshData();
