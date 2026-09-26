const BASE = "/api";

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 10000;

/**
 * Validates that the response data is not null or undefined.
 */
function validateResponse(data, endpoint) {
  if (data === null || data === undefined) {
    throw new Error(`Invalid response from ${endpoint}: received ${data}`);
  }
  return data;
}

/**
 * Calculates delay for next retry using exponential backoff with jitter.
 */
function calculateDelay(attempt) {
  const exponentialDelay = INITIAL_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, MAX_DELAY_MS);
}

/**
 * Checks if an error is retryable (network errors, 5xx, 429).
 */
function isRetryableError(status) {
  if (!status) return true; // Network errors are retryable
  return status >= 500 || status === 429;
}

/**
 * Safely executes an API call and returns null on failure.
 */
async function safeRequest(path, options = {}) {
  try {
    return await request(path, options);
  } catch (error) {
    console.error(`Safe request failed for ${path}:`, error.message);
    return null;
  }
}

/**
 * Like request(), but for endpoints that answer text (the worksheet's plain-text
 * form) instead of JSON.
 */
async function requestText(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const body = await res.text();
  if (!res.ok) {
    // The API answers errors as JSON even on text routes; surface its message.
    let message = `Request failed: ${res.status}`;
    try {
      message = JSON.parse(body)?.error || message;
    } catch {
      /* not JSON — keep the status line */
    }
    throw new Error(`${message} (${path})`);
  }
  return body;
}

async function request(path, options = {}, retryCount = 0) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(`${BASE}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const isJson = res.headers.get("content-type")?.includes("application/json");
    const body = isJson ? await res.json().catch(() => null) : null;

    if (!res.ok) {
      const errorMessage = body?.error || `Request failed: ${res.status}`;
      const error = new Error(errorMessage);
      error.status = res.status;
      error.retryable = isRetryableError(res.status);
      throw error;
    }

    // DELETE endpoints (and some others) answer 204 No Content, i.e. a
    // successful response WITHOUT a JSON body. That is a valid outcome, not
    // an invalid response.
    if (res.status === 204 || body === null) {
      return { ok: true, status: res.status };
    }

    return validateResponse(body, path);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timeout for ${path}`);
    }

    if (error.retryable && retryCount < MAX_RETRIES) {
      const delay = calculateDelay(retryCount);
      console.warn(`Retrying ${path} (attempt ${retryCount + 1}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return request(path, options, retryCount + 1);
    }

    if (!error.message.includes('Request timeout')) {
      error.message = `${error.message} (${path})`;
    }
    throw error;
  }
}

/**
 * URL of a QR image for arbitrary text, rendered by the API as SVG. Used as an
 * `<img src>` so the browser fetches it directly — no blob juggling, and the
 * image survives a re-render.
 */
export function qrSvgUrl(data, { ec = "M", scale = 6, quiet = 4 } = {}) {
  const query = new URLSearchParams({ data: String(data), ec, scale: String(scale), quiet: String(quiet) });
  return `${BASE}/qr/svg?${query}`;
}

/** The link a tag for this thing carries — the frontend builds it, because it
 *  knows its own origin (the deployed app is not always on the API's host). */
export function qrLink(kind, id, { base = "" } = {}) {
  const params = { pole: "pole", box: "box", enclosure: "box", cable: "cable", customer: "customer" };
  const param = params[String(kind).toLowerCase()];
  if (!param || !id) return null;
  return {
    kind: param,
    id,
    link: `${String(base).replace(/\/+$/, "")}/?${param}=${encodeURIComponent(id)}`,
  };
}

export const api = {
  // Poles
  listPoles: () => request("/poles"),
  createPole: (data) =>
    request("/poles", { method: "POST", body: JSON.stringify(data) }),
  deletePole: (id) => request(`/poles/${id}`, { method: "DELETE" }),

  // Enclosures
  listEnclosures: () => request("/enclosures"),
  createEnclosure: (data) =>
    request("/enclosures", { method: "POST", body: JSON.stringify(data) }),
  // Documentation changes after cable splitting/insertion; bust an intermediary
  // GET cache so the open upstream box immediately sees the new OUT segment and
  // its core statuses.
  getBoxDocumentation: (id) =>
    request(`/enclosures/${id}/documentation?refresh=${Date.now()}`),

  // Field work: a worksheet generated from a box's documentation, and the QR
  // tags that open that documentation when scanned.
  getWorkOrder: (boxId, { by = null, kind = null } = {}) => {
    const query = new URLSearchParams();
    if (by) query.set("by", by);
    if (kind) query.set("kind", kind);
    const suffix = query.toString() ? `?${query}` : "";
    return request(`/work-orders/${boxId}${suffix}`);
  },
  getWorkOrderText: (boxId, { by = null, kind = null } = {}) => {
    const query = new URLSearchParams();
    if (by) query.set("by", by);
    if (kind) query.set("kind", kind);
    const suffix = query.toString() ? `?${query}` : "";
    return requestText(`/work-orders/${boxId}/text${suffix}`);
  },
  qrLinkInfo: (kind, id, params = {}) => qrLink(kind, id, params),
  getVisualization: (id) => request(`/enclosures/${id}/visualization`),
  updateEnclosure: (id, data) =>
    request(`/enclosures/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteEnclosure: (id) => request(`/enclosures/${id}`, { method: "DELETE" }),

  // Cables
  listCables: () => request("/cables"),
  getCable: (id) => request(`/cables/${id}`),
  createCable: (data) =>
    request("/cables", { method: "POST", body: JSON.stringify(data) }),
  updateCable: (id, data) =>
    request(`/cables/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteCable: (id) => request(`/cables/${id}`, { method: "DELETE" }),
  previewCableRoute: (data) =>
    request("/cables/route-preview", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getSplitInfo: (id) => request(`/cables/${id}/split-info`),
  insertEnclosureOnCable: (id, data) =>
    request(`/cables/${id}/insert-enclosure`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Customers
  listCustomers: () => request("/customers"),
  createCustomer: (data) =>
    request("/customers", { method: "POST", body: JSON.stringify(data) }),

  // Splices
  createSplice: (data) =>
    request("/splices", { method: "POST", body: JSON.stringify(data) }),
  updateSplice: (id, data) =>
    request(`/splices/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteSplice: (id) => request(`/splices/${id}`, { method: "DELETE" }),
  unspliceCore: (coreId, enclosureId = null) => {
    const suffix = enclosureId ? `?enclosure_id=${encodeURIComponent(enclosureId)}` : "";
    return request(`/splices/by-core/${coreId}${suffix}`, { method: "DELETE" });
  },

  // Splitters
  listSplitters: (enclosureId) => request(`/splitters?enclosureId=${enclosureId}`),
  getSplitter: (id) => request(`/splitters/${id}`),
  createSplitter: (data) =>
    request("/splitters", { method: "POST", body: JSON.stringify(data) }),
  updateSplitter: (id, data) =>
    request(`/splitters/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteSplitter: (id) => request(`/splitters/${id}`, { method: "DELETE" }),
  assignCoreToPort: (splitterId, portNumber, coreId) =>
    request(`/splitters/${splitterId}/assign-port`, {
      method: "POST",
      body: JSON.stringify({ port_number: portNumber, core_id: coreId }),
    }),
  unassignCoreFromPort: (splitterId, portNumber) =>
    request(`/splitters/${splitterId}/assign-port?port_number=${portNumber}`, {
      method: "DELETE",
    }),

  // Fiber cores
  traceFiber: (coreId) => request(`/fiber-cores/${coreId}/trace`),
  getLossBudget: (coreId, oltType) =>
    request(
      `/fiber-cores/${coreId}/loss-budget${oltType ? `?olt_type=${oltType}` : ""}`,
    ),
  updateCore: (id, data) =>
    request(`/fiber-cores/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  // Capacity
  capacityByEnclosure: () => request("/capacity/enclosures"),
  findSource: (enclosureId) =>
    request(`/capacity/find-source?enclosureId=${enclosureId}`),
  customerLookup: (lat, lng, radius = 500) =>
    request(`/capacity/customer-lookup?lat=${lat}&lng=${lng}&radius=${radius}`),
  getCustomerRoute: (customerLat, customerLng, enclosureId) =>
    request(`/capacity/customer-route?customerLat=${customerLat}&customerLng=${customerLng}&enclosureId=${enclosureId}`),

  // Project settings (loss budget: OLT type, budget / safety-margin overrides)
  getSettings: () => request("/settings"),
  updateSettings: (data) =>
    request("/settings", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  // Outage / impact analysis — simulate a box failure only. The backend follows
  // connected fibres and splitter ports downstream; it never treats the input
  // cable as the failed element.
  simulateImpact: (kind, id) => {
    const params = new URLSearchParams({ kind, id });
    return request(`/impact/simulate?${params.toString()}`);
  },

  // Headends — the network root (OLT/CO) that gives every trace a direction
  listHeadends: () => request("/headends"),
  createHeadend: (data) =>
    request("/headends", { method: "POST", body: JSON.stringify(data) }),
  updateHeadend: (id, data) =>
    request(`/headends/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deleteHeadend: (id) => request(`/headends/${id}`, { method: "DELETE" }),

  // Serviceability — "can we serve this address, from which box, at what cost?"
  // The sales/CSR question. One call answers it: pass an address, or the point
  // from the map (lat/lng). `options.route === false` skips the street route.
  checkServiceability: ({ address, lat, lng, radiusM, limit, route } = {}) => {
    const params = new URLSearchParams();
    if (address) params.set("address", address);
    if (lat != null && lng != null) {
      params.set("lat", String(lat));
      params.set("lng", String(lng));
    }
    if (radiusM != null) params.set("radius_m", String(radiusM));
    if (limit != null) params.set("limit", String(limit));
    if (route === false) params.set("route", "0");
    return request(`/serviceability/check?${params.toString()}`);
  },

  // The same answer as printable text (phone / CRM / WhatsApp) and as an install
  // work order for the crew. URLs rather than fetches: they open in a tab.
  serviceabilityTextUrl: ({ address, lat, lng } = {}) => {
    const params = new URLSearchParams();
    if (address) params.set("address", address);
    if (lat != null && lng != null) {
      params.set("lat", String(lat));
      params.set("lng", String(lng));
    }
    return `/api/serviceability/check/text?${params.toString()}`;
  },
  serviceabilitySheetUrl: ({ address, lat, lng } = {}) => {
    const params = new URLSearchParams();
    if (address) params.set("address", address);
    if (lat != null && lng != null) {
      params.set("lat", String(lat));
      params.set("lng", String(lng));
    }
    return `/api/serviceability/check/sheet/text?${params.toString()}`;
  },

  // Health check
  health: () => safeRequest("/health"),
};
