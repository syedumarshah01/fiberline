import React, { useEffect, useRef, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

// Module-level flag to track if a cable was clicked
let cableWasClicked = false;

const CABLE_COLORS = {
  feeder: "#8b7cf6",
  distribution: "#f0b429",
  drop: "#3fd0c9",
};

const defaultCenter = [71.5788, 34.0083]; // Peshawar [lng, lat]

// Use a free Mapbox style via the demotiles URL
// This uses Mapbox's own vector tiles with streets, labels, etc.
const MAPBOX_STYLE = "mapbox://styles/mapbox/streets-v12";

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
  const dataRef = useRef({ poles, enclosures, cables, capacityByEnclosure, pendingCableRoute, selectedEnclosureId, selectedPoleId, selectedCableId, splitPointLngLat, userPosition, customerRoute, onEnclosureClick, onCableClick });

  // Keep dataRef in sync
  dataRef.current = { poles, enclosures, cables, capacityByEnclosure, pendingCableRoute, selectedEnclosureId, selectedPoleId, selectedCableId, splitPointLngLat, userPosition, customerRoute, onEnclosureClick, onCableClick };

  const updateMap = useCallback(() => {
    if (!map.current) return;

    const d = dataRef.current;

    // Clear existing sources and layers
    const style = map.current.getStyle();
    if (style && style.sources) {
      Object.keys(style.sources).forEach((sourceId) => {
        if (sourceId.startsWith("cable-") || sourceId === "pending-route" || sourceId === "poles" || sourceId === "enclosures" || sourceId === "split-point" || sourceId === "customer-route") {
          if (map.current.getSource(sourceId)) {
            map.current.removeSource(sourceId);
          }
        }
      });
    }
    // Also remove customer-route layer if it exists
    if (map.current.getLayer("customer-route-line")) {
      map.current.removeLayer("customer-route-line");
    }

    // Add pending route
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

    // Add cables
    d.cables.forEach((cable) => {
      if (!cable.route || cable.route.length < 2) return;
      
      const isSelected = cable.id === d.selectedCableId;
      const sourceId = `cable-${cable.id}`;
      
      map.current.addSource(sourceId, {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: cable.route.map(([lng, lat]) => [lng, lat]),
          },
        },
      });
      
      const layerId = `cable-line-${cable.id}`;
      map.current.addLayer({
        id: layerId,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": CABLE_COLORS[cable.cable_type] || "#8b96a8",
          "line-width": isSelected
            ? (cable.cable_type === "feeder" ? 7 : cable.cable_type === "distribution" ? 6 : 4)
            : (cable.cable_type === "feeder" ? 4 : cable.cable_type === "distribution" ? 3 : 2),
          "line-opacity": isSelected ? 1 : 0.85,
      "line-dasharray": (cable.spliced_core_count || 0) > 0 ? (isSelected ? [2, 2] : [10, 6]) : [],
        },
      });
      
      // Add click handler for cable
      if (d.onCableClick) {
        map.current.on("click", layerId, () => {
          cableWasClicked = true;
          d.onCableClick(cable);
        });
      }
    });

    // Add poles as markers
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
      
      new mapboxgl.Marker({ element: el })
        .setLngLat([pole.lng, pole.lat])
        .addTo(map.current);
    });

    // Add enclosures as markers
    d.enclosures.forEach((enc) => {
      if (enc.lat == null || enc.lng == null) return;
      const availableCores = d.capacityByEnclosure?.[enc.id];
      const el = document.createElement("div");
      el.className = "map-marker";
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
      
      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([enc.lng, enc.lat])
        .addTo(map.current);
      
      el.addEventListener("click", () => d.onEnclosureClick(enc));
    });

    // Add split point marker
    if (d.splitPointLngLat && Array.isArray(d.splitPointLngLat) && d.splitPointLngLat.length === 2) {
      const el = document.createElement("div");
      el.className = "map-marker";
      el.style.width = "18px";
      el.style.height = "18px";
      el.style.borderRadius = "50%";
      el.style.backgroundColor = "#3fd0c9";
      el.style.border = "2px solid #fff";
      
      new mapboxgl.Marker({ element: el })
        .setLngLat([d.splitPointLngLat[0], d.splitPointLngLat[1]])
        .addTo(map.current);
    }

    // Add user location marker
    if (d.userPosition && d.userPosition.lat != null && d.userPosition.lng != null) {
      const el = document.createElement("div");
      el.className = "user-location-marker";
      el.style.width = "20px";
      el.style.height = "20px";
      el.style.borderRadius = "50%";
      el.style.backgroundColor = "#4285f4";
      el.style.border = "2px solid #fff";
      
      new mapboxgl.Marker({ element: el })
        .setLngLat([d.userPosition.lng, d.userPosition.lat])
        .addTo(map.current);
    }

    // Add customer route (from customer location to recommended enclosure)
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
  }, []);

  useEffect(() => {
    if (map.current) return; // initialize only once
    
    const center = poles.length && poles[0].lat != null && poles[0].lng != null
      ? [poles[0].lng, poles[0].lat] 
      : defaultCenter;

    // Set Mapbox access token from env or use a public demo token
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || "";
    
    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAPBOX_STYLE,
      center: center,
      zoom: 16,
    });

    // Add navigation controls
    map.current.addControl(new mapboxgl.NavigationControl(), "top-right");

    map.current.on("click", (e) => {
      // Only call onMapClick if no cable was clicked
      if (!cableWasClicked) {
        onMapClick({ lat: e.lngLat.lat, lng: e.lngLat.lng });
      }
      // Reset the flag
      cableWasClicked = false;
    });

    // When map loads, run the update
    map.current.on("load", updateMap);

    return () => {
      if (map.current) {
        map.current.remove();
        map.current = null;
      }
    };
  }, [poles, onMapClick, updateMap]);

  // Fly to selected enclosure or pole
  useEffect(() => {
    if (!map.current) return;
    
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
    } else if (userPosition && userPosition.lat != null && userPosition.lng != null) {
      target = [userPosition.lng, userPosition.lat];
    }
    
    if (target) {
      map.current.flyTo({ center: target, zoom: Math.max(map.current.getZoom(), 16), duration: 800 });
    }
  }, [selectedPoleId, selectedEnclosureId, selectedCableId, poles, enclosures, cables, userPosition]);

  // Update customer route on map
  useEffect(() => {
    if (!map.current) return;
    
    // Remove existing customer route
    if (map.current.getSource("customer-route")) {
      map.current.removeSource("customer-route");
    }
    if (map.current.getLayer("customer-route-line")) {
      map.current.removeLayer("customer-route-line");
    }
    
    // Add new customer route if available
    if (customerRoute && customerRoute.route && customerRoute.route.length >= 2) {
      map.current.addSource("customer-route", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: customerRoute.route.map(([lng, lat]) => [lng, lat]),
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
  }, [customerRoute]);

  return (
    <div 
      ref={mapContainer} 
      style={{ width: "100%", height: "100%" }}
    />
  );
}