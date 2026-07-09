import React, { useEffect, useState, useCallback } from "react";
import MapView from "./components/MapView.jsx";
import LeftPanel from "./components/LeftPanel.jsx";
import RightPanel from "./components/RightPanel.jsx";
import { api } from "./api";

const MODES = [
  { key: "view", label: "View" },
  { key: "add-pole", label: "Add pole" },
  { key: "add-enclosure", label: "Add box" },
  { key: "draw-cable", label: "Draw cable" },
  { key: "locate-customer", label: "Locate customer" },
];

const HINTS = {
  view: "Click a box for its documentation, or a cable in the list to trace it.",
  "add-pole": "Click the map to place a pole.",
  "add-enclosure": "Click a pole to attach a box to it.",
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
  const [pendingPolePoint, setPendingPolePoint] = useState(null);
  const [pendingEnclosurePole, setPendingEnclosurePole] = useState(null);
  const [cableDraft, setCableDraft] = useState({
    from: null,
    to: null,
    routePoints: [],
  });
  const [customerPoint, setCustomerPoint] = useState(null);
  const [cableRoutePreview, setCableRoutePreview] = useState(null);

  const [selectedEnclosure, setSelectedEnclosure] = useState(null);
  const [selectedCable, setSelectedCable] = useState(null);

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

  function resetPending() {
    setPendingPolePoint(null);
    setPendingEnclosurePole(null);
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
    if (mode === "locate-customer") setCustomerPoint(latlng);
    if (mode === "draw-cable") {
      setCableDraft((draft) => {
        if (!draft.from || draft.to) return draft;
        return { ...draft, routePoints: [...draft.routePoints, latlng] };
      });
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

  function handleSelectCable(cable) {
    setSelectedCable(cable);
    setSelectedEnclosure(null);
  }

  async function handleCreatePole(data) {
    await api.createPole(data);
    setPendingPolePoint(null);
    reloadAll();
  }

  async function handleCreateEnclosure(data) {
    await api.createEnclosure(data);
    setPendingEnclosurePole(null);
    reloadAll();
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

  const pendingCableRoute = cableDraft.from
    ? [
        [cableDraft.from.lat, cableDraft.from.lng],
        ...cableDraft.routePoints.map((point) => [point.lat, point.lng]),
        ...(cableDraft.to ? [[cableDraft.to.lat, cableDraft.to.lng]] : []),
      ]
    : [];

  return (
    <div className="app-shell">
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
        <div className="topbar-hint">{HINTS[mode]}</div>
      </div>

      <div className="main-grid">
        <div className="panel left">
          <LeftPanel
            mode={mode}
            poles={poles}
            enclosures={enclosures}
            cables={cables}
            customers={customers}
            pendingPolePoint={pendingPolePoint}
            pendingEnclosurePole={pendingEnclosurePole}
            cableDraft={cableDraft}
            routePoints={cableDraft.routePoints}
            routePreview={cableRoutePreview}
            onPreviewRoute={setCableRoutePreview}
            selectedId={selectedEnclosure?.id || selectedCable?.id}
            onSelectPole={() => {}}
            onSelectEnclosure={handleEnclosureClick}
            onSelectCable={handleSelectCable}
            onCreatePole={handleCreatePole}
            onCreateEnclosure={handleCreateEnclosure}
            onCreateCable={handleCreateCable}
            onUndoRoutePoint={undoCableRoutePoint}
            onClearRoute={clearCableRoute}
            onCancelMode={() => handleModeChange("view")}
          />
        </div>

        <div className="map-container">
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
            onMapClick={handleMapClick}
            onPoleClick={handlePoleClick}
            onEnclosureClick={handleEnclosureClick}
          />
        </div>

        <div className="panel right">
          <RightPanel
            mode={mode}
            selectedEnclosure={selectedEnclosure}
            selectedCable={selectedCable}
            customerPoint={customerPoint}
            customers={customers}
            onCreateCustomer={handleCreateCustomer}
            onChanged={reloadAll}
          />
        </div>
      </div>
    </div>
  );
}
