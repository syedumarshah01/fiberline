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

function normalizeRouteCoordinates(route) {
  if (!Array.isArray(route) || route.length < 2) {
    throw new Error("A route needs at least two coordinates");
  }

  return route.map((point, index) => {
    const lng = Array.isArray(point) ? point[0] : point?.lng;
    const lat = Array.isArray(point) ? point[1] : point?.lat;

    if (!Number.isFinite(Number(lng)) || !Number.isFinite(Number(lat))) {
      throw new Error(`route[${index}] must include numeric lng and lat`);
    }

    return { lng: Number(lng), lat: Number(lat) };
  });
}

function haversineMeters(a, b) {
  const radiusMeters = 6371000;
  const toRadians = (value) => (value * Math.PI) / 180;
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(deltaLat / 2);
  const sinLng = Math.sin(deltaLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * radiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

function measurePolylineMeters(route) {
  const points = normalizeRouteCoordinates(route);
  return points.reduce((total, point, index) => {
    if (index === 0) return total;
    return total + haversineMeters(points[index - 1], point);
  }, 0);
}

function interpolatePoint(a, b, ratio) {
  return {
    lng: a.lng + (b.lng - a.lng) * ratio,
    lat: a.lat + (b.lat - a.lat) * ratio,
  };
}

function splitRouteAtDistance(route, targetMeters) {
  const points = normalizeRouteCoordinates(route);
  const totalMeters = measurePolylineMeters(points);

  if (targetMeters <= 0 || totalMeters <= 0) {
    return {
      upstream: [points[0]],
      downstream: points,
      upstream_length_m: 0,
      downstream_length_m: totalMeters,
      split_point: points[0],
    };
  }

  if (targetMeters >= totalMeters) {
    return {
      upstream: points,
      downstream: [points[points.length - 1]],
      upstream_length_m: totalMeters,
      downstream_length_m: 0,
      split_point: points[points.length - 1],
    };
  }

  const upstream = [points[0]];
  let traveled = 0;

  for (let index = 1; index < points.length; index += 1) {
    const previousPoint = points[index - 1];
    const currentPoint = points[index];
    const segmentMeters = haversineMeters(previousPoint, currentPoint);

    if (traveled + segmentMeters < targetMeters) {
      upstream.push(currentPoint);
      traveled += segmentMeters;
      continue;
    }

    const ratio =
      segmentMeters === 0 ? 0 : (targetMeters - traveled) / segmentMeters;
    const splitPoint = interpolatePoint(previousPoint, currentPoint, ratio);
    upstream.push(splitPoint);

    const downstream = [splitPoint, ...points.slice(index)];
    return {
      upstream,
      downstream,
      upstream_length_m: targetMeters,
      downstream_length_m: totalMeters - targetMeters,
      split_point: splitPoint,
    };
  }

  return {
    upstream: points,
    downstream: [points[points.length - 1]],
    upstream_length_m: totalMeters,
    downstream_length_m: 0,
    split_point: points[points.length - 1],
  };
}

module.exports = {
  fetchStreetRoute,
  coordinatesToWkt,
  normalizeRouteCoordinates,
  measurePolylineMeters,
  splitRouteAtDistance,
};
