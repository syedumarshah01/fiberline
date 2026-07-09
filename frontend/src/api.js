const BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    throw new Error(body?.error || `Request failed: ${res.status}`);
  }
  return body;
}

export const api = {
  // Poles
  listPoles: () => request("/poles"),
  createPole: (data) =>
    request("/poles", { method: "POST", body: JSON.stringify(data) }),

  // Enclosures
  listEnclosures: () => request("/enclosures"),
  createEnclosure: (data) =>
    request("/enclosures", { method: "POST", body: JSON.stringify(data) }),
  getBoxDocumentation: (id) => request(`/enclosures/${id}/documentation`),

  // Cables
  listCables: () => request("/cables"),
  getCable: (id) => request(`/cables/${id}`),
  createCable: (data) =>
    request("/cables", { method: "POST", body: JSON.stringify(data) }),
  previewCableRoute: (data) =>
    request("/cables/route-preview", {
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
  deleteSplice: (id) => request(`/splices/${id}`, { method: "DELETE" }),

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
};
