export async function fetchSnapshot(apiPath, snapshotId = null) {
  const url = new URL(apiPath, window.location.origin);
  if (snapshotId) {
    url.searchParams.set("since", snapshotId);
  }

  const response = await fetch(url.toString(), {
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
    },
  });

  if (response.status === 204) {
    return {
      changed: false,
      snapshotId,
      payload: null,
    };
  }

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}).`);
  }

  const payload = await response.json();
  return {
    changed: true,
    snapshotId: payload.snapshotId || snapshotId || null,
    payload,
  };
}
