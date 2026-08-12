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
  getBoxDocumentation: (id) => request(`/enclosures/${id}/documentation`),
  getVisualization: (id) => request(`/enclosures/${id}/visualization`),
  deleteEnclosure: (id) => request(`/enclosures/${id}`, { method: "DELETE" }),

  // Cables
  listCables: () => request("/cables"),
  getCable: (id) => request(`/cables/${id}`),
  createCable: (data) =>
    request("/cables", { method: "POST", body: JSON.stringify(data) }),
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
  unspliceCore: (coreId) => request(`/splices/by-core/${coreId}`, { method: "DELETE" }),

  // Splitters
  listSplitters: (enclosureId) => request(`/splitters?enclosureId=${enclosureId}`),
  getSplitter: (id) => request(`/splitters/${id}`),
  createSplitter: (data) =>
    request("/splitters", { method: "POST", body: JSON.stringify(data) }),
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

  // Health check
  health: () => safeRequest("/health"),
};
