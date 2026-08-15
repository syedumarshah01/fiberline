import React, { useEffect, useRef, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { cableLabel, routeMidpointLngLat, CABLE_LABEL_MIN_ZOOM } from "../utils/geoLabels.js";

// Module-level flag to track if a cable was clicked (prevents map click from clearing selection)
let cableWasClicked = false;

const CABLE_COLORS = {
  feeder: "#8b7cf6",
  distribution: "#f0b429",
  drop: "#3fd0c9",
};

// Spotlight color for a cable whose fiber is hovered in the splice form —
// deliberately not one of the cable-type colors.
const HIGHLIGHT_COLOR = "#ff6b35";

const defaultCenter = [71.5788, 34.0083]; // Peshawar [lng, lat]

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || "";
// The commented intent was "free style via demotiles": only mapbox:// styles
// need an access token. Without a token, fall back to MapLibre's free demo
// style so this provider isn't a blank grey canvas out of the box.
const MAP_STYLE = MAPBOX_TOKEN
  ? "mapbox://styles/mapbox/streets-v12"
  : "https://demotiles.maplibre.org/style.json";

export default function MapViewMapbox({
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
  locateNonce,
  labelOpacity,
  splitPointLngLat,
  userPosition,
  customerRoute,
  onMapClick,
  onPoleClick,
  onEnclosureClick,
  onCableClick,
}) {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const mapLoaded = useRef(false);
  // DOM markers must be tracked and removed on every redraw, otherwise they
  // pile up on the map each time data changes.
  const markersRef = useRef([]);
  const dataRef = useRef({});
  // Keep dataRef in sync so stable map callbacks always see fresh data/handlers.
  dataRef.current = { poles, enclosures, cables, capacityByEnclosure, pendingCableRoute, selectedEnclosureId, selectedPoleId, selectedCableId, highlightCableId, labelOpacity, splitPointLngLat, userPosition, customerRoute, onMapClick, onPoleClick, onEnclosureClick, onCableClick };

  const clearDynamicContent = useCallback(() => {
    if (!map.current) return;

    // Remove DOM markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    // Remove layers FIRST, then the sources they reference — removing a source
    // while a layer still uses it throws, which previously aborted the whole
    // redraw halfway through.
    const style = map.current.getStyle();
    if (style && style.layers) {
      style.layers.forEach((layer) => {
        if (
          layer.id.startsWith("cable-line-") ||
          layer.id.startsWith("cable-label-") ||
          layer.id === "pending-route-line" ||
          layer.id === "customer-route-line"
        ) {
          if (map.current.getLayer(layer.id)) map.current.removeLayer(layer.id);
        }
      });
    }
    if (style && style.sources) {
      Object.keys(style.sources).forEach((sourceId) => {
        if (
          sourceId.startsWith("cable-") ||
          sourceId.startsWith("cable-label-src-") ||
          sourceId === "pending-route" ||
          sourceId === "customer-route"
        ) {
          if (map.current.getSource(sourceId)) map.current.removeSource(sourceId);
        }
      });
    }
  }, []);

  const updateMap = useCallback(() => {
    if (!map.current || !mapLoaded.current) return;
    if (!map.current.isStyleLoaded()) return;

    const d = dataRef.current;
    clearDynamicContent();

    // Pending cable draft
    if (d.pendingCableRoute.length >= 2) {
      map.current.addSource("pending-route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: d.pendingCableRoute.map(([lat, lng]) => [lng, lat]),
          },
        },
      });
      map.current.addLayer({
        id: "pending-route-line",
        type: "line",
        source: "pending-route",
        paint: {
          "line-color": "#3fd0c9",
          "line-width": 4,
          "line-opacity": 0.9,
          "line-dasharray": [8, 7],
        },
      });
    }

    // Cables. One delegated click handler (bound in the init effect) reads the
    // cable id from feature properties — no per-layer listeners to leak.
    d.cables.forEach((cable) => {
      if (!cable.route || cable.route.length < 2) return;

      const isSelected = cable.id === d.selectedCableId;
      const isHighlighted = cable.id === d.highlightCableId;
      const sourceId = `cable-${cable.id}`;

      map.current.addSource(sourceId, {
        type: "geojson",
        data: {
          type: "Feature",
          properties: { cableId: cable.id },
          geometry: {
            type: "LineString",
            coordinates: cable.route.map(([lng, lat]) => [lng, lat]),
          },
        },
      });

      const paint = {
        "line-color": isHighlighted ? HIGHLIGHT_COLOR : CABLE_COLORS[cable.cable_type] || "#8b96a8",
        "line-width": isSelected || isHighlighted
          ? (cable.cable_type === "feeder" ? 7 : cable.cable_type === "distribution" ? 6 : 4)
          : (cable.cable_type === "feeder" ? 4 : cable.cable_type === "distribution" ? 3 : 2),
        "line-opacity": isSelected || isHighlighted ? 1 : 0.85,
      };
      // An empty dash array is invalid — only set it when spliced cores exist.
      if ((cable.spliced_core_count || 0) > 0 && !isHighlighted) {
        paint["line-dasharray"] = isSelected ? [2, 2] : [10, 6];
      }

      map.current.addLayer({
        id: `cable-line-${cable.id}`,
        type: "line",
        source: sourceId,
        paint,
      });

      // Cable name label at the route midpoint, shown once zoomed in enough
      // that labels don't blanket the city.
      const label = cableLabel(cable);
      const mid = routeMidpointLngLat(cable.route);
      if (label && mid) {
        const labelSrcId = `cable-label-src-${cable.id}`;
        map.current.addSource(labelSrcId, {
          type: "geojson",
          data: {
            type: "Feature",
            // cableId so a click on the label behaves like a click on the line
            properties: { label, cableId: cable.id },
            geometry: { type: "Point", coordinates: mid },
          },
        });
        map.current.addLayer({
          id: `cable-label-${cable.id}`,
          type: "symbol",
          source: labelSrcId,
          minzoom: CABLE_LABEL_MIN_ZOOM,
          layout: {
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-font": ["Open Sans Semibold", "Arial Unicode MS Bold"],
            "text-allow-overlap": false,
            "text-ignore-placement": false,
          },
          paint: {
            "text-color": "#f4f6fa",
            "text-halo-color": "#10141c",
            "text-halo-width": 1.5,
            "text-opacity": d.labelOpacity ?? 1,
          },
        });
      }
    });

    // Poles
    d.poles.forEach((pole) => {
      if (pole.lat == null || pole.lng == null) return;
      const el = document.createElement("div");
      el.className = "map-marker";
      el.style.width = pole.id === d.selectedPoleId ? "16px" : "10px";
      el.style.height = pole.id === d.selectedPoleId ? "16px" : "10px";
      el.style.borderRadius = "50%";
      el.style.backgroundColor = pole.id === d.selectedPoleId ? "#ff6b35" : "#333";
      el.style.border = "2px solid #fff";
      el.style.cursor = "pointer";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        cableWasClicked = true;
        dataRef.current.onPoleClick?.(pole);
      });

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([pole.lng, pole.lat])
        .addTo(map.current);
      markersRef.current.push(marker);
    });

    // Enclosures
    d.enclosures.forEach((enc) => {
      if (enc.lat == null || enc.lng == null) return;
      const availableCores = d.capacityByEnclosure?.[enc.id];
      const el = document.createElement("div");
      // enc-dot-marker: the box-code label span inside is revealed by CSS,
      // ONLY on hover or when this box is selected — never all at once.
      const isSelected = enc.id === d.selectedEnclosureId;
      el.className =
        "map-marker enc-dot-marker" + (isSelected ? " is-selected" : "");
      if (enc.code) {
        const labelEl = document.createElement("span");
        labelEl.className = "enc-dot-label";
        labelEl.textContent = enc.code;
        el.appendChild(labelEl);
      }
      el.style.width = enc.id === d.selectedEnclosureId ? "20px" : "14px";
      el.style.height = enc.id === d.selectedEnclosureId ? "20px" : "14px";
      el.style.borderRadius = "50%";
      el.style.backgroundColor =
        enc.id === d.selectedEnclosureId
          ? "#ff6b35"
          : availableCores > 0
            ? "#4caf50"
            : "#e53935";
      el.style.border = "2px solid #fff";
      el.style.cursor = "pointer";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        cableWasClicked = true;
        dataRef.current.onEnclosureClick?.(enc);
      });

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([enc.lng, enc.lat])
        .addTo(map.current);
      markersRef.current.push(marker);
    });

    // Cable split-point preview marker
    if (d.splitPointLngLat && Array.isArray(d.splitPointLngLat) && d.splitPointLngLat.length === 2) {
      const el = document.createElement("div");
      el.className = "map-marker";
      el.style.width = "18px";
      el.style.height = "18px";
      el.style.borderRadius = "50%";
      el.style.backgroundColor = "#3fd0c9";
      el.style.border = "2px solid #fff";

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([d.splitPointLngLat[0], d.splitPointLngLat[1]])
        .addTo(map.current);
      markersRef.current.push(marker);
    }

    // User's own location
    if (d.userPosition && d.userPosition.lat != null && d.userPosition.lng != null) {
      const el = document.createElement("div");
      el.className = "user-location-marker";
      el.style.width = "20px";
      el.style.height = "20px";
      el.style.borderRadius = "50%";
      el.style.backgroundColor = "#4285f4";
      el.style.border = "2px solid #fff";

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([d.userPosition.lng, d.userPosition.lat])
        .addTo(map.current);
      markersRef.current.push(marker);
    }

    // Customer route (customer location → recommended box)
    if (d.customerRoute && d.customerRoute.route && d.customerRoute.route.length >= 2) {
      map.current.addSource("customer-route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: d.customerRoute.route.map(([lng, lat]) => [lng, lat]),
          },
        },
      });
      map.current.addLayer({
        id: "customer-route-line",
        type: "line",
        source: "customer-route",
        paint: {
          "line-color": "#ff6b35",
          "line-width": 5,
          "line-opacity": 0.8,
          "line-dasharray": [10, 5],
        },
      });
    }
  }, [clearDynamicContent]);

  // Mount the map exactly once. Previously this effect depended on
  // `[poles, onMapClick, updateMap]` — a new onMapClick identity every App
  // render destroyed and rebuilt the entire map, and the bound handlers went
  // stale between rebuilds.
  useEffect(() => {
    if (map.current) return; // initialize only once

    mapboxgl.accessToken = MAPBOX_TOKEN;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAP_STYLE,
      center: defaultCenter,
      zoom: 16,
    });
    map.current.addControl(new mapboxgl.NavigationControl(), "top-right");

    map.current.on("load", () => {
      mapLoaded.current = true;
      // center on data if we already have poles
      const d = dataRef.current;
      if (d.poles.length && d.poles[0].lat != null && d.poles[0].lng != null) {
        map.current.setCenter([d.poles[0].lng, d.poles[0].lat]);
      }
      updateMap();
    });

    // Delegated click: a cable feature under the cursor wins; otherwise it's a
    // plain map click (draw/place/clear-selection behavior lives in App).
    map.current.on("click", (e) => {
      const d = dataRef.current;

      if (!cableWasClicked) {
        // A click on a cable's name label counts as a click on the cable.
        const cableLayerIds = (map.current.getStyle()?.layers || [])
          .map((l) => l.id)
          .filter((id) => id.startsWith("cable-line-") || id.startsWith("cable-label-"));

        if (cableLayerIds.length) {
          const hits = map.current.queryRenderedFeatures(e.point, { layers: cableLayerIds });
          if (hits.length) {
            const cableId = hits[0].properties?.cableId;
            const cable = d.cables.find((c) => c.id === cableId);
            if (cable) {
              cableWasClicked = true;
              d.onCableClick?.(cable);
              cableWasClicked = false;
              return;
            }
          }
        }

        d.onMapClick?.({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      }
      cableWasClicked = false;
    });

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
        mapLoaded.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw whenever the data changes (this effect is what makes the map live —
  // previously updateMap only ran on the initial style load).
  useEffect(() => {
    updateMap();
  }, [poles, enclosures, cables, capacityByEnclosure, pendingCableRoute, selectedEnclosureId, selectedPoleId, selectedCableId, highlightCableId, labelOpacity, splitPointLngLat, userPosition, customerRoute, updateMap]);

  // Fly to selected enclosure or pole
  useEffect(() => {
    if (!map.current || !mapLoaded.current) return;

    let target = null;
    if (selectedPoleId) {
      const pole = poles.find((p) => p.id === selectedPoleId);
      if (pole && pole.lat != null && pole.lng != null) target = [pole.lng, pole.lat];
    } else if (selectedEnclosureId) {
      const enc = enclosures.find((e) => e.id === selectedEnclosureId);
      if (enc && enc.lat != null && enc.lng != null) target = [enc.lng, enc.lat];
    } else if (selectedCableId) {
      const cable = cables.find((c) => c.id === selectedCableId);
      if (cable?.route?.length) {
        const mid = cable.route[Math.floor(cable.route.length / 2)];
        if (mid && mid[0] != null && mid[1] != null) target = [mid[0], mid[1]];
      }
    }

    if (target) {
      map.current.flyTo({ center: target, zoom: Math.max(map.current.getZoom(), 16), duration: 800 });
    }
  }, [selectedPoleId, selectedEnclosureId, selectedCableId, poles, enclosures, cables]);

  // Fly to the user's location ONLY when they explicitly clicked "locate me"
  // (locateNonce bumps). The map must never drift there on its own.
  useEffect(() => {
    if (!map.current || !mapLoaded.current) return;
    if (locateNonce > 0 && userPosition && userPosition.lat != null && userPosition.lng != null) {
      map.current.flyTo({
        center: [userPosition.lng, userPosition.lat],
        zoom: Math.max(map.current.getZoom(), 16),
        duration: 800,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateNonce]);

  return (
    <div
      ref={mapContainer}
      style={{ width: "100%", height: "100%" }}
    />
  );
}
