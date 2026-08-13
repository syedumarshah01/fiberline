import React, { useMemo, useEffect, useRef, useCallback, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  CircleMarker,
  Tooltip,
  useMapEvents,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import { cableLabel, routeMidpointLngLat, CABLE_LABEL_MIN_ZOOM } from "../utils/geoLabels.js";

/** Color used to spotlight a cable (e.g. while hovering one of its fibers in
 *  the splice form). Deliberately not one of the cable-type colors. */
export const HIGHLIGHT_COLOR = "#ff6b35";

// Module-level flag to track if a cable was clicked (prevents map click from clearing selection)
let cableWasClicked = false;

function divIcon(html, size, className = "") {
  return L.divIcon({
    html,
    className,
    iconSize: size,
    iconAnchor: [size[0] / 2, size[1] / 2],
  });
}

const poleIcon = divIcon('<div class="pole-marker"></div>', [10, 10]);
const selectedPoleIcon = divIcon(
  '<div class="pole-marker selected-pole-marker"></div>',
  [16, 16],
);

function enclosureIcon(availableCores, isSelected) {
  const cls =
    availableCores === undefined
      ? ""
      : availableCores > 0
        ? "has-capacity"
        : "full";
  return divIcon(
    `<div class="enclosure-marker ${cls} ${isSelected ? "selected-enclosure-marker" : ""}"></div>`,
    isSelected ? [20, 20] : [14, 14],
  );
}

const selectedCableIcon = L.divIcon({
  html: '<div class="selected-cable-marker"></div>',
  className: "",
  iconSize: [24, 24],
  iconAnchor: [12, 12],
});

function ClickCatcher({ onMapClick }) {
  useMapEvents({
    click(e) {
      // Only call onMapClick if no cable was clicked
      if (!cableWasClicked) {
        onMapClick(e.latlng);
      }
      // Reset the flag
      cableWasClicked = false;
    },
  });
  return null;
}

function MapFlyTo({ targetLatLng }) {
  const map = useMapEvents({});
  useEffect(() => {
    if (targetLatLng && map) {
      map.flyTo(targetLatLng, Math.max(map.getZoom(), 16), {
        duration: 0.8,
      });
    }
  }, [targetLatLng, map]);
  return null;
}

/** Reports live zoom changes upward so cable labels can gate on zoom level. */
function ZoomTracker({ onZoomChange }) {
  const map = useMap();
  useEffect(() => {
    onZoomChange(map.getZoom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);
  useMapEvents({
    zoomend() {
      onZoomChange(map.getZoom());
    },
  });
  return null;
}

const CABLE_COLORS = {
  feeder: "#8b7cf6",
  distribution: "#f0b429",
  drop: "#3fd0c9",
};

const splitPointIcon = L.divIcon({
  html: '<div class="split-point-marker"></div>',
  className: "",
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

export default function MapView({
  poles,
  enclosures,
  cables,
  capacityByEnclosure,
  mode,
  pendingCableRoute,
  pendingCableWaypoints,
  selectedEnclosureId,
  selectedPoleId,
  selectedCableId,
  highlightCableId,
  splitPointLngLat,
  userPosition,
  customerRoute,
  onMapClick,
  onPoleClick,
  onEnclosureClick,
  onCableClick,
}) {
  const [zoom, setZoom] = useState(16);
  const flyToTarget = useMemo(() => {
    if (selectedPoleId) {
      const pole = poles.find((p) => p.id === selectedPoleId);
      if (pole && pole.lat != null && pole.lng != null) return [pole.lat, pole.lng];
    }
    if (selectedEnclosureId) {
      const enc = enclosures.find((e) => e.id === selectedEnclosureId);
      if (enc && enc.lat != null && enc.lng != null) return [enc.lat, enc.lng];
    }
    if (selectedCableId) {
      const cable = cables.find((c) => c.id === selectedCableId);
      // Fly to the midpoint of the cable route
      if (cable?.route?.length) {
        const mid = cable.route[Math.floor(cable.route.length / 2)];
        if (mid && mid[1] != null && mid[0] != null) return [mid[1], mid[0]];
      }
    }
    if (userPosition && userPosition.lat != null && userPosition.lng != null) {
      return [userPosition.lat, userPosition.lng];
    }
    return null;
  }, [selectedPoleId, selectedEnclosureId, selectedCableId, poles, enclosures, cables, userPosition]);

  const center = useMemo(() => {
    if (poles.length && poles[0].lat != null && poles[0].lng != null) return [poles[0].lat, poles[0].lng];
    return [34.0083, 71.5788]; // Peshawar, as a sensible default center
  }, [poles]);

  return (
    <MapContainer
      center={center}
      zoom={16}
      style={{ height: "100%", width: "100%" }}
    >
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ClickCatcher onMapClick={onMapClick} />
      <MapFlyTo targetLatLng={flyToTarget} />
      <ZoomTracker onZoomChange={setZoom} />

      {pendingCableRoute.length >= 2 && (
        <Polyline
          positions={pendingCableRoute}
          pathOptions={{
            color: "#3fd0c9",
            weight: 4,
            opacity: 0.9,
            dashArray: "8 7",
            className: "cable-line-draft",
          }}
        />
      )}

      {pendingCableWaypoints.map((point, index) => (
        <CircleMarker
          key={`${point.lat}-${point.lng}-${index}`}
          center={[point.lat, point.lng]}
          radius={4}
          pathOptions={{
            color: "#3fd0c9",
            fillColor: "#3fd0c9",
            fillOpacity: 1,
            opacity: 1,
          }}
        />
      ))}

      {cables.map((cable) => {
        const isSpliceLive = cable.cable_type !== "drop";
        const hasSplicedCores = (cable.spliced_core_count || 0) > 0;
        const isSelected = cable.id === selectedCableId;
        const isHighlighted = cable.id === highlightCableId;
        const label = cableLabel(cable);
        const mid = routeMidpointLngLat(cable.route);
        return (
          <React.Fragment key={cable.id}>
          <Polyline
            positions={
              cable.route ? cable.route.map(([lng, lat]) => [lat, lng]) : []
            }
            pathOptions={{
              color: isHighlighted ? HIGHLIGHT_COLOR : CABLE_COLORS[cable.cable_type] || "#8b96a8",
              weight:
                isSelected || isHighlighted
                  ? (cable.cable_type === "feeder" ? 7 : cable.cable_type === "distribution" ? 6 : 4)
                  : (cable.cable_type === "feeder"
                      ? 4
                      : cable.cable_type === "distribution"
                        ? 3
                        : 2),
              dashArray: hasSplicedCores && !isHighlighted ? (isSelected ? "2 2" : "10 6") : "none",
              className: hasSplicedCores ? "cable-line-active" : "",
              opacity: isSelected || isHighlighted ? 1 : 0.85,
            }}
            eventHandlers={onCableClick ? {
              click: () => {
                cableWasClicked = true;
                onCableClick(cable);
              },
            } : undefined}
          >
            {label && mid && zoom >= CABLE_LABEL_MIN_ZOOM && (
              <Tooltip
                permanent
                direction="center"
                className="cable-map-label"
                position={[mid[1], mid[0]]}
                interactive={false}
                opacity={1}
              >
                {label}
              </Tooltip>
            )}
          </Polyline>
          </React.Fragment>
        );
      })}

      {poles.map((pole) => {
        if (pole.lat == null || pole.lng == null) return null;
        return (
          <Marker
            key={pole.id}
            position={[pole.lat, pole.lng]}
            icon={pole.id === selectedPoleId ? selectedPoleIcon : poleIcon}
            eventHandlers={{ click: () => onPoleClick(pole) }}
          />
        );
      })}

      {enclosures.map((enc) => {
        if (enc.lat == null || enc.lng == null) return null;
        return (
          <Marker
            key={enc.id}
            position={[enc.lat, enc.lng]}
            icon={enclosureIcon(capacityByEnclosure?.[enc.id], enc.id === selectedEnclosureId)}
            eventHandlers={{ click: () => onEnclosureClick(enc) }}
          />
        );
      })}

      {splitPointLngLat &&
        Array.isArray(splitPointLngLat) &&
        splitPointLngLat.length === 2 &&
        Number.isFinite(splitPointLngLat[0]) &&
        Number.isFinite(splitPointLngLat[1]) && (
        <Marker
          position={[splitPointLngLat[1], splitPointLngLat[0]]}
          icon={splitPointIcon}
        />
      )}

      {userPosition && userPosition.lat != null && userPosition.lng != null && (
        <Marker
          position={[userPosition.lat, userPosition.lng]}
          icon={L.divIcon({
            html: '<div class="user-location-marker"></div>',
            className: "",
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          })}
        />
      )}

      {customerRoute && customerRoute.route && customerRoute.route.length >= 2 && (
        <Polyline
          positions={customerRoute.route.map(([lng, lat]) => [lat, lng])}
          pathOptions={{
            color: "#ff6b35",
            weight: 5,
            opacity: 0.8,
            dashArray: "10 5",
          }}
        />
      )}
    </MapContainer>
  );
}
