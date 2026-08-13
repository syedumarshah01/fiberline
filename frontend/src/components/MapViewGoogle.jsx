import React, { useMemo, useEffect, useCallback, useRef, useState } from "react";
import {
  GoogleMap,
  LoadScript,
  Marker,
  Polyline,
  OverlayView,
  useJsApiLoader,
} from "@react-google-maps/api";
import { cableLabel, routeMidpointLngLat, CABLE_LABEL_MIN_ZOOM } from "../utils/geoLabels.js";

// Module-level flag to track if a cable was clicked
let cableWasClicked = false;

const CABLE_COLORS = {
  feeder: "#8b7cf6",
  distribution: "#f0b429",
  drop: "#3fd0c9",
};

// Spotlight color for a cable whose fiber is hovered in the splice form —
// deliberately not one of the cable-type colors.
const HIGHLIGHT_COLOR = "#ff6b35";

const mapContainerStyle = {
  height: "100%",
  width: "100%",
};

const defaultCenter = { lat: 34.0083, lng: 71.5788 }; // Peshawar

export default function MapViewGoogle({
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
  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "",
  });
  const [zoom, setZoom] = useState(16);

  const center = useMemo(() => {
    if (poles.length && poles[0].lat != null && poles[0].lng != null) return { lat: poles[0].lat, lng: poles[0].lng };
    return defaultCenter;
  }, [poles]);

  const flyToTarget = useMemo(() => {
    if (selectedPoleId) {
      const pole = poles.find((p) => p.id === selectedPoleId);
      if (pole && pole.lat != null && pole.lng != null) return { lat: pole.lat, lng: pole.lng };
    }
    if (selectedEnclosureId) {
      const enc = enclosures.find((e) => e.id === selectedEnclosureId);
      if (enc && enc.lat != null && enc.lng != null) return { lat: enc.lat, lng: enc.lng };
    }
    if (selectedCableId) {
      const cable = cables.find((c) => c.id === selectedCableId);
      if (cable?.route?.length) {
        const mid = cable.route[Math.floor(cable.route.length / 2)];
        if (mid && mid[1] != null && mid[0] != null) return { lat: mid[1], lng: mid[0] };
      }
    }
    if (userPosition && userPosition.lat != null && userPosition.lng != null) {
      return { lat: userPosition.lat, lng: userPosition.lng };
    }
    return null;
  }, [selectedPoleId, selectedEnclosureId, selectedCableId, poles, enclosures, cables, userPosition]);

  const mapOptions = {
    mapTypeId: "roadmap",
    styles: [
      {
        featureType: "poi",
        elementType: "labels",
        stylers: [{ visibility: "off" }],
      },
    ],
  };

  const mapRef = useRef(null);

  const handleMapClick = useCallback((e) => {
    // Only call onMapClick if no cable was clicked
    if (!cableWasClicked) {
      onMapClick({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    }
    // Reset the flag
    cableWasClicked = false;
  }, [onMapClick]);

  // Fly to target when it changes
  useEffect(() => {
    if (mapRef.current && flyToTarget) {
      mapRef.current.panTo(flyToTarget);
      mapRef.current.setZoom(Math.max(mapRef.current.getZoom(), 16));
    }
  }, [flyToTarget]);

  if (!isLoaded) return <div>Loading map...</div>;

  return (
    <GoogleMap
      mapContainerStyle={mapContainerStyle}
      center={center}
      zoom={16}
      options={mapOptions}
      onClick={handleMapClick}
      onLoad={(map) => { mapRef.current = map; }}
      onZoomChanged={() => { if (mapRef.current) setZoom(mapRef.current.getZoom()); }}
    >
      {pendingCableRoute.length >= 2 && (
        <Polyline
          path={pendingCableRoute}
          options={{
            strokeColor: "#3fd0c9",
            strokeWeight: 4,
            strokeOpacity: 0.9,
            strokeDashArray: "8,7",
          }}
        />
      )}

      {pendingCableWaypoints.map((point, index) => (
        <Marker
          key={`${point.lat}-${point.lng}-${index}`}
          position={{ lat: point.lat, lng: point.lng }}
          icon={{
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: 4,
            fillColor: "#3fd0c9",
            fillOpacity: 1,
            strokeColor: "#3fd0c9",
          }}
        />
      ))}

      {cables.map((cable) => {
        const hasSplicedCores = (cable.spliced_core_count || 0) > 0;
        const isSelected = cable.id === selectedCableId;
        const isHighlighted = cable.id === highlightCableId;
        const label = cableLabel(cable);
        const mid = routeMidpointLngLat(cable.route);
        return (
          <React.Fragment key={cable.id}>
          <Polyline
            path={cable.route ? cable.route.map(([lng, lat]) => ({ lat, lng })) : []}
            options={{
              strokeColor: isHighlighted ? HIGHLIGHT_COLOR : CABLE_COLORS[cable.cable_type] || "#8b96a8",
              strokeWeight: isSelected || isHighlighted
                ? (cable.cable_type === "feeder" ? 7 : cable.cable_type === "distribution" ? 6 : 4)
                : (cable.cable_type === "feeder" ? 4 : cable.cable_type === "distribution" ? 3 : 2),
              strokeOpacity: isSelected || isHighlighted ? 1 : 0.85,
              strokeDashArray: hasSplicedCores && !isHighlighted ? (isSelected ? "2,2" : "10,6") : "none",
            }}
            onClick={onCableClick ? () => {
              cableWasClicked = true;
              onCableClick(cable);
            } : undefined}
          />
          {label && mid && zoom >= CABLE_LABEL_MIN_ZOOM && (
            <OverlayView
              position={{ lat: mid[1], lng: mid[0] }}
              mapPaneName={OverlayView.OVERLAY_MOUSE_TARGET}
              getPixelPositionOffset={(w, h) => ({ x: -(w / 2), y: -(h / 2) })}
            >
              <div className="cable-map-label cable-map-label-g">{label}</div>
            </OverlayView>
          )}
          </React.Fragment>
        );
      })}

      {poles.map((pole) => {
        if (pole.lat == null || pole.lng == null) return null;
        return (
          <Marker
            key={pole.id}
            position={{ lat: pole.lat, lng: pole.lng }}
            icon={{
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: pole.id === selectedPoleId ? 8 : 5,
              fillColor: pole.id === selectedPoleId ? "#ff6b35" : "#333",
              fillOpacity: 1,
              strokeColor: "#fff",
              strokeWeight: 1,
            }}
            onClick={() => onPoleClick(pole)}
          />
        );
      })}

      {enclosures.map((enc) => {
        if (enc.lat == null || enc.lng == null) return null;
        const availableCores = capacityByEnclosure?.[enc.id];
        const cls =
          availableCores === undefined
            ? ""
            : availableCores > 0
              ? "has-capacity"
              : "full";
        return (
          <Marker
            key={enc.id}
            position={{ lat: enc.lat, lng: enc.lng }}
            icon={{
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: enc.id === selectedEnclosureId ? 10 : 7,
              fillColor: enc.id === selectedEnclosureId ? "#ff6b35" : cls === "has-capacity" ? "#4caf50" : "#e53935",
              fillOpacity: 1,
              strokeColor: "#fff",
              strokeWeight: 1,
            }}
            onClick={() => onEnclosureClick(enc)}
          />
        );
      })}

      {splitPointLngLat &&
        Array.isArray(splitPointLngLat) &&
        splitPointLngLat.length === 2 &&
        Number.isFinite(splitPointLngLat[0]) &&
        Number.isFinite(splitPointLngLat[1]) && (
          <Marker
            position={{ lat: splitPointLngLat[1], lng: splitPointLngLat[0] }}
            icon={{
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: 9,
              fillColor: "#3fd0c9",
              fillOpacity: 1,
              strokeColor: "#fff",
              strokeWeight: 1,
            }}
          />
        )}

      {userPosition && userPosition.lat != null && userPosition.lng != null && (
        <Marker
          position={{ lat: userPosition.lat, lng: userPosition.lng }}
          icon={{
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: 10,
            fillColor: "#4285f4",
            fillOpacity: 1,
            strokeColor: "#fff",
            strokeWeight: 2,
          }}
        />
      )}

      {customerRoute && customerRoute.route && customerRoute.route.length >= 2 && (
        <Polyline
          path={customerRoute.route.map(([lng, lat]) => ({ lat, lng }))}
          options={{
            strokeColor: "#ff6b35",
            strokeWeight: 5,
            strokeOpacity: 0.8,
            strokeDashArray: "10,5",
          }}
        />
      )}
    </GoogleMap>
  );
}