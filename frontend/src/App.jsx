import React, { useEffect, useState, useCallback } from "react";
import MapView from "./components/MapView.jsx";
import MapViewGoogle from "./components/MapViewGoogle.jsx";
import MapViewMapbox from "./components/MapViewMapbox.jsx";
import LeftPanel from "./components/LeftPanel.jsx";
import RightPanel from "./components/RightPanel.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { api } from "./api";
import { LoadScript } from "@react-google-maps/api";
import { LocateFixed, Sun, Moon } from "lucide-react";

const MODES = [
  { key: "view", label: "View" },
  { key: "add-pole", label: "Add pole" },
  { key: "add-enclosure", label: "Add box" },
  { key: "add-customer-enclosure", label: "Add customer box" },
  { key: "draw-cable", label: "Draw cable" },
  { key: "locate-customer", label: "Locate customer" },
];

const MAP_PROVIDERS = [
  { key: "leaflet", label: "Leaflet (OSM)" },
  { key: "google", label: "Google Maps" },
  { key: "mapbox", label: "Mapbox" },
];

const HINTS = {
  view: "Click a box for its documentation, or a cable in the list to trace it.",
  "add-pole": "Click the map to place a pole.",
  "add-enclosure": "Click a pole to attach a box to it.",
  "add-customer-enclosure": "Click the map at the customer's location to place a box.",
  "draw-cable":
    "Click a start box, click the map to add duct bends, then click the destination box.",
  "locate-customer": "Click the map at the customer's location.",
};

export default function App() {
  const [poles, setPoles] = useState([]);
  const [enclosures, setEnclosures] = useState([]);
  const [cables, setCables] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [capacityByEnclosure, setCapacityByEnclosure] = useState({});

  const [mode, setMode] = useState("view");
  const [mapProvider, setMapProvider] = useState("leaflet");
  const [pendingPolePoint, setPendingPolePoint] = useState(null);
  const [pendingEnclosurePole, setPendingEnclosurePole] = useState(null);
  const [pendingCustomerEnclosurePoint, setPendingCustomerEnclosurePoint] = useState(null);
  const [cableDraft, setCableDraft] = useState({
    from: null,
    to: null,
    routePoints: [],
  });
  const [customerPoint, setCustomerPoint] = useState(null);
  const [cableRoutePreview, setCableRoutePreview] = useState(null);

  const [selectedPole, setSelectedPole] = useState(null);
  const [selectedEnclosure, setSelectedEnclosure] = useState(null);
  const [selectedCable, setSelectedCable] = useState(null);
  const [splitPointLngLat, setSplitPointLngLat] = useState(null);
  const [splitRatio, setSplitRatio] = useState(null);
  
  // User location tracking
  const [userPosition, setUserPosition] = useState(null);
  const [locationError, setLocationError] = useState(null);
  const [isTracking, setIsTracking] = useState(false);
  
  // Customer route (for locate-customer mode)
  const [customerRoute, setCustomerRoute] = useState(null);
  
  // Theme state
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem("fiberline-theme") || "dark";
  });
  
  // Resizable right panel state
  const [rightPanelWidth, setRightPanelWidth] = useState(360);
  const [isResizing, setIsResizing] = useState(false);

  const reloadAll = useCallback(() => {
    api.listPoles().then(setPoles).catch(console.error);
    api.listEnclosures().then(setEnclosures).catch(console.error);
    api.listCables().then(setCables).catch(console.error);
    api.listCustomers().then(setCustomers).catch(console.error);
    api
      .capacityByEnclosure()
      .then((rows) =>
        setCapacityByEnclosure(
          Object.fromEntries(rows.map((r) => [r.id, r.available_cores])),
        ),
      )
      .catch(console.error);
  }, []);

  useEffect(() => {
    reloadAll();
  }, [reloadAll]);

  // Save theme preference
  useEffect(() => {
    localStorage.setItem("fiberline-theme", theme);
    document.body.className = theme === "light" ? "light-theme" : "dark-theme";
  }, [theme]);

  function handleThemeToggle() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  function resetPending() {
    setPendingPolePoint(null);
    setPendingEnclosurePole(null);
    setPendingCustomerEnclosurePoint(null);
    setCableDraft({ from: null, to: null, routePoints: [] });
    setCustomerPoint(null);
    setCableRoutePreview(null);
  }

  function handleModeChange(next) {
    setMode(next);
    resetPending();
  }

  function handleMapClick(latlng) {
    if (mode === "add-pole") setPendingPolePoint(latlng);
    if (mode === "add-customer-enclosure") setPendingCustomerEnclosurePoint(latlng);
    if (mode === "locate-customer") setCustomerPoint(latlng);
    if (mode === "draw-cable") {
      setCableDraft((draft) => {
        if (!draft.from || draft.to) return draft;
        return { ...draft, routePoints: [...draft.routePoints, latlng] };
      });
    }
    // In view mode, clicking on the map clears any selection
    if (mode === "view") {
      setSelectedPole(null);
      setSelectedEnclosure(null);
      setSelectedCable(null);
      setSplitPointLngLat(null);
      setSplitRatio(null);
    }
  }

  function handlePoleClick(pole) {
    if (mode === "add-enclosure") setPendingEnclosurePole(pole);
  }

  function handleEnclosureClick(enc) {
    if (mode === "draw-cable") {
      setCableDraft((d) => {
        if (!d.from) return { from: enc, to: null, routePoints: [] };
        if (enc.id === d.from.id) return d;
        if (!d.to) return { ...d, to: enc };
        return d;
      });
      return;
    }
    setSelectedEnclosure(enc);
    setSelectedCable(null);
  }

  function handleSplitPointChange(pointLngLat, ratio) {
    if (
      pointLngLat &&
      Array.isArray(pointLngLat) &&
      pointLngLat.length === 2 &&
      pointLngLat[0] != null &&
      pointLngLat[1] != null &&
      Number.isFinite(pointLngLat[0]) &&
      Number.isFinite(pointLngLat[1])
    ) {
      setSplitPointLngLat(pointLngLat);
      setSplitRatio(ratio);
    } else {
      setSplitPointLngLat(null);
      setSplitRatio(null);
    }
  }

  function handleSelectPole(pole) {
    setSelectedPole(pole);
    setSelectedEnclosure(null);
    setSelectedCable(null);
    setSplitPointLngLat(null);
    setSplitRatio(null);
  }

  function handleSelectEnclosure(enc) {
    setSelectedEnclosure(enc);
    setSelectedPole(null);
    setSelectedCable(null);
    setSplitPointLngLat(null);
    setSplitRatio(null);
  }

  function handleSelectCable(cable) {
    setSelectedCable(cable);
    setSelectedPole(null);
    setSelectedEnclosure(null);
    setSplitPointLngLat(null);
    setSplitRatio(null);
  }

  async function handleCreatePole(data) {
    await api.createPole(data);
    setPendingPolePoint(null);
    reloadAll();
  }

  async function handleDeletePole(poleId) {
    if (!confirm("Delete this pole? All attached enclosures will also be removed.")) return;
    try {
      await api.deletePole(poleId);
      // Clear selection if the deleted pole was selected
      if (selectedPole?.id === poleId) {
        setSelectedPole(null);
      }
      reloadAll();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleCreateEnclosure(data) {
    await api.createEnclosure(data);
    setPendingEnclosurePole(null);
    setPendingCustomerEnclosurePoint(null);
    reloadAll();
  }

  async function handleDeleteEnclosure(enclosureId) {
    if (!confirm("Delete this box? Any cables attached to it must be removed first.")) return;
    try {
      await api.deleteEnclosure(enclosureId);
      if (selectedEnclosure?.id === enclosureId) setSelectedEnclosure(null);
      reloadAll();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleDeleteCable(cableId) {
    if (!confirm("Delete this cable? Its cores must not be wired into splices or splitters.")) return;
    try {
      await api.deleteCable(cableId);
      if (selectedCable?.id === cableId) setSelectedCable(null);
      reloadAll();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleCreateCable(data) {
    try {
      await api.createCable(data);
      setCableDraft({ from: null, to: null, routePoints: [] });
      setCableRoutePreview(null);
      reloadAll();
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleCreateCustomer(data) {
    await api.createCustomer(data);
    reloadAll();
  }

  function undoCableRoutePoint() {
    setCableDraft((draft) => {
      if (!draft.routePoints.length || draft.to) return draft;
      return { ...draft, routePoints: draft.routePoints.slice(0, -1) };
    });
  }

  function clearCableRoute() {
    setCableDraft((draft) => ({ ...draft, routePoints: [] }));
  }

  function toLatLngPairs(route) {
    if (!Array.isArray(route)) return [];
    return route
      .map((point) => {
        if (Array.isArray(point)) {
          return [point[1], point[0]];
        }
        if (point && typeof point === "object") {
          return [point.lat, point.lng];
        }
        return null;
      })
      .filter(Boolean);
  }

  // User location tracking
  function handleLocateMe() {
    if (!navigator.geolocation) {
      setLocationError("Geolocation is not supported by your browser");
      return;
    }
    
    setIsTracking(true);
    setLocationError(null);
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserPosition({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setLocationError(null);
      },
      (error) => {
        setLocationError(error.message || "Unable to get your location");
        setUserPosition(null);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
    
    setTimeout(() => setIsTracking(false), 1000);
  }

  const pendingCableRoute = cableDraft.from
    ? [
        [cableDraft.from.lat, cableDraft.from.lng],
        ...cableDraft.routePoints.map((point) => [point.lat, point.lng]),
        ...(cableDraft.to ? [[cableDraft.to.lat, cableDraft.to.lng]] : []),
      ]
    : [];

  // Handle resize
  useEffect(() => {
    if (!isResizing) return;
    
    function handleMouseMove(e) {
      const newWidth = window.innerWidth - e.clientX;
      if (newWidth >= 280 && newWidth <= 800) {
        setRightPanelWidth(newWidth);
      }
    }
    
    function handleMouseUp() {
      setIsResizing(false);
    }
    
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  // Fetch customer route when customer point is set
  useEffect(() => {
    if (customerPoint && mode === "locate-customer") {
      api.customerLookup(customerPoint.lat, customerPoint.lng)
        .then((result) => {
          if (result.recommended_box) {
            return api.getCustomerRoute(
              customerPoint.lat,
              customerPoint.lng,
              result.recommended_box.id
            );
          }
          return null;
        })
        .then((route) => {
          if (route) {
            setCustomerRoute(route);
          }
        })
        .catch((err) => {
          console.error("Failed to fetch customer route:", err);
          setCustomerRoute(null);
        });
    } else {
      setCustomerRoute(null);
    }
  }, [customerPoint, mode]);

  return (
    <div className={"app-shell " + (theme === "light" ? "light-theme" : "dark-theme")} style={{ cursor: isResizing ? "col-resize" : "default" }}>
      <div className="topbar">
        <div className="brand">
          FIBER<span>LINE</span>
        </div>
        <div className="mode-toggle">
          {MODES.map((m) => (
            <button
              key={m.key}
              className={mode === m.key ? "active" : ""}
              onClick={() => handleModeChange(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="map-provider-toggle" style={{ display: "flex", gap: "4px", marginLeft: "12px" }}>
          {MAP_PROVIDERS.map((p) => (
            <button
              key={p.key}
              className={mapProvider === p.key ? "active" : ""}
              onClick={() => setMapProvider(p.key)}
              style={{ fontSize: "11px", padding: "2px 8px" }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          className="btn"
          onClick={handleLocateMe}
          title="Locate my position"
          style={{ marginLeft: "8px", padding: "4px 10px", display: "flex", alignItems: "center", gap: "4px" }}
        >
          <LocateFixed size={14} />
          {isTracking && <span style={{ fontSize: "11px" }}>...</span>}
        </button>
        {locationError && (
          <span style={{ color: "var(--red)", fontSize: "11px", marginLeft: "8px" }}>
            {locationError}
          </span>
        )}
        <button
          className="btn"
          onClick={handleThemeToggle}
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          style={{ marginLeft: "8px", padding: "4px 10px", display: "flex", alignItems: "center", gap: "4px" }}
        >
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <div className="topbar-hint">{HINTS[mode]}</div>
      </div>

      <div className="main-flex">
        <div className="panel left">
          <ErrorBoundary fallbackMessage="The side panel hit a rendering error.">
          <LeftPanel
            mode={mode}
            poles={poles}
            enclosures={enclosures}
            cables={cables}
            customers={customers}
            pendingPolePoint={pendingPolePoint}
            pendingEnclosurePole={pendingEnclosurePole}
            pendingCustomerEnclosurePoint={pendingCustomerEnclosurePoint}
            cableDraft={cableDraft}
            routePoints={cableDraft.routePoints}
            routePreview={cableRoutePreview}
            onPreviewRoute={setCableRoutePreview}
            selectedId={selectedPole?.id || selectedEnclosure?.id || selectedCable?.id}
            onSelectPole={handleSelectPole}
            onSelectEnclosure={handleEnclosureClick}
            onSelectCable={handleSelectCable}
            onCreatePole={handleCreatePole}
            onDeletePole={handleDeletePole}
            onCreateEnclosure={handleCreateEnclosure}
            onDeleteEnclosure={handleDeleteEnclosure}
            onCreateCable={handleCreateCable}
            onDeleteCable={handleDeleteCable}
            onUndoRoutePoint={undoCableRoutePoint}
            onClearRoute={clearCableRoute}
            onCancelMode={() => handleModeChange("view")}
          />
          </ErrorBoundary>
        </div>

        <div className="map-container">
          <ErrorBoundary fallbackMessage="The map hit a rendering error. Try switching map provider.">
          {mapProvider === "leaflet" && (
            <MapView
              poles={poles}
              enclosures={enclosures}
              cables={cables}
              capacityByEnclosure={capacityByEnclosure}
              mode={mode}
              pendingCableRoute={
                cableRoutePreview?.route
                  ? toLatLngPairs(cableRoutePreview.route)
                  : pendingCableRoute
              }
              pendingCableWaypoints={cableDraft.routePoints}
              selectedEnclosureId={selectedEnclosure?.id}
              selectedPoleId={selectedPole?.id}
              selectedCableId={selectedCable?.id}
              splitPointLngLat={splitPointLngLat}
              userPosition={userPosition}
              customerRoute={customerRoute}
              onMapClick={handleMapClick}
              onPoleClick={handlePoleClick}
              onEnclosureClick={handleEnclosureClick}
              onCableClick={handleSelectCable}
            />
          )}
          {mapProvider === "google" && (
            <LoadScript googleMapsApiKey={import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ""}>
              <MapViewGoogle
                poles={poles}
                enclosures={enclosures}
                cables={cables}
                capacityByEnclosure={capacityByEnclosure}
                mode={mode}
                pendingCableRoute={
                  cableRoutePreview?.route
                    ? toLatLngPairs(cableRoutePreview.route)
                    : pendingCableRoute
                }
                pendingCableWaypoints={cableDraft.routePoints}
                selectedEnclosureId={selectedEnclosure?.id}
                selectedPoleId={selectedPole?.id}
                selectedCableId={selectedCable?.id}
                splitPointLngLat={splitPointLngLat}
                userPosition={userPosition}
                customerRoute={customerRoute}
                onMapClick={handleMapClick}
                onPoleClick={handlePoleClick}
                onEnclosureClick={handleEnclosureClick}
                onCableClick={handleSelectCable}
              />
            </LoadScript>
          )}
          {mapProvider === "mapbox" && (
            <MapViewMapbox
              poles={poles}
              enclosures={enclosures}
              cables={cables}
              capacityByEnclosure={capacityByEnclosure}
              mode={mode}
              pendingCableRoute={
                cableRoutePreview?.route
                  ? toLatLngPairs(cableRoutePreview.route)
                  : pendingCableRoute
              }
              pendingCableWaypoints={cableDraft.routePoints}
              selectedEnclosureId={selectedEnclosure?.id}
              selectedPoleId={selectedPole?.id}
              selectedCableId={selectedCable?.id}
              splitPointLngLat={splitPointLngLat}
              userPosition={userPosition}
              customerRoute={customerRoute}
              onMapClick={handleMapClick}
              onPoleClick={handlePoleClick}
              onEnclosureClick={handleEnclosureClick}
              onCableClick={handleSelectCable}
            />
          )}
          </ErrorBoundary>
        </div>

        <div
          className="resize-handle"
          onMouseDown={(e) => {
            e.preventDefault();
            setIsResizing(true);
          }}
        />

        <div
          className="panel right"
          style={{ width: rightPanelWidth, minWidth: 280, maxWidth: 800 }}
        >
          <ErrorBoundary fallbackMessage="The details panel hit a rendering error.">
          <RightPanel
            mode={mode}
            selectedEnclosure={selectedEnclosure}
            selectedCable={selectedCable}
            customerPoint={customerPoint}
            customers={customers}
            onCreateCustomer={handleCreateCustomer}
            onChanged={reloadAll}
            onDeleteEnclosure={handleDeleteEnclosure}
            onDeleteCable={handleDeleteCable}
            onSplitPointChange={handleSplitPointChange}
          />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
