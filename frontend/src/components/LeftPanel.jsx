import React, { useEffect, useId, useMemo, useState } from "react";
import { api } from "../api";
import {
  buildTwoOptions,
  nearestWithCode,
} from "../utils/codeSuggestion";
import { lookupAreaName } from "../utils/areaName";

function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

// Human labels used when composing name suggestions.
const BOX_LABELS = {
  splice_closure: "Splice Closure",
  cabinet: "Cabinet",
  nap: "NAP",
  handhole: "Handhole",
  terminal: "Terminal",
};
const CABLE_LABELS = {
  backbone: "Backbone",
  feeder: "Feeder",
  distribution: "Distribution",
  drop: "Drop",
};

/**
 * Resolve the map area name for a point (async, cached, fails soft to null).
 */
function useAreaName(point) {
  const [area, setArea] = useState(null);
  const lat = point?.lat;
  const lng = point?.lng;
  useEffect(() => {
    let cancelled = false;
    if (lat == null || lng == null) {
      setArea(null);
      return;
    }
    lookupAreaName(lat, lng).then((name) => {
      if (!cancelled) setArea(name);
    });
    return () => {
      cancelled = true;
    };
  }, [lat, lng]);
  return area;
}

/**
 * Two-option code/name suggestions for the add-box / draw-cable forms:
 * option 1 is based on the nearest existing asset, option 2 on the name of
 * the map area we're working in (via reverse geocoding).
 *
 * Returns { codeOptions, nameOptions } — arrays of at most 2 strings.
 */
function useTwoOptionSuggestions({ items, prefix, typeLabel, point }) {
  const area = useAreaName(point);
  return useMemo(() => {
    const codes = (items || []).map((i) => i.code);
    const names = (items || []).map((i) => i.name).filter(Boolean);
    const nearest = point ? nearestWithCode(items, point) : null;
    return buildTwoOptions({ codes, names, defaultPrefix: prefix, typeLabel, nearest, area });
  }, [items, prefix, typeLabel, point, area]);
}

/** Text input with a native two-option suggestion dropdown. */
function SuggestedField({ label, value, onChange, options, placeholder, autoFocus }) {
  const listId = useId();
  return (
    <Field label={label}>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>
    </Field>
  );
}

/**
 * "Tray/port capacity" from the box form — informational metadata only.
 * Real availability is derived from cores/splices by the backend, so this
 * is just a physical reference for technicians (with per-type defaults).
 */
const CAPACITY_DEFAULTS = {
  splice_closure: 24,
  cabinet: 96,
  nap: 16,
  handhole: 12,
  terminal: 8,
};

function CapacityField({ type, value, onChange }) {
  return (
    <Field label="Physical capacity (optional)">
      <input
        type="number"
        value={value}
        min="0"
        placeholder={String(CAPACITY_DEFAULTS[type] ?? 0)}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="field-hint">
        Splice trays / ports this box physically has — a reference note only
        (typical for a {type.replace("_", " ")}: {CAPACITY_DEFAULTS[type] ?? 0}).
        The free-core counts on the map are computed live from cores and
        splices, never from this number. Safe to leave as-is.
      </p>
    </Field>
  );
}

/**
 * Poles are anonymous mounting points for boxes — no code, no name.
 * Just pick the type; the backend assigns an internal code automatically.
 */
export function AddPoleForm({ point, onSubmit, onCancel }) {
  const [poleType, setPoleType] = useState("wooden");

  if (!point) {
    return (
      <p className="empty-state">Click anywhere on the map to place a pole.</p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          pole_type: poleType,
          lat: point.lat,
          lng: point.lng,
        });
      }}
    >
      <p className="empty-state">
        {point.lat.toFixed(6)}, {point.lng.toFixed(6)}
      </p>
      <Field label="Pole type">
        <select value={poleType} onChange={(e) => setPoleType(e.target.value)} autoFocus>
          <option value="wooden">Wooden</option>
          <option value="concrete">Concrete</option>
          <option value="existing-utility">Existing utility pole</option>
        </select>
      </Field>
      <button className="btn btn-primary btn-block" type="submit">
        Create pole
      </button>
      <button
        className="btn btn-block"
        type="button"
        style={{ marginTop: 6 }}
        onClick={onCancel}
      >
        Cancel
      </button>
    </form>
  );
}

export function AddEnclosureForm({ pole, onSubmit, onCancel, enclosures }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("splice_closure");
  // Empty = use the typical default for the chosen type.
  const [capacity, setCapacity] = useState("");
  const { codeOptions, nameOptions } = useTwoOptionSuggestions({
    items: enclosures,
    prefix: "BOX-",
    typeLabel: BOX_LABELS[type] ?? "Box",
    point: pole ? { lat: pole.lat, lng: pole.lng } : null,
  });

  if (!pole) {
    return (
      <p className="empty-state">
        Click a pole on the map to attach a box to it.
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!code.trim()) return;
        onSubmit({
          code,
          name,
          type,
          capacity: capacity === "" ? (CAPACITY_DEFAULTS[type] ?? 0) : Number(capacity),
          pole_id: pole.id,
        });
        setCode("");
        setName("");
      }}
    >
      <p className="empty-state">
        Attaching to the selected pole
      </p>
      <SuggestedField
        label="Box code *"
        value={code}
        onChange={setCode}
        options={codeOptions}
        placeholder="BOX-0042"
        autoFocus
      />
      <SuggestedField
        label="Name"
        value={name}
        onChange={setName}
        options={nameOptions}
        placeholder="Optional"
      />
      <Field label="Type">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="splice_closure">Splice closure</option>
          <option value="cabinet">Cabinet</option>
          <option value="nap">NAP (customer access point)</option>
          <option value="handhole">Handhole</option>
          <option value="terminal">Terminal</option>
        </select>
      </Field>
      <CapacityField type={type} value={capacity} onChange={setCapacity} />
      <button className="btn btn-primary btn-block" type="submit">
        Create box
      </button>
      <button
        className="btn btn-block"
        type="button"
        style={{ marginTop: 6 }}
        onClick={onCancel}
      >
        Cancel
      </button>
    </form>
  );
}

export function AddCustomerEnclosureForm({ point, onSubmit, onCancel, enclosures }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("terminal");
  const [capacity, setCapacity] = useState("");
  const { codeOptions, nameOptions } = useTwoOptionSuggestions({
    items: enclosures,
    prefix: "CUST-BOX-",
    typeLabel: BOX_LABELS[type] ?? "Box",
    point,
  });

  if (!point) {
    return (
      <p className="empty-state">
        Click the map at the customer's location to place a box.
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!code.trim()) return;
        onSubmit({
          code,
          name,
          type,
          capacity: capacity === "" ? (CAPACITY_DEFAULTS[type] ?? 0) : Number(capacity),
          lat: point.lat,
          lng: point.lng,
        });
        setCode("");
        setName("");
      }}
    >
      <p className="empty-state">
        Customer location: {point.lat.toFixed(6)}, {point.lng.toFixed(6)}
      </p>
      <SuggestedField
        label="Box code *"
        value={code}
        onChange={setCode}
        options={codeOptions}
        placeholder="CUST-BOX-001"
        autoFocus
      />
      <SuggestedField
        label="Name"
        value={name}
        onChange={setName}
        options={nameOptions}
        placeholder="Optional"
      />
      <Field label="Type">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="terminal">Terminal (customer box)</option>
          <option value="splice_closure">Splice closure</option>
          <option value="cabinet">Cabinet</option>
          <option value="nap">NAP (customer access point)</option>
        </select>
      </Field>
      <CapacityField type={type} value={capacity} onChange={setCapacity} />
      <button className="btn btn-primary btn-block" type="submit">
        Create customer box
      </button>
      <button
        className="btn btn-block"
        type="button"
        style={{ marginTop: 6 }}
        onClick={onCancel}
      >
        Cancel
      </button>
    </form>
  );
}

export function DrawCableForm({
  fromEnclosure,
  toEnclosure,
  customers,
  cables,
  routePoints,
  routePreview,
  onSubmit,
  onCancel,
  onUndoRoutePoint,
  onClearRoute,
  onPreviewRoute,
}) {
  // Cables have no direct lat/lng — use each route's midpoint so the nearest
  // cable's numbering family can win (mirrors "suggest based on nearby cables").
  const cablePoints = useMemo(
    () =>
      (cables || []).map((c) => {
        const mid = c.route && c.route.length
          ? c.route[Math.floor(c.route.length / 2)]
          : null;
        return mid
          ? { code: c.code, name: c.name, lng: mid[0], lat: mid[1] }
          : { code: c.code, name: c.name };
      }),
    [cables],
  );
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [cableType, setCableType] = useState("distribution");
  const [coreCount, setCoreCount] = useState(24);
  const [customerId, setCustomerId] = useState("");

  const isDrop = cableType === "drop";
  // For drop cables, customer is optional - can be set later
  const destinationReady = isDrop ? true : !!toEnclosure;
  const { codeOptions, nameOptions } = useTwoOptionSuggestions({
    items: cablePoints,
    prefix: "CBL-",
    typeLabel: CABLE_LABELS[cableType] ?? "Cable",
    point: fromEnclosure ? { lat: fromEnclosure.lat, lng: fromEnclosure.lng } : null,
  });
  const previewReady = !!routePreview?.route?.length;
  const canSubmit = code.trim() && destinationReady && previewReady;

  useEffect(() => {
    let cancelled = false;

    onPreviewRoute?.(null);

    async function previewRoute() {
      if (!fromEnclosure || !destinationReady) {
        return;
      }

      try {
        const preview = await api.previewCableRoute({
          cable_type: cableType,
          from_enclosure_id: fromEnclosure.id,
          to_enclosure_id: isDrop ? toEnclosure?.id : toEnclosure.id,
          customer_id: isDrop && !toEnclosure ? customerId : undefined,
          route_points: routePoints.map((point) => ({
            lat: point.lat,
            lng: point.lng,
          })),
        });

        if (!cancelled) onPreviewRoute?.(preview);
      } catch (err) {
        if (!cancelled) onPreviewRoute?.(null);
      }
    }

    previewRoute();

    return () => {
      cancelled = true;
    };
  }, [
    fromEnclosure,
    toEnclosure,
    cableType,
    customerId,
    destinationReady,
    routePoints,
    onPreviewRoute,
    isDrop,
  ]);

  if (!fromEnclosure) {
    return (
      <p className="empty-state">
        Click a box to start the cable, then click a second box as the
        destination.
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onSubmit({
          code,
          name: name || undefined,
          cable_type: cableType,
          core_count: Number(coreCount),
          from_enclosure_id: fromEnclosure.id,
          to_enclosure_id: isDrop ? toEnclosure?.id : toEnclosure.id,
          customer_id: isDrop && !toEnclosure ? customerId : undefined,
          customer_label: isDrop && !toEnclosure && customerId ? `CUST-${customerId.slice(0, 6)}` : undefined,
          route_points: routePoints.map((point) => ({
            lat: point.lat,
            lng: point.lng,
          })),
          route_geometry: routePreview?.route || undefined,
          length_m: routePreview?.length_m ?? undefined,
        });
        setCode("");
      }}
    >
      <p className="empty-state">
        From <code>{fromEnclosure.code}</code>
        {!isDrop &&
          (toEnclosure ? (
            <>
              {" "}
              → <code>{toEnclosure.code}</code>
            </>
          ) : (
            " — click the destination box on the map"
          ))}
      </p>
      <p className="empty-state" style={{ paddingTop: 0 }}>
        Duct route bends: {routePoints.length}
      </p>
      {!previewReady && destinationReady && (
        <p className="empty-state" style={{ paddingTop: 0 }}>
          Loading route preview...
        </p>
      )}

      {!!routePoints.length && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button className="btn" type="button" onClick={onUndoRoutePoint}>
            Undo last bend
          </button>
          <button className="btn" type="button" onClick={onClearRoute}>
            Clear route
          </button>
        </div>
      )}

      <Field label="Cable type">
        <select
          value={cableType}
          onChange={(e) => setCableType(e.target.value)}
        >
          <option value="feeder">Feeder</option>
          <option value="distribution">Distribution</option>
          <option value="drop">Drop (to customer)</option>
        </select>
      </Field>

      {isDrop && (
        <div style={{ marginBottom: 12 }}>
          <p className="empty-state" style={{ fontSize: 12, marginBottom: 8 }}>
            Drop cable will go to: {toEnclosure ? toEnclosure.code : "click destination on map"}
          </p>
          {customers.length > 0 && (
            <Field label="Or select customer (optional)">
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">No customer selected</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.customer_code} — {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}

      <SuggestedField
        label="Cable code *"
        value={code}
        onChange={setCode}
        options={codeOptions}
        placeholder="CBL-0042"
      />
      <SuggestedField
        label="Name"
        value={name}
        onChange={setName}
        options={nameOptions}
        placeholder="Optional"
      />
      <Field label="Core count">
        <input
          type="number"
          value={coreCount}
          onChange={(e) => setCoreCount(e.target.value)}
          min="1"
        />
      </Field>
      <button
        className="btn btn-primary btn-block"
        type="submit"
        disabled={!canSubmit}
      >
        Create cable
      </button>
      <button
        className="btn btn-block"
        type="button"
        style={{ marginTop: 6 }}
        onClick={onCancel}
      >
        Cancel
      </button>
    </form>
  );
}

export default function LeftPanel(props) {
  const {
    mode,
    poles,
    enclosures,
    cables,
    onSelectPole,
    onSelectEnclosure,
    onSelectCable,
    selectedId,
    onDeletePole,
    onDeleteEnclosure,
    onDeleteCable,
  } = props;

  const [tab, setTab] = useState("poles");

  if (mode !== "view") {
    return (
      <div>
        <p className="section-title">{mode.replace("-", " ")}</p>
        {mode === "add-pole" && (
          <AddPoleForm
            {...props}
            point={props.pendingPolePoint}
            onSubmit={props.onCreatePole}
            onCancel={props.onCancelMode}
          />
        )}
        {mode === "add-enclosure" && (
          <AddEnclosureForm
            {...props}
            pole={props.pendingEnclosurePole}
            onSubmit={props.onCreateEnclosure}
            onCancel={props.onCancelMode}
          />
        )}
        {mode === "add-customer-enclosure" && (
          <AddCustomerEnclosureForm
            {...props}
            point={props.pendingCustomerEnclosurePoint}
            onSubmit={props.onCreateEnclosure}
            onCancel={props.onCancelMode}
          />
        )}
        {mode === "draw-cable" && (
          <DrawCableForm
            fromEnclosure={props.cableDraft?.from}
            toEnclosure={props.cableDraft?.to}
            customers={props.customers}
            cables={props.cables}
            routePoints={props.routePoints || []}
            routePreview={props.routePreview}
            onSubmit={props.onCreateCable}
            onCancel={props.onCancelMode}
            onUndoRoutePoint={props.onUndoRoutePoint}
            onClearRoute={props.onClearRoute}
            onPreviewRoute={props.onPreviewRoute}
          />
        )}
        {mode === "locate-customer" && (
          <p className="empty-state">
            Click anywhere on the map to drop a customer pin and search nearby
            boxes.
          </p>
        )}
      </div>
    );
  }

  const tabs = [
    { key: "poles", label: "Poles", items: poles },
    { key: "enclosures", label: "Boxes", items: enclosures },
    { key: "cables", label: "Cables", items: cables },
  ];

  return (
    <div>
      <div className="mode-toggle" style={{ marginBottom: 12 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            className={tab === t.key ? "active" : ""}
            onClick={() => setTab(t.key)}
          >
            {t.label} ({t.items.length})
          </button>
        ))}
      </div>

      {tab === "poles" &&
        (poles.length ? (
          poles.map((p) => (
            <div
              key={p.id}
              className={`list-item ${selectedId === p.id ? "selected" : ""}`}
              onClick={() => onSelectPole(p)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div className="code">Pole</div>
                  <div className="sub">
                    {p.pole_type || "standard"} pole
                  </div>
                </div>
                {onDeletePole && (
                  <button
                    className="btn btn-danger"
                    style={{ padding: "2px 6px", fontSize: 10, marginLeft: 8 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeletePole(p.id);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="empty-state">
            No poles yet. Switch to "Add pole" and click the map.
          </p>
        ))}

      {onDeletePole && (
        <div style={{ marginTop: 12 }}>
          <p className="empty-state" style={{ fontSize: 11 }}>
            Click "Delete" on a pole to remove it. All attached boxes will also be removed.
          </p>
        </div>
      )}

      {tab === "enclosures" &&
        (enclosures.length ? (
          enclosures.map((e) => (
            <div
              key={e.id}
              className={`list-item ${selectedId === e.id ? "selected" : ""}`}
              onClick={() => onSelectEnclosure(e)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div className="code">{e.code}</div>
                  <div className="sub">
                    {e.type.replace("_", " ")} · {e.pole_id ? "pole-mounted" : "free-standing"}
                  </div>
                </div>
                {onDeleteEnclosure && (
                  <button
                    className="btn btn-danger"
                    style={{ padding: "2px 6px", fontSize: 10, marginLeft: 8 }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onDeleteEnclosure(e.id);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="empty-state">
            No boxes yet. Switch to "Add box" and click a pole.
          </p>
        ))}

      {tab === "cables" &&
        (cables.length ? (
          cables.map((c) => (
            <div
              key={c.id}
              className={`list-item ${selectedId === c.id ? "selected" : ""}`}
              onClick={() => onSelectCable(c)}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div className="code">{c.code}</div>
                  <div className="sub">
                    {c.cable_type} · {c.core_count} cores{" "}
                    {c.customer_label ? `· ${c.customer_label}` : ""}
                  </div>
                </div>
                {onDeleteCable && (
                  <button
                    className="btn btn-danger"
                    style={{ padding: "2px 6px", fontSize: 10, marginLeft: 8 }}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onDeleteCable(c.id);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))
        ) : (
          <p className="empty-state">No cables yet. Switch to "Draw cable".</p>
        ))}
    </div>
  );
}
