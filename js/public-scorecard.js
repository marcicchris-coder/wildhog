import {
  buildScoreRows,
  computeElapsedSeconds,
  displayCategoryName,
  displayRosterName,
  displayTeamName,
  formatDuration,
  isRecreationCategory,
  normalizeCategoryName,
  orderedCategories,
  teamStatus,
} from "./shared/race-view.js";
import { fetchSnapshot } from "./shared/public-fetch.js";

const STATIC_PUBLIC_SCORECARD_ENABLED = true;
const STATIC_PUBLIC_SCORECARD_PATH = "/final-scorecard.json";
const API_PATH = "/api/public-scorecard";
const HIGHLIGHT_LIMIT = 5;
const SEARCH_INPUT_DEBOUNCE_MS = 120;

const state = {
  payload: null,
  snapshotId: null,
  refreshInFlight: false,
  selectedCategory: "all",
  searchQuery: "",
  compactHeader: false,
  collapsedCategories: new Set(),
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

function debounce(callback, waitMs) {
  let timerId = null;
  return (...args) => {
    if (timerId) window.clearTimeout(timerId);
    timerId = window.setTimeout(() => {
      timerId = null;
      callback(...args);
    }, waitMs);
  };
}

function normalizedCategory(team) {
  return normalizeCategoryName(team?.category || "Uncategorized");
}

function visibleCategory(team) {
  return displayCategoryName(normalizedCategory(team));
}

function categoryDomKey(category) {
  return String(category || "uncategorized").toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
}

function activePublicScorecardPath() {
  return STATIC_PUBLIC_SCORECARD_ENABLED ? STATIC_PUBLIC_SCORECARD_PATH : API_PATH;
}

function formatUpdatedStatus(value) {
  if (!value) return "Results locked";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Results locked";
  return `Results locked • Updated ${parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
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
  const unfinishedCount = teams.filter((team) => !team.finishTime && !team.didNotFinish).length;
  document.querySelector("#scorecard-summary-total").textContent = String(teams.length);
  document.querySelector("#scorecard-summary-finished").textContent = String(
    teams.filter((team) => team.finishTime && !team.didNotFinish).length,
  );
  document.querySelector("#scorecard-summary-racing").textContent = String(unfinishedCount);
  document.querySelector("#scorecard-summary-dnf").textContent = String(
    teams.filter((team) => team.didNotFinish).length,
  );
  setUpdatedAt(updatedAt);
}

function buildCategoryGroups(teams, standings, categoryOrder) {
  const overallByTeam = new Map(standings.map((row) => [row.team.id, row.overall]));
  const placeByTeam = new Map(standings.map((row) => [row.team.id, row.categoryPlace]));
  const statusPriority = { finished: 0, racing: 1, ready: 2, registered: 3, dnf: 4 };

  return categoryOrder.map((category) => {
    const entries = teams
      .filter((team) => normalizedCategory(team) === category)
      .sort((left, right) => {
        const leftOverall = overallByTeam.get(left.id);
        const rightOverall = overallByTeam.get(right.id);
        if (leftOverall && rightOverall) return leftOverall - rightOverall;
        if (leftOverall) return -1;
        if (rightOverall) return 1;
        const leftStatus = teamStatus(left);
        const rightStatus = teamStatus(right);
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
          roster: displayRosterName(team),
          boatNumber: String(team.boatNumber || "").trim(),
          time: finished ? formatDuration(computeElapsedSeconds(team)) : null,
          searchText: [
            team.boatNumber,
            displayTeamName(team),
            displayRosterName(team),
            team.sponsorName,
            team.racer1?.first,
            team.racer1?.last,
            team.racer2?.first,
            team.racer2?.last,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
        };
      });

    const finishers = entries.filter((entry) => entry.status === "finished");
    const active = entries.filter((entry) => entry.status === "racing");
    const dnf = entries.filter((entry) => entry.status === "dnf");
    const totalEntries = entries.length;
    const finishedCount = finishers.length;
    const activeCount = active.length;
    const remainingCount = Math.max(totalEntries - finishedCount - dnf.length, 0);
    const isFinal = totalEntries > 0 && remainingCount === 0;
    const featuredFinishers = finishers.slice(0, 3);

    return {
      category,
      entries,
      finishers,
      featuredFinishers,
      totalEntries,
      finishedCount,
      activeCount,
      remainingCount,
      isFinal,
      progressPercent: totalEntries ? Math.round((finishedCount / totalEntries) * 100) : 0,
      eyebrow: "Final standings",
      remainder: entries.filter((entry) => !featuredFinishers.some((finisher) => finisher.team.id === entry.team.id)),
    };
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
      category: visibleCategory(team),
      meta: formatDuration(computeElapsedSeconds(team)),
    }));
}

function topOverall(standings) {
  return standings.slice(0, HIGHLIGHT_LIMIT).map((row) => ({
    boatNumber: row.team.boatNumber || "-",
    label: displayTeamName(row.team),
    category: visibleCategory(row.team),
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
    .concat(categories.map((category) => `
      <option value="${escapeHtml(category)}">${escapeHtml(displayCategoryName(category))}</option>
    `))
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

function extendedPlaceClass(category, place) {
  if (!isRecreationCategory(category)) return "";
  if (place === 4) return "is-fourth";
  if (place === 5) return "is-fifth";
  return "";
}

function statusMarker(entry) {
  if (entry.status === "finished") {
    return { label: String(entry.place || "F"), className: podiumClass(entry.place) || "is-finished" };
  }
  if (entry.status === "racing") return { label: "LIVE", className: "status-live" };
  if (entry.status === "dnf") return { label: "OUT", className: "status-dnf" };
  return { label: "NS", className: "status-not-started" };
}

function secondaryLine(entry) {
  if (entry.status === "finished") return `Finished • ${entry.time || "-"}`;
  if (entry.status === "racing") return "On river";
  if (entry.status === "dnf") return "DNF";
  return "Not started";
}

function sideValue(entry) {
  if (entry.status === "finished" && Number.isFinite(entry.overall)) {
    return { primary: `#${entry.overall}`, secondary: "overall" };
  }
  if (entry.status === "finished") return { primary: "FINAL", secondary: "complete" };
  if (entry.status === "racing") return { primary: "RACE", secondary: "active" };
  if (entry.status === "dnf") return { primary: "FINAL", secondary: "result" };
  if (entry.status === "ready") return { primary: "READY", secondary: "staged" };
  return { primary: "REG", secondary: "entry" };
}

function renderSummaryChips(group) {
  const chips = [
    { label: "Entries", value: group.totalEntries },
    { label: "Finished", value: group.finishedCount },
    group.isFinal
      ? { label: "Complete", value: "100%" }
      : {
          label: group.activeCount > 0 ? "On river" : "Remaining",
          value: group.activeCount > 0 ? group.activeCount : group.remainingCount,
        },
  ];

  return chips.map((chip) => `
    <span class="category-summary-chip">
      <strong>${escapeHtml(chip.value)}</strong>
      <span>${escapeHtml(chip.label)}</span>
    </span>
  `).join("");
}

function renderProgressBar(group) {
  if (STATIC_PUBLIC_SCORECARD_ENABLED || group.isFinal || group.totalEntries === 0) return "";
  return `
    <div class="category-progress" aria-label="${escapeHtml(`${group.finishedCount} of ${group.totalEntries} finished`)}">
      <div class="category-progress-track">
        <span class="category-progress-fill" style="width: ${group.progressPercent}%"></span>
      </div>
      <div class="category-progress-meta">
        <span>${escapeHtml(`${group.finishedCount} of ${group.totalEntries} finished`)}</span>
        <span>${escapeHtml(`${group.progressPercent}% complete`)}</span>
      </div>
    </div>
  `;
}

function renderResultRow(entry, options = {}) {
  const marker = statusMarker(entry);
  const side = sideValue(entry);
  const compactClass = options.compact ? " is-compact" : "";
  const extendedClass = extendedPlaceClass(options.category, entry.place);
  const rowClasses = [marker.className, extendedClass, compactClass].filter(Boolean).join(" ");

  return `
    <article class="result-row ${rowClasses}">
      <div class="result-marker ${[marker.className, extendedClass].filter(Boolean).join(" ")}">
        <span>${escapeHtml(marker.label)}</span>
      </div>
      <div class="result-main">
        <div class="result-title-row">
          <span class="boat-chip boat-chip-strong">Boat ${escapeHtml(entry.team.boatNumber || "-")}</span>
          <h4>${escapeHtml(entry.label)}</h4>
        </div>
        <p class="result-secondary">${escapeHtml(secondaryLine(entry))}</p>
      </div>
      <div class="result-side">
        <strong>${escapeHtml(side.primary)}</strong>
        <span>${escapeHtml(side.secondary)}</span>
      </div>
    </article>
  `;
}

function renderCategoryCard(group) {
  const categoryKey = categoryDomKey(group.category);
  const searchActive = Boolean(state.searchQuery.trim());
  const expanded = searchActive || !state.collapsedCategories.has(group.category);
  const panelId = `category-panel-${categoryKey}`;
  const finalResultsMode = STATIC_PUBLIC_SCORECARD_ENABLED || group.isFinal;
  return `
    <article class="category-card ${expanded ? "is-expanded" : "is-collapsed"}" data-state="${finalResultsMode ? "final" : "live"}" data-category-key="${escapeHtml(categoryKey)}" id="category-${escapeHtml(categoryKey)}">
      <header class="category-card-header">
        <div class="category-card-heading-row">
          <div class="category-card-title">
            <p class="category-kicker">${escapeHtml(group.eyebrow)}</p>
            <h3>${escapeHtml(displayCategoryName(group.category))}</h3>
          </div>
          <button
            type="button"
            class="category-card-toggle"
            data-category-toggle="${escapeHtml(group.category)}"
            aria-expanded="${expanded ? "true" : "false"}"
            aria-controls="${escapeHtml(panelId)}"
            ${searchActive ? 'disabled aria-disabled="true"' : ""}
          >
            <span class="category-toggle-label">${searchActive ? "Filtered" : expanded ? "Collapse" : "Expand"}</span>
            <span class="category-toggle-icon" aria-hidden="true"></span>
          </button>
        </div>
        <div class="category-summary-chips">
          ${renderSummaryChips(group)}
        </div>
        ${renderProgressBar(group)}
      </header>
      <div id="${escapeHtml(panelId)}" class="${finalResultsMode ? "category-card-body category-card-body-final" : "category-card-body"}" ${expanded ? "" : "hidden"}>
        ${finalResultsMode
        ? `
          <div class="leaderboard-list final-featured-list">
            ${group.featuredFinishers.length
              ? group.featuredFinishers.map((entry) => renderResultRow(entry, { category: group.category })).join("")
              : '<div class="empty-state">No finishers have been recorded in this category.</div>'}
          </div>
          ${group.remainder.length
            ? `
              <div class="leaderboard-list leaderboard-list-tight">
                ${group.remainder.map((entry) => renderResultRow(entry, { compact: true, category: group.category })).join("")}
              </div>
            `
            : ""}
        `
        : `
          <div class="leaderboard-list">
            ${group.entries.length
              ? group.entries.map((entry) => renderResultRow(entry, { category: group.category })).join("")
              : '<div class="empty-state">No teams registered in this category yet.</div>'}
          </div>
        `}
      </div>
    </article>
  `;
}

function renderCategoryGroups(groups) {
  const container = document.querySelector("#public-category-groups");
  if (!container) return;

  const query = state.searchQuery.trim().toLowerCase();
  const visibleGroups = state.selectedCategory === "all"
    ? groups
    : groups.filter((group) => group.category === state.selectedCategory);
  const matchedGroups = visibleGroups
    .map((group) => {
      if (!query) return group;
      const matches = group.entries.filter((entry) => entry.searchText.includes(query));
      const matchedIds = new Set(matches.map((entry) => entry.team.id));
      const featuredFinishers = group.featuredFinishers.filter((entry) => matchedIds.has(entry.team.id));
      const remainder = group.remainder.filter((entry) => matchedIds.has(entry.team.id));
      return {
        ...group,
        entries: matches,
        finishers: group.finishers.filter((entry) => matchedIds.has(entry.team.id)),
        featuredFinishers,
        remainder,
      };
    })
    .filter((group) => group.entries.length > 0);

  if (!matchedGroups.length) {
    container.innerHTML = `<div class="empty-state">${
      query
        ? `No boats or racers matched "${escapeHtml(state.searchQuery.trim())}".`
        : "No category results are available yet."
    }</div>`;
    return;
  }

  container.innerHTML = matchedGroups.map((group) => renderCategoryCard(group)).join("");
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
    "No finishers were recorded in the final snapshot.",
  );
  renderHighlightList(
    document.querySelector("#public-top-overall"),
    topOverall(standings),
    "Final overall standings are shown below.",
    true,
  );
  renderCategoryGroups(categoryGroups);

  if (summary) {
    const finished = teams.filter((team) => team.finishTime && !team.didNotFinish).length;
    const dnf = teams.filter((team) => team.didNotFinish).length;
    const unfinished = teams.filter((team) => !team.finishTime && !team.didNotFinish).length;
    summary.textContent = `${finished} finishers, ${dnf} DNF, ${unfinished} without a finish time across ${categoryOrder.length} categories.`;
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
  setConnection("loading", state.payload ? formatUpdatedStatus(state.payload.state?.updatedAt || null) : "Loading official final results...");
  try {
    const result = await fetchSnapshot(activePublicScorecardPath(), state.snapshotId);
    state.snapshotId = result.snapshotId || state.snapshotId;
    if (result.changed && result.payload) {
      state.payload = result.payload;
      renderScorecard();
    }
    setConnection("final", formatUpdatedStatus(state.payload?.state?.updatedAt || null));
  } catch {
    setConnection("offline", "Official final results unavailable");
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

document.querySelector("#scorecard-search-input")?.addEventListener("input", debounce((event) => {
  state.searchQuery = event.target.value || "";
  renderScorecard();
}, SEARCH_INPUT_DEBOUNCE_MS));

document.querySelector("#public-category-groups")?.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-category-toggle]");
  if (!toggle || toggle.hasAttribute("disabled")) return;

  const { categoryToggle } = toggle.dataset;
  if (!categoryToggle) return;

  if (state.collapsedCategories.has(categoryToggle)) {
    state.collapsedCategories.delete(categoryToggle);
  } else {
    state.collapsedCategories.add(categoryToggle);
  }

  renderScorecard();
});

bindCompactHeader();

if (!STATIC_PUBLIC_SCORECARD_ENABLED) {
  window.setInterval(() => {
    if (document.hidden) return;
    void refreshScorecard();
  }, 15000);
}

void refreshScorecard();
