import {
  buildScoreRows,
  computeElapsedSeconds,
  displayTeamName,
  formatDuration,
  orderedCategories,
} from "./shared/race-view.js";
import { fetchSnapshot } from "./shared/public-fetch.js";

const API_PATH = "/api/public-scorecard";
const POLL_MS = 15000;

const state = {
  payload: null,
  snapshotId: null,
  refreshInFlight: false,
};

function setConnection(status, message) {
  const pill = document.querySelector("#scorecard-connection-pill");
  if (!pill) return;
  pill.dataset.status = status;
  pill.textContent = message;
}

function setUpdatedAt(value) {
  const pill = document.querySelector("#scorecard-updated-pill");
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
}

function renderScorecard() {
  const groups = document.querySelector("#public-score-groups");
  const summary = document.querySelector("#public-score-summary");
  const source = state.payload?.state || {};
  const teams = Array.isArray(source.teams) ? source.teams : [];
  const standings = buildScoreRows(teams);
  const categoryOrder = orderedCategories(teams, source.scorecardCategoryOrderDisplay || source.scorecardCategoryOrderMain || []);
  const overallByTeam = new Map(standings.map((row) => [row.team.id, row.overall]));
  const placeByTeam = new Map(standings.map((row) => [row.team.id, row.categoryPlace]));

  renderSummary(teams);
  setUpdatedAt(source.updatedAt || null);

  if (summary) {
    summary.textContent = `${standings.length} finished / ${Math.max(teams.length - standings.length, 0)} remaining`;
  }

  if (!groups) return;
  if (!categoryOrder.length) {
    groups.innerHTML = '<p class="score-empty">No categories available yet.</p>';
    return;
  }

  groups.innerHTML = categoryOrder.map((category) => {
    const categoryTeams = teams
      .filter((team) => (team.category || "Uncategorized") === category)
      .sort((left, right) => {
        const leftOverall = overallByTeam.get(left.id);
        const rightOverall = overallByTeam.get(right.id);
        if (leftOverall && rightOverall) return leftOverall - rightOverall;
        if (leftOverall) return -1;
        if (rightOverall) return 1;
        return String(left.boatNumber || "").localeCompare(String(right.boatNumber || ""), undefined, { numeric: true });
      });

    const body = categoryTeams.length
      ? categoryTeams.map((team) => {
          const place = placeByTeam.get(team.id);
          const overall = overallByTeam.get(team.id);
          const finished = Number.isFinite(overall);
          const time = finished ? formatDuration(computeElapsedSeconds(team)) : team.didNotFinish ? "DNF" : "-";
          const placeDisplay = finished ? place : team.didNotFinish ? "DNF" : "-";
          const overallDisplay = finished ? overall : "-";
          return `
            <tr>
              <td>${team.boatNumber || "-"}</td>
              <td>${displayTeamName(team)}</td>
              <td>${time}</td>
              <td>${placeDisplay}</td>
              <td>${overallDisplay}</td>
            </tr>
          `;
        }).join("")
      : '<tr><td colspan="5" class="score-empty">No teams registered</td></tr>';

    return `
      <article class="score-group">
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
              <th title="Boat">Boat</th>
              <th>Team</th>
              <th title="Time">Time</th>
              <th title="Place">Place</th>
              <th title="Rank">Rank</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </article>
    `;
  }).join("");
}

async function refreshScorecard() {
  if (state.refreshInFlight) return;
  state.refreshInFlight = true;
  const refreshButton = document.querySelector("#scorecard-refresh-button");
  if (refreshButton) refreshButton.disabled = true;
  setConnection("loading", "Checking feed");
  try {
    const result = await fetchSnapshot(API_PATH, state.snapshotId);
    state.snapshotId = result.snapshotId || state.snapshotId;
    if (result.changed && result.payload) {
      state.payload = result.payload;
      renderScorecard();
    }
    setConnection("live", "Published");
  } catch {
    setConnection("offline", "Offline");
  } finally {
    state.refreshInFlight = false;
    if (refreshButton) refreshButton.disabled = false;
  }
}

document.querySelector("#scorecard-refresh-button")?.addEventListener("click", () => {
  void refreshScorecard();
});

window.setInterval(() => {
  void refreshScorecard();
}, POLL_MS);

void refreshScorecard();
