// Thin API client. Requests go through Vite's /api proxy to the backend.
const BASE = "";

const TOKEN_KEY = "propmap_token";
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) =>
  t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

async function req(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { cache: "no-store", ...options, headers });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (Array.isArray(body.detail)) {
        detail = body.detail.map((d) => d.msg || JSON.stringify(d)).join("; ");
      } else {
        detail = body.detail || detail;
      }
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.status === 204 ? null : res.json();
}

const jsonBody = (body) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  // ---- auth ----
  login: (email, password) =>
    req("/api/auth/login", { method: "POST", ...jsonBody({ email, password }) }),
  register: (body) =>
    req("/api/auth/register", { method: "POST", ...jsonBody(body) }),
  me: () => req("/api/auth/me"),
  listUsers: () => req("/api/users"),
  grantMembership: (body) =>
    req("/api/memberships", { method: "POST", ...jsonBody(body) }),

  listSocieties: () => req("/api/societies"),
  getSociety: (id) => req(`/api/societies/${id}`),
  createSociety: (body) =>
    req("/api/societies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  updateSociety: (id, patch) =>
    req(`/api/societies/${id}`, { method: "PATCH", ...jsonBody(patch) }),
  getPlots: (id) => req(`/api/societies/${id}/plots`),

  listMaps: (societyId) => req(`/api/societies/${societyId}/maps`),
  getMap: (mapId) => req(`/api/maps/${mapId}`),
  georeference: (mapId, controlPoints) =>
    req(`/api/maps/${mapId}/georeference`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ control_points: controlPoints }),
    }),
  uploadMap: (societyId, file) => {
    const fd = new FormData();
    fd.append("file", file);
    return req(`/api/societies/${societyId}/maps`, { method: "POST", body: fd });
  },

  listMapPlots: (mapId) => req(`/api/maps/${mapId}/plots`),
  createPlot: (mapId, body) =>
    req(`/api/maps/${mapId}/plots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  createPlotsBatch: (mapId, plots, block) =>
    req(`/api/maps/${mapId}/plots/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plots, block }),
    }),
  getBlock: (blockId) => req(`/api/blocks/${blockId}`),
  reshapeBlock: (blockId, verts, cells) =>
    req(`/api/blocks/${blockId}/reshape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verts, cells }),
    }),
  updatePlot: (plotId, body) =>
    req(`/api/plots/${plotId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  bulkUpdatePlots: (ids, patch) =>
    req(`/api/plots/bulk`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, ...patch }),
    }),
  bulkDeletePlots: (ids) =>
    req(`/api/plots/bulk-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    }),
  deletePlot: (plotId) => req(`/api/plots/${plotId}`, { method: "DELETE" }),
  deletePlotGroup: (groupId) => req(`/api/plots/group/${groupId}`, { method: "DELETE" }),
  resetPlots: (mapId) => req(`/api/maps/${mapId}/plots`, { method: "DELETE" }),
  confirmMap: (mapId) => req(`/api/maps/${mapId}/confirm`, { method: "POST" }),
};
