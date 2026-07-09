import React, { useMemo } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Polyline,
  CircleMarker,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";

function divIcon(html, size) {
  return L.divIcon({
    html,
    className: "",
    iconSize: size,
    iconAnchor: [size[0] / 2, size[1] / 2],
  });
}

const poleIcon = divIcon('<div class="pole-marker"></div>', [10, 10]);

function enclosureIcon(availableCores) {
  const cls =
    availableCores === undefined
      ? ""
      : availableCores > 0
        ? "has-capacity"
        : "full";
  return divIcon(`<div class="enclosure-marker ${cls}"></div>`, [14, 14]);
}

function ClickCatcher({ onMapClick }) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng);
    },
  });
  return null;
}

const CABLE_COLORS = {
  feeder: "#8b7cf6",
  distribution: "#f0b429",
  drop: "#3fd0c9",
};

export default function MapView({
  poles,
  enclosures,
  cables,
  capacityByEnclosure,
  mode,
  pendingCableRoute,
  pendingCableWaypoints,
  selectedEnclosureId,
  onMapClick,
  onPoleClick,
  onEnclosureClick,
}) {
  const center = useMemo(() => {
    if (poles.length) return [poles[0].lat, poles[0].lng];
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
        return (
          <Polyline
            key={cable.id}
            positions={
              cable.route ? cable.route.map(([lng, lat]) => [lat, lng]) : []
            }
            pathOptions={{
              color: CABLE_COLORS[cable.cable_type] || "#8b96a8",
              weight:
                cable.cable_type === "feeder"
                  ? 4
                  : cable.cable_type === "distribution"
                    ? 3
                    : 2,
              dashArray: cable.cable_type === "drop" ? "4 5" : "10 6",
              className: isSpliceLive ? "cable-line-active" : "",
              opacity: 0.85,
            }}
          />
        );
      })}

      {poles.map((pole) => (
        <Marker
          key={pole.id}
          position={[pole.lat, pole.lng]}
          icon={poleIcon}
          eventHandlers={{ click: () => onPoleClick(pole) }}
        />
      ))}

      {enclosures.map((enc) => (
        <Marker
          key={enc.id}
          position={[enc.lat, enc.lng]}
          icon={enclosureIcon(capacityByEnclosure?.[enc.id])}
          eventHandlers={{ click: () => onEnclosureClick(enc) }}
        />
      ))}
    </MapContainer>
  );
}
