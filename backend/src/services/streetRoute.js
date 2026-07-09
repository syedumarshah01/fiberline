const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const OSRM_PROFILE = process.env.OSRM_PROFILE || "driving";

function toPointList(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error(
      "At least two points are required to compute a street route",
    );
  }

  return points.map((point, index) => {
    const lng = Number(point?.lng);
    const lat = Number(point?.lat);

    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new Error(`points[${index}] must include numeric lng and lat`);
    }

    return { lng, lat };
  });
}

function toOsrmPath(points) {
  return points.map((point) => `${point.lng},${point.lat}`).join(";");
}

async function fetchStreetRoute(points) {
  const normalizedPoints = toPointList(points);
  const url = `${OSRM_BASE_URL}/route/v1/${OSRM_PROFILE}/${toOsrmPath(normalizedPoints)}?overview=full&geometries=geojson&steps=false`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Street routing service returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload.code !== "Ok" || !payload.routes?.length) {
    throw new Error(payload.message || "No street route could be computed");
  }

  const route = payload.routes[0];
  return {
    coordinates: route.geometry.coordinates,
    distance_m: route.distance,
  };
}

function coordinatesToWkt(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new Error("A street route needs at least two coordinates");
  }

  return `LINESTRING(${coordinates
    .map((point) => {
      const lng = Array.isArray(point) ? point[0] : point?.lng;
      const lat = Array.isArray(point) ? point[1] : point?.lat;
      return `${lng} ${lat}`;
    })
    .join(", ")})`;
}

module.exports = {
  fetchStreetRoute,
  coordinatesToWkt,
};
