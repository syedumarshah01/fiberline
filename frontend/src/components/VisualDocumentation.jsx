import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pairTag, pairColor, splicePairsByCore } from "../utils/spliceWiring.js";

/**
 * Box wiring diagram — visual view of an enclosure's documentation.
 *
 * Fed by GET /enclosures/:id/documentation (already loaded by the parent
 * panel). Rendered as HTML (so it stays readable at any panel width) with an
 * absolutely-positioned SVG overlay for the wires:
 *
 *   left column  – cables arriving INTO this box, one row per fiber core
 *   center lane  – the box itself + one node per splitter
 *   right column – cables leaving this box, one row per fiber core
 *
 * Every splice is a numbered pair (S1, S2, …) with its own color: both core
 * ports wear the pair tag, and a wire in the same color connects the two
 * exact ports. Below the diagram, the "Splice map" lists each pair in plain
 * text; hovering a row (or a wire) highlights the pair end to end.
 *
 * Port positions are measured after layout (getBoundingClientRect relative to
 * the diagram container — stable across panel scrolling) and recomputed when
 * the panel is resized or the data reloads.
 */

// Standard 12-fiber color code (same sequence used for fiber chips elsewhere)
const FIBER_COLORS = [
  "#3b82f6", "#f59e0b", "#22c55e", "#a16207", "#94a3b8", "#e2e8f0",
  "#ef4444", "#1f2937", "#eab308", "#8b5cf6", "#f472b6", "#22d3ee",
];

const STATUS_ORDER = ["available", "spliced", "terminated", "reserved", "damaged"];

const SPLITTER_COLOR = "#8b7cf6";

function fiberColor(coreNumber) {
  return FIBER_COLORS[(coreNumber - 1) % 12] || "#808080";
}

function bezier(a, b, bendA, bendB) {
  // Horizontal S-curve pulled into the center lane from both sides.
  return `M ${a.x} ${a.y} C ${a.x + bendA} ${a.y}, ${b.x + bendB} ${b.y}, ${b.x} ${b.y}`;
}

/** One fiber core row inside a cable card. `portRef` anchors wires. The port
 *  dot sits on the card edge facing the center lane (right edge for IN cables,
 *  left for OUT), together with the splice-pair tag when spliced.
 *  IN rows get a second line: what this fiber's far end is connected to in
 *  the upstream box (the core it's spliced to there, or the splitter port it
 *  hangs off), so a fiber's origin is traceable without opening that box. */
function CoreRow({ core, side, pair, portRef, hot }) {
  const dot = (
    <span className="vdoc-port" ref={portRef} style={pair ? { borderColor: pair.color } : undefined} />
  );
  const tag = pair ? (
    <span className="vdoc-tag" style={{ backgroundColor: pair.color }} title={`splice pair ${pair.tag}`}>
      {pair.tag}
    </span>
  ) : null;
  const far = side === "in" ? core.far_endpoint : null;
  return (
    <div className="vdoc-corewrap">
      <div className={"vdoc-core" + (hot ? " hot" : "")}>
        {side === "out" && (
          <span className="vdoc-edge">{dot}{tag}</span>
        )}
        <span className="vdoc-core-num">#{core.core_number}</span>
        <span className="fiber-chip" style={{ backgroundColor: fiberColor(core.core_number) }} title="fiber color code" />
        <span className={`pill pill-${core.status} vdoc-core-status`}>{core.status}</span>
        {side === "in" && (
          <span className="vdoc-edge">{tag}{dot}</span>
        )}
      </div>
      {far && far.enclosure_code && (
        <div className="vdoc-upstream" title={`Far end of this fiber, in box ${far.enclosure_code}`}>
          ⇠ {far.enclosure_code} · {far.label}
        </div>
      )}
    </div>
  );
}

function CableCard({ group, side, pairsByCore, registerPort, hotCoreIds }) {
  const cores = [...group.cores].sort((a, b) => a.core_number - b.core_number);
  return (
    <div className="vdoc-card">
      <div className="vdoc-card-head">
        <span className="vdoc-card-code">{group.cable.code}</span>
        <span className="vdoc-card-count">
          {cores.length}/{group.cable.core_count}
        </span>
      </div>
      <div className="vdoc-card-sub">
        {group.cable.cable_type}
        {group.cable.customer_label ? ` · ${group.cable.customer_label}` : ""}
      </div>
      {cores.map((core) => (
        <CoreRow
          key={core.id}
          core={core}
          side={side}
          pair={pairsByCore.get(core.id) || null}
          portRef={registerPort(core.id)}
          hot={hotCoreIds.has(core.id)}
        />
      ))}
      {cores.length === 0 && <div className="vdoc-card-empty">no cores</div>}
    </div>
  );
}

export default function VisualDocumentation({ doc, onBack, onChanged }) {
  const containerRef = useRef(null);
  const portEls = useRef(new Map());
  const [positions, setPositions] = useState({});
  // Splice (id) currently hovered either on a wire or in the splice map
  const [hoverSpliceId, setHoverSpliceId] = useState(null);

  // ------------------------------------------------------------------
  // Data shaping
  // ------------------------------------------------------------------
  const model = useMemo(() => {
    if (!doc) return null;
    const groups = doc.cables_landing_here || [];
    const inGroups = groups.filter((g) => g.direction === "in");
    const outGroups = groups.filter((g) => g.direction === "out");
    const pairsByCore = splicePairsByCore(doc.splices);
    // Which side of the box each core sits on (for wire bend direction)
    const sideByCore = new Map();
    [...inGroups, ...outGroups].forEach((g) => {
      const side = g.direction === "in" ? "in" : "out";
      (g.cores || []).forEach((c) => sideByCore.set(c.id, side));
    });
    return { inGroups, outGroups, pairsByCore, sideByCore };
  }, [doc]);

  // ------------------------------------------------------------------
  // Wire geometry — measured from the actual DOM, so the wires always land
  // exactly on their ports no matter the panel width or content reflow.
  // ------------------------------------------------------------------
  const registerPort = useCallback(
    (id) => (el) => {
      if (el) portEls.current.set(id, el);
      else portEls.current.delete(id);
    },
    [],
  );

  const measure = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const cr = c.getBoundingClientRect();
    const pos = {};
    portEls.current.forEach((el, id) => {
      const r = el.getBoundingClientRect();
      pos[id] = { x: r.left + r.width / 2 - cr.left, y: r.top + r.height / 2 - cr.top };
    });
    setPositions(pos);
  }, []);

  useLayoutEffect(() => {
    // rAF so fonts/flexbox have settled before we measure
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [measure, doc]);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [measure]);

  if (!doc || !model) {
    return <p className="loading-row">Loading visual documentation…</p>;
  }

  const { enclosure, summary } = doc;
  const { inGroups, outGroups, pairsByCore, sideByCore } = model;
  const noCables = (doc.cables_landing_here || []).length === 0;
  const splices = doc.splices || [];
  const splitters = doc.splitters || [];

  const hoveredSplice = splices.find((s) => s.id === hoverSpliceId) || null;
  const hotCoreIds = new Set(
    hoveredSplice ? [hoveredSplice.core_a_id, hoveredSplice.core_b_id] : [],
  );

  // Wire endpoint positions (skip wires whose cores aren't in this box's cables)
  const spliceWires = splices
    .map((s, i) => ({
      splice: s,
      tag: pairTag(i),
      color: pairColor(i),
      a: positions[s.core_a_id],
      b: positions[s.core_b_id],
      sideA: sideByCore.get(s.core_a_id),
      sideB: sideByCore.get(s.core_b_id),
    }))
    .filter((w) => w.a && w.b);

  const splitterWires = [];
  splitters.forEach((sp) => {
    const node = positions[`sp-${sp.id}`];
    const input = sp.input_core_id ? positions[sp.input_core_id] : null;
    if (node && input) {
      splitterWires.push({
        key: `in-${sp.id}`,
        a: input,
        b: node,
        bendA: sideByCore.get(sp.input_core_id) === "out" ? -40 : 40,
        bendB: 0,
      });
    }
    // Cascaded input: fed from a port of another splitter in this box
    if (node && sp.parent) {
      const parentNode = positions[`sp-${sp.parent.splitter_id}`];
      if (parentNode) {
        splitterWires.push({
          key: `cascade-${sp.parent.splitter_id}-${sp.parent.port_number}`,
          a: parentNode,
          b: node,
          bendA: 0,
          bendB: 0,
          cascade: true,
          label: `port ${sp.parent.port_number}`,
        });
      }
    }
    (sp.ports || []).forEach((p) => {
      const out = p.core_id ? positions[p.core_id] : null;
      if (node && out) {
        splitterWires.push({
          key: `out-${sp.id}-${p.port_number}`,
          a: node,
          b: out,
          bendA: 0,
          bendB: sideByCore.get(p.core_id) === "out" ? -40 : 40,
        });
      }
    });
  });

  return (
    <div className="vdoc">
      {/* Summary strip */}
      <div className="vdoc-summary">
        <span className="core-count-chip">{summary.total_cores} cores</span>
        {STATUS_ORDER.filter((s) =>
          s === "available" ? summary.available_cores
          : s === "spliced" ? summary.spliced_cores
          : s === "terminated" ? summary.terminated_cores
          : (summary[`${s}_cores`] || 0) > 0,
        ).map((s) => (
          <span key={s} className={`core-count-chip chip-${s}`}>
            {s === "available" ? summary.available_cores
              : s === "spliced" ? summary.spliced_cores
              : s === "terminated" ? summary.terminated_cores
              : summary[`${s}_cores`] || 0}{" "}
            {s}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <button className="btn" style={{ padding: "3px 10px", fontSize: 11 }} onClick={() => onChanged?.()}>
          Refresh
        </button>
        {onBack && (
          <button className="btn" style={{ padding: "3px 10px", fontSize: 11 }} onClick={onBack}>
            Back to text
          </button>
        )}
      </div>

      <p className="vdoc-howto">
        Each splice is a numbered, colored pair: the wire connects the two exact
        fiber ports wearing that tag. Hover a wire or a row in the splice map
        below to trace it.
      </p>

      <div className="vdoc-diagram" ref={containerRef}>
        <div className="vdoc-cols">
          <div className="vdoc-col">
            <div className="vdoc-col-title">IN ▸ from upstream</div>
            {inGroups.map((g) => (
              <CableCard
                key={g.cable.id}
                group={g}
                side="in"
                pairsByCore={pairsByCore}
                registerPort={registerPort}
                hotCoreIds={hotCoreIds}
              />
            ))}
            {inGroups.length === 0 && <div className="vdoc-empty">no cables in</div>}
          </div>

          <div className="vdoc-lane">
            <div className="vdoc-boxchip">
              <span className="vdoc-boxchip-code">{enclosure.code}</span>
              <span className="vdoc-boxchip-type">{enclosure.type.replace("_", " ")}</span>
            </div>
            {splitters.map((sp) => (
              <div className="vdoc-spnode" key={sp.id} ref={registerPort(`sp-${sp.id}`)} title={sp.name || `1:${sp.split_count} splitter`}>
                <span className="vdoc-spnode-diamond">◆</span> 1:{sp.split_count}
                {sp.name ? <span className="vdoc-spnode-name">{sp.name}</span> : null}
              </div>
            ))}
          </div>

          <div className="vdoc-col">
            <div className="vdoc-col-title">OUT ▸ to downstream</div>
            {outGroups.map((g) => (
              <CableCard
                key={g.cable.id}
                group={g}
                side="out"
                pairsByCore={pairsByCore}
                registerPort={registerPort}
                hotCoreIds={hotCoreIds}
              />
            ))}
            {outGroups.length === 0 && <div className="vdoc-empty">no cables out</div>}
          </div>
        </div>

        {/* Wire overlay */}
        <svg className="vdoc-wires" aria-hidden="true">
          {splitterWires.map((w) => (
            <g key={w.key}>
              <path
                d={bezier(w.a, w.b, w.bendA, w.bendB)}
                className={"vdoc-wire vdoc-wire-splitter" + (w.cascade ? " vdoc-wire-cascade" : "")}
                style={{ stroke: SPLITTER_COLOR }}
              />
              {w.label && (
                <text
                  x={(w.a.x + w.b.x) / 2 + 6}
                  y={(w.a.y + w.b.y) / 2 - 4}
                  className="vdoc-wirelabel"
                >
                  {w.label}
                </text>
              )}
            </g>
          ))}
          {spliceWires.map((w) => (
            <path
              key={w.splice.id}
              d={bezier(
                w.a,
                w.b,
                w.sideA === "out" ? -46 : 46,
                w.sideB === "out" ? -46 : 46,
              )}
              className={"vdoc-wire" + (hoverSpliceId === w.splice.id ? " hot" : "")}
              style={{ stroke: w.color }}
              strokeDasharray={w.splice.splice_type === "mechanical" ? "5 4" : "none"}
              onMouseEnter={() => setHoverSpliceId(w.splice.id)}
              onMouseLeave={() => setHoverSpliceId((h) => (h === w.splice.id ? null : h))}
            >
              <title>
                {w.tag}: {w.splice.cable_a_code}#{w.splice.core_a_number} ⇄ {w.splice.cable_b_code}#{w.splice.core_b_number}
                {w.splice.splice_type ? ` · ${w.splice.splice_type}` : ""}
                {w.splice.tray_number ? ` · tray ${w.splice.tray_number}` : ""}
                {w.splice.loss_db != null ? ` · ${w.splice.loss_db} dB` : ""}
              </title>
            </path>
          ))}
        </svg>
      </div>

      {noCables && <p className="empty-state">No cables land in this box yet.</p>}

      {/* Splice map — the explicit, unambiguous pairing list */}
      <p className="section-title" style={{ marginTop: 14 }}>Splice map</p>
      {splices.length ? (
        <div className="vdoc-splicemap">
          {splices.map((s, i) => (
            <div
              key={s.id}
              className={"vdoc-splicerow" + (hoverSpliceId === s.id ? " hot" : "")}
              onMouseEnter={() => setHoverSpliceId(s.id)}
              onMouseLeave={() => setHoverSpliceId((h) => (h === s.id ? null : h))}
            >
              <span className="vdoc-tag" style={{ backgroundColor: pairColor(i) }}>
                {pairTag(i)}
              </span>
              <span className="vdoc-end">
                <span className="fiber-chip" style={{ backgroundColor: fiberColor(s.core_a_number) }} />
                {s.cable_a_code} <strong>#{s.core_a_number}</strong>
              </span>
              <span className="vdoc-arrow">⟷</span>
              <span className="vdoc-end">
                <span className="fiber-chip" style={{ backgroundColor: fiberColor(s.core_b_number) }} />
                {s.cable_b_code} <strong>#{s.core_b_number}</strong>
              </span>
              <span className="vdoc-meta">
                {s.splice_type}
                {s.tray_number ? ` · tray ${s.tray_number}${s.tray_position ? `/${s.tray_position}` : ""}` : ""}
                {s.loss_db != null ? ` · ${s.loss_db} dB` : ""}
              </span>
              {s.notes ? <div className="vdoc-splicenote">📝 {s.notes}</div> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="empty-state">No splices recorded in this box yet.</p>
      )}

      {/* Splitter assignments */}
      {splitters.length > 0 && (
        <>
          <p className="section-title" style={{ marginTop: 14 }}>Splitters</p>
          <div className="vdoc-splicemap">
            {splitters.map((sp) => {
              const input = (doc.cables_landing_here || [])
                .flatMap((g) => g.cores.map((c) => ({ ...c, cable_code: g.cable.code })))
                .find((c) => c.id === sp.input_core_id);
              return (
                <div key={sp.id} className="vdoc-splicerow vdoc-splitterrow">
                  <span className="vdoc-tag" style={{ backgroundColor: SPLITTER_COLOR }}>◆</span>
                  <span className="vdoc-end">
                    {sp.name || `1:${sp.split_count} splitter`} — in:{" "}
                    {sp.parent ? (
                      <>
                        port {sp.parent.port_number} of{" "}
                        <strong>{sp.parent.name || `1:${sp.parent.split_count} splitter`}</strong> (cascade)
                      </>
                    ) : input ? (
                      <>
                        <span className="fiber-chip" style={{ backgroundColor: fiberColor(input.core_number) }} />
                        {input.cable_code} <strong>#{input.core_number}</strong>
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                  <span className="vdoc-meta">
                    {(sp.ports || []).map((p) =>
                      p.core_id
                        ? `P${p.port_number}→${p.cable_code || "?"}#${p.core_number}`
                        : p.output_splitter_id
                          ? `P${p.port_number}→🔀 ${p.child_splitter_name || "splitter"}`
                          : `P${p.port_number}→empty`,
                    ).join(" · ") || "no ports"}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Legend */}
      <div className="vdoc-legend">
        <span className="vdoc-legend-item"><span className="vdoc-port vdoc-legend-port" /> fiber port (dot)</span>
        <span className="vdoc-legend-item"><span className="vdoc-tag" style={{ backgroundColor: pairColor(0) }}>S1</span> splice pair tag</span>
        <span className="vdoc-legend-item">
          <svg width="26" height="8" style={{ verticalAlign: "middle" }}>
            <line x1="0" y1="4" x2="26" y2="4" stroke={pairColor(0)} strokeWidth="2" />
          </svg>{" "}
          fusion splice
        </span>
        <span className="vdoc-legend-item">
          <svg width="26" height="8" style={{ verticalAlign: "middle" }}>
            <line x1="0" y1="4" x2="26" y2="4" stroke={pairColor(0)} strokeWidth="2" strokeDasharray="4 3" />
          </svg>{" "}
          mechanical splice
        </span>
        <span className="vdoc-legend-item">
          <svg width="26" height="8" style={{ verticalAlign: "middle" }}>
            <line x1="0" y1="4" x2="26" y2="4" stroke={SPLITTER_COLOR} strokeWidth="2" />
          </svg>{" "}
          splitter path
        </span>
      </div>
    </div>
  );
}
