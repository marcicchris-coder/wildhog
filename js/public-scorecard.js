import {
  buildScoreRows,
  computeElapsedSeconds,
  displayTeamName,
  formatDuration,
  normalizeCategoryName,
  orderedCategories,
  statusLabel,
  teamStatus,
} from "./shared/race-view.js";
import { fetchSnapshot } from "./shared/public-fetch.js";

const API_PATH = "/api/public-scorecard";
const POLL_MS = 15000;
const HIGHLIGHT_LIMIT = 5;

const state = {
  payload: null,
  snapshotId: null,
  refreshInFlight: false,
  selectedCategory: "all",
  compactHeader: false,
};

const COMPACT_HEADER_SCROLL_Y = 48;

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

function formatUpdatedStatus(value) {
  if (!value) return "Live Updates • Waiting for data";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Live Updates • Waiting for data";
  return `Live Updates • Updated ${parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
}

function setConnection(status, message) {
  const pill = document.querySelector("#scorecard-status-pill");
  if (!pill) return;
  pill.dataset.status = status;
  pill.textContent = message;
}

function setUpdatedAt(value) {
  const pill = document.querySelector("#scorecard-status-pill");
  if (pill) pill.textContent = formatUpdatedStatus(value);
}

function renderSummary(teams, updatedAt) {
  document.querySelector("#scorecard-summary-total").textContent = String(teams.length);
  document.querySelector("#scorecard-summary-finished").textContent = String(
    teams.filter((team) => team.finishTime && !team.didNotFinish).length,
  );
  document.querySelector("#scorecard-summary-racing").textContent = String(
    teams.filter((team) => team.startTime && !team.finishTime && !team.didNotFinish).length,
  );
  document.querySelector("#scorecard-summary-dnf").textContent = String(
    teams.filter((team) => team.didNotFinish).length,
  );
  setUpdatedAt(updatedAt);
}

function buildCategoryGroups(teams, standings, categoryOrder) {
  const overallByTeam = new Map(standings.map((row) => [row.team.id, row.overall]));
  const placeByTeam = new Map(standings.map((row) => [row.team.id, row.categoryPlace]));

  return categoryOrder.map((category) => {
    const categoryTeams = teams
      .filter((team) => normalizedCategory(team) === category)
      .sort((left, right) => {
        const leftOverall = overallByTeam.get(left.id);
        const rightOverall = overallByTeam.get(right.id);
        if (leftOverall && rightOverall) return leftOverall - rightOverall;
        if (leftOverall) return -1;
        if (rightOverall) return 1;
        const leftStatus = teamStatus(left);
        const rightStatus = teamStatus(right);
        const statusPriority = { finished: 0, racing: 1, ready: 2, registered: 3, dnf: 4 };
        const leftPriority = statusPriority[leftStatus] ?? 99;
        const rightPriority = statusPriority[rightStatus] ?? 99;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        return String(left.boatNumber || "").localeCompare(String(right.boatNumber || ""), undefined, { numeric: true });
      })
      .map((team) => {
        const overall = overallByTeam.get(team.id);
        const place = placeByTeam.get(team.id);
        const status = teamStatus(team);
        const finished = Number.isFinite(overall);
        return {
          team,
          overall,
          place,
          status,
          label: displayTeamName(team),
          time: finished ? formatDuration(computeElapsedSeconds(team)) : status === "dnf" ? "DNF" : statusLabel(status),
        };
      });

    const sublabel = categoryTeams.some((entry) => entry.status === "finished") ? "Top finishers" : "Live standings";
    return { category, sublabel, teams: categoryTeams };
  });
}

function latestFinishers(teams) {
  return teams
    .filter((team) => team.finishTime && !team.didNotFinish)
    .sort((left, right) => new Date(right.finishTime).getTime() - new Date(left.finishTime).getTime())
    .slice(0, HIGHLIGHT_LIMIT)
    .map((team) => ({
      boatNumber: team.boatNumber || "-",
      label: displayTeamName(team),
      category: normalizedCategory(team),
      meta: formatDuration(computeElapsedSeconds(team)),
    }));
}

function topOverall(standings) {
  return standings.slice(0, HIGHLIGHT_LIMIT).map((row) => ({
    boatNumber: row.team.boatNumber || "-",
    label: displayTeamName(row.team),
    category: normalizedCategory(row.team),
    meta: formatDuration(row.elapsedSeconds),
    place: row.overall,
  }));
}

function renderHighlightList(container, items, emptyMessage, ranked = false) {
  if (!container) return;
  if (!items.length) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
    return;
  }

  container.innerHTML = items.map((item, index) => `
    <article class="highlight-row">
      <div class="highlight-row-main">
        <span class="boat-chip">Boat ${escapeHtml(item.boatNumber)}</span>
        <div>
          <p class="highlight-row-name">${escapeHtml(item.label)}</p>
          <p class="highlight-row-meta">${escapeHtml(item.category)}</p>
        </div>
      </div>
      <div class="highlight-row-side">
        ${ranked ? `<span class="mini-rank">#${escapeHtml(item.place || index + 1)}</span>` : ""}
        <strong>${escapeHtml(item.meta)}</strong>
      </div>
    </article>
  `).join("");
}

function renderCategoryFilter(categories) {
  const select = document.querySelector("#category-filter-select");
  if (!select) return;

  const previous = state.selectedCategory;
  const options = ['<option value="all">All Categories</option>']
    .concat(categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`))
    .join("");

  select.innerHTML = options;

  if (previous !== "all" && categories.includes(previous)) {
    select.value = previous;
    state.selectedCategory = previous;
    return;
  }

  select.value = "all";
  state.selectedCategory = "all";
}

function podiumClass(place) {
  if (place === 1) return "is-first";
  if (place === 2) return "is-second";
  if (place === 3) return "is-third";
  return "";
}

function renderCategoryGroups(groups) {
  const container = document.querySelector("#public-category-groups");
  if (!container) return;

  const visibleGroups = state.selectedCategory === "all"
    ? groups
    : groups.filter((group) => group.category === state.selectedCategory);

  if (!visibleGroups.length) {
    container.innerHTML = '<div class="empty-state">No category results are available yet.</div>';
    return;
  }

  container.innerHTML = visibleGroups.map((group) => `
    <article class="category-card" id="category-${escapeHtml(group.category.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"))}">
      <header class="category-card-header">
        <div>
          <p class="category-kicker">${escapeHtml(group.sublabel)}</p>
          <h3>${escapeHtml(group.category)}</h3>
        </div>
        <span class="category-count">${group.teams.length} ${group.teams.length === 1 ? "entry" : "entries"}</span>
      </header>
      <div class="leaderboard-list">
        ${group.teams.length
          ? group.teams.map((entry) => {
              const isFinished = entry.status === "finished";
              const statusClass = isFinished ? podiumClass(entry.place) : `status-${entry.status}`;
              const placeDisplay = isFinished ? entry.place : entry.status === "dnf" ? "DNF" : "LIVE";
              const statusMeta = isFinished
                ? `Overall #${entry.overall}`
                : entry.status === "dnf"
                  ? "Did not finish"
                  : statusLabel(entry.status);

              return `
                <article class="leaderboard-row ${statusClass}">
                  <div class="leaderboard-place">
                    <span class="place-badge">${escapeHtml(placeDisplay)}</span>
                  </div>
                  <div class="leaderboard-main">
                    <div class="leaderboard-title-row">
                      <span class="boat-chip boat-chip-strong">Boat ${escapeHtml(entry.team.boatNumber || "-")}</span>
                      <h4>${escapeHtml(entry.label)}</h4>
                    </div>
                    <p class="leaderboard-meta">${escapeHtml(statusMeta)}</p>
                  </div>
                  <div class="leaderboard-time">
                    <strong>${escapeHtml(entry.time)}</strong>
                  </div>
                </article>
              `;
            }).join("")
          : '<div class="empty-state">No teams registered in this category yet.</div>'}
      </div>
    </article>
  `).join("");
}

function renderScorecard() {
  const summary = document.querySelector("#public-score-summary");
  const source = state.payload?.state || {};
  const teams = Array.isArray(source.teams) ? source.teams : [];
  const standings = buildScoreRows(teams);
  const categoryOrder = orderedCategories(
    teams,
    source.scorecardCategoryOrderDisplay || source.scorecardCategoryOrderMain || [],
  );
  const categoryGroups = buildCategoryGroups(teams, standings, categoryOrder);

  renderSummary(teams, source.updatedAt || null);
  renderCategoryFilter(categoryOrder);
  renderHighlightList(
    document.querySelector("#public-latest-finishers"),
    latestFinishers(teams),
    "No finishers recorded yet.",
  );
  renderHighlightList(
    document.querySelector("#public-top-overall"),
    topOverall(standings),
    "Standings will appear as finish times are recorded.",
    true,
  );
  renderCategoryGroups(categoryGroups);

  if (summary) {
    const finished = teams.filter((team) => team.finishTime && !team.didNotFinish).length;
    const racing = teams.filter((team) => team.startTime && !team.finishTime && !team.didNotFinish).length;
    summary.textContent = `${finished} finished, ${racing} still racing across ${categoryOrder.length} categories.`;
  }
}

function setCompactHeader(isCompact) {
  if (state.compactHeader === isCompact) return;
  state.compactHeader = isCompact;
  document.querySelector(".public-hero")?.classList.toggle("is-compact", isCompact);
}

function bindCompactHeader() {
  const header = document.querySelector(".public-hero");
  if (!header) return;

  let rafId = 0;

  const updateHeader = () => {
    rafId = 0;
    setCompactHeader(window.scrollY > COMPACT_HEADER_SCROLL_Y);
  };

  const onScroll = () => {
    if (rafId) return;
    rafId = window.requestAnimationFrame(updateHeader);
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  updateHeader();
}

async function refreshScorecard() {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  setConnection("loading", state.payload ? formatUpdatedStatus(state.payload.state?.updatedAt || null) : "Live Updates • Waiting for data");
  try {
    const result = await fetchSnapshot(API_PATH, state.snapshotId);
    state.snapshotId = result.snapshotId || state.snapshotId;
    if (result.changed && result.payload) {
      state.payload = result.payload;
      renderScorecard();
    }
    setConnection("live", formatUpdatedStatus(state.payload?.state?.updatedAt || null));
  } catch {
    setConnection("offline", "Live Updates • Feed offline");
  } finally {
    state.refreshInFlight = false;
  }
}

document.querySelector("#category-filter-select")?.addEventListener("change", (event) => {
  const value = event.target.value;
  state.selectedCategory = value;
  renderScorecard();

  const results = document.querySelector(".public-results");
  if (results && value !== "all") {
    results.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});

bindCompactHeader();

window.setInterval(() => {
  void refreshScorecard();
}, POLL_MS);

void refreshScorecard();
