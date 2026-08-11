import React, { useState, useEffect, useCallback } from "react";
import { Search, RefreshCw, AlertTriangle, Loader2 } from "lucide-react";
import { api } from "../api";

/**
 * FIBER NETWORK DISTRIBUTOR — interactive dashboard widget
 * -----------------------------------------------------------------
 * Replicates a fiber distribution enclosure diagram, driven entirely
 * by a JSON payload that comes from a backend endpoint.
 *
 * Component structure:
 *   FiberDistributor        - top level: data fetching + state
 *     OpticalEnclosure        - the boxed bank of 12 core ports
 *     ConnectionLine          - single core: port + wire + port
 *     SplitterDetailModal     - floating "DETAIL" popover
 *     Legend                  - bottom-right key
 */

// ---------------------------------------------------------------------
// Layout constants (SVG user-space units — the viewBox scales
// responsively, so these are effectively "design pixels")
// ---------------------------------------------------------------------
const VB_W = 1400;
const VB_H = 800;
const BOX_X = 520;
const BOX_W = 170;
const BOX_TOP = 150;
const ROW_GAP = 42;
const ROW_START = 176;
const LEFT_PORT_X = BOX_X + 25;
const RIGHT_PORT_X = BOX_X + BOX_W - 25;
const EXT_PORT_X = 900;
const CONVERGE_X = 1140;
const TRUNK_COLOR = "#123b64";
const CENTER_Y_FALLBACK = 403;

function rowY(index) {
  return ROW_START + index * ROW_GAP;
}

// ---------------------------------------------------------------------
// ConnectionLine — one core: enclosure segment + exit wire + port dot
// ---------------------------------------------------------------------
function ConnectionLine({ conn, y, hasSplitter, isActive, onEnter, onLeave, onClick }) {
  const dashed = conn.status === "dotted";
  const strokeProps = {
    stroke: conn.color,
    strokeWidth: 4.5,
    strokeLinecap: "round",
    ...(dashed ? { strokeDasharray: "7 7" } : {}),
  };
  const needsOutline = conn.color.toLowerCase() === "#ecf0f1" || conn.color.toLowerCase() === "#ffffff";

  return (
    <g
      onMouseEnter={hasSplitter ? onEnter : undefined}
      onMouseLeave={hasSplitter ? onLeave : undefined}
      onClick={hasSplitter ? onClick : undefined}
      style={{ cursor: hasSplitter ? "pointer" : "default" }}
    >
      {/* inside-enclosure segment */}
      <line x1={LEFT_PORT_X} y1={y} x2={RIGHT_PORT_X} y2={y} {...strokeProps} />
      {/* exit wire to the mirrored external port */}
      <line x1={RIGHT_PORT_X} y1={y} x2={EXT_PORT_X} y2={y} {...strokeProps} opacity={0.9} />
      {/* converging fan into the shared output trunk */}
      <path
        d={`M ${EXT_PORT_X} ${y} C ${EXT_PORT_X + 140} ${y}, ${CONVERGE_X - 60} ${CENTER_Y_FALLBACK}, ${CONVERGE_X} ${CENTER_Y_FALLBACK}`}
        fill="none"
        stroke={conn.color}
        strokeWidth={2.5}
        opacity={0.85}
      />
      {/* ports */}
      {[LEFT_PORT_X, RIGHT_PORT_X, EXT_PORT_X].map((x, i) => (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={hasSplitter && i === 0 ? 9 : 7}
          fill={conn.color}
          stroke={needsOutline ? "#9aa5ab" : hasSplitter && i === 0 && isActive ? "#123b64" : "none"}
          strokeWidth={hasSplitter && i === 0 && isActive ? 2.5 : 1.2}
        />
      ))}
      {hasSplitter && (
        <circle
          cx={LEFT_PORT_X}
          cy={y}
          r={16}
          fill="none"
          stroke={isActive ? "#123b64" : "transparent"}
          strokeWidth={1.5}
          strokeDasharray="3 3"
          opacity={isActive ? 0.6 : 0}
          style={{ transition: "opacity 150ms ease" }}
        />
      )}
    </g>
  );
}

// ---------------------------------------------------------------------
// OpticalEnclosure — the boxed bank + all 12 rows
// ---------------------------------------------------------------------
function OpticalEnclosure({ connections, splitters, activeSplitterIndex, setActiveSplitterIndex }) {
  const boxBottom = ROW_START + (connections.length - 1) * ROW_GAP + 34;
  const splitterMap = new Map(splitters.map((s) => [s.sourceCoreIndex, s]));

  return (
    <g>
      <text x={BOX_X + BOX_W / 2} y={BOX_TOP - 16} textAnchor="middle" className="fnd-label">
        Optical Enclosure
      </text>
      <rect
        x={BOX_X}
        y={BOX_TOP}
        width={BOX_W}
        height={boxBottom - BOX_TOP}
        rx={10}
        fill="#f7f9fa"
        stroke="#123b64"
        strokeWidth={1.5}
      />
      <text x={BOX_X + BOX_W / 2} y={boxBottom + 26} textAnchor="middle" className="fnd-label">
        Optical Enclosure
      </text>

      {connections.map((conn, i) => (
        <ConnectionLine
          key={conn.coreIndex}
          conn={conn}
          y={rowY(i)}
          hasSplitter={splitterMap.has(conn.coreIndex)}
          isActive={activeSplitterIndex === conn.coreIndex}
          onEnter={() => setActiveSplitterIndex(conn.coreIndex)}
          onLeave={() => setActiveSplitterIndex(null)}
          onClick={() =>
            setActiveSplitterIndex((cur) => (cur === conn.coreIndex ? null : conn.coreIndex))
          }
        />
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------
// SplitterDetailModal — floating "DETAIL" popover with mini schematic
// ---------------------------------------------------------------------
function SplitterDetailModal({ splitter, anchorY }) {
  const modalW = 270;
  const outputCount = splitter.outputFibers.length;
  const svgH = Math.max(110, 30 + outputCount * 27);
  const modalH = svgH + 40;
  const modalX = RIGHT_PORT_X + 55;
  const modalY = Math.max(30, anchorY - 70);

  return (
    <foreignObject x={modalX - 14} y={0} width={modalW + 40} height={VB_H} style={{ overflow: "visible" }}>
      <div
        xmlns="http://www.w3.org/1999/xhtml"
        style={{
          position: "absolute",
          left: 14,
          top: modalY,
          width: modalW,
          background: "#ffffff",
          borderRadius: 10,
          boxShadow: "0 10px 30px rgba(18,59,100,0.22), 0 2px 8px rgba(18,59,100,0.12)",
          border: "1px solid #dfe6ea",
          fontFamily: "'Segoe UI', Inter, system-ui, sans-serif",
          animation: "fnd-fade-in 140ms ease-out",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "12px 14px",
            borderBottom: "1px solid #eef1f3",
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 600, color: "#1c2a33", lineHeight: 1.25 }}>
            DETAIL:
            <br />
            Splitter ({splitter.splitterType})
          </div>
          <Search size={18} color="#8a97a0" strokeWidth={2} />
        </div>
        <svg viewBox={`0 0 ${modalW} ${svgH}`} width={modalW} height={svgH} style={{ display: "block" }}>
          <line x1={20} y1={55} x2={78} y2={55} stroke="#0a3d91" strokeWidth={4} strokeLinecap="round" />
          <rect x={78} y={41} width={34} height={28} rx={3} fill="#1c2a33" />
          {splitter.outputFibers.map((f, i) => {
            const targetY = 15 + i * 27;
            // Add slight offset for unspiced/available fibers
            const offset = f.status === "available" || f.status === "unspiced" ? 8 : 0;
            return (
              <path
                key={i}
                d={`M 112 55 C 150 55, 150 ${targetY + offset}, 200 ${targetY + offset}`}
                fill="none"
                stroke={f.color}
                strokeWidth={3}
                strokeDasharray={f.status === "available" || f.status === "unspiced" ? "4 2" : "none"}
              />
            );
          })}
        </svg>
      </div>
      <style>{`
        @keyframes fnd-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      {/* pointer triangle drawn in SVG space so it lines up exactly with the anchor port */}
      <svg width={0} height={0}>
        <defs />
      </svg>
    </foreignObject>
  );
}

function ModalPointer({ anchorY, modalLeftX }) {
  const modalY = Math.max(30, anchorY - 70);
  const pointerY = Math.min(Math.max(anchorY, modalY + 20), modalY + 160);
  return (
    <path
      d={`M ${modalLeftX} ${pointerY - 10} L ${modalLeftX - 14} ${pointerY} L ${modalLeftX} ${pointerY + 10} Z`}
      fill="#ffffff"
      stroke="#dfe6ea"
      strokeWidth={1}
    />
  );
}

// ---------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------
function Legend() {
  const items = [
    { label: "Input", color: TRUNK_COLOR, dashed: false },
    { label: "Splitter", color: "#1c2a33", dashed: false },
    { label: "Output", color: "#59c9c6", dashed: false },
  ];
  const x = 1180;
  const y = 690;
  return (
    <g>
      <rect x={x} y={y} width={175} height={96} rx={8} fill="#ffffff" stroke="#dfe6ea" />
      {items.map((it, i) => (
        <g key={it.label} transform={`translate(${x + 18}, ${y + 26 + i * 27})`}>
          <line x1={0} y1={0} x2={26} y2={0} stroke={it.color} strokeWidth={4} strokeLinecap="round" />
          <text x={36} y={4} className="fnd-legend-text">
            {it.label}
          </text>
        </g>
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------
// Top level: FiberDistributor
// ---------------------------------------------------------------------
export default function FiberDistributor({ enclosureId, onBack }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  const [activeSplitterIndex, setActiveSplitterIndex] = useState(null);

  const load = useCallback(() => {
    setStatus("loading");
    setErrorMsg("");
    api
      .getVisualization(enclosureId)
      .then((json) => {
        setData(json);
        setStatus("ready");
      })
      .catch((err) => {
        setErrorMsg(err.message || "Unknown error");
        setStatus("error");
      });
  }, [enclosureId]);

  useEffect(() => {
    load();
  }, [load]);

  const centerY =
    data && data.connections && data.connections.length
      ? rowY((data.connections.length - 1) / 2)
      : CENTER_Y_FALLBACK;

  const activeSplitter =
    data && activeSplitterIndex !== null
      ? data.splitters.find((s) => s.sourceCoreIndex === activeSplitterIndex)
      : null;

  return (
    <div
      style={{
        width: "100%",
        minHeight: 560,
        background: "#e4e8ea",
        borderRadius: 12,
        padding: "20px 16px",
        boxSizing: "border-box",
        fontFamily: "'Segoe UI', Inter, system-ui, sans-serif",
      }}
    >
      <style>{`
        .fnd-title { font-size: 30px; letter-spacing: 2px; fill: #1c2a33; font-weight: 500; }
        .fnd-label { font-size: 15px; fill: #1c2a33; }
        .fnd-cable-label { font-size: 15px; fill: #1c2a33; }
        .fnd-legend-text { font-size: 13.5px; fill: #1c2a33; }
        .fnd-toolbar-btn {
          display: inline-flex; align-items: center; gap: 6px;
          font-size: 13px; padding: 6px 12px; border-radius: 6px;
          border: 1px solid #cfd8dc; background: #ffffff; color: #1c2a33;
          cursor: pointer;
        }
        .fnd-toolbar-btn:hover { background: #f2f5f6; }
      `}</style>

      {/* toolbar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <p className="section-title" style={{ margin: 0 }}>{data?.deviceId || "Loading..."} — box documentation</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="fnd-toolbar-btn" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="btn" onClick={onBack} style={{ padding: "4px 12px", fontSize: 12 }}>
            Back to text
          </button>
        </div>
      </div>

      {status === "loading" && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 500, gap: 10, color: "#57646b" }}>
          <Loader2 size={22} className="fnd-spin" style={{ animation: "fnd-spin 900ms linear infinite" }} />
          <span style={{ fontSize: 15 }}>Loading distributor data…</span>
          <style>{`@keyframes fnd-spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {status === "error" && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: 500,
            gap: 10,
            color: "#8a3b2b",
          }}
        >
          <AlertTriangle size={26} />
          <div style={{ fontSize: 15, fontWeight: 600 }}>Couldn't load fiber distributor data</div>
          <div style={{ fontSize: 13, color: "#57646b" }}>{errorMsg}</div>
          <button className="fnd-toolbar-btn" onClick={load}>
            Try again
          </button>
        </div>
      )}

      {status === "ready" && data && (
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width="100%" style={{ display: "block" }}>
          <text x={VB_W / 2} y={56} textAnchor="middle" className="fnd-title">
            FIBER NETWORK DISTRIBUTOR
          </text>
          <text x={VB_W - 40} y={30} textAnchor="end" style={{ fontSize: 12, fill: "#8a97a0" }}>
            {data.deviceId}
          </text>

          {/* input trunk */}
          <line x1={30} y1={centerY} x2={BOX_X} y2={centerY} stroke={TRUNK_COLOR} strokeWidth={8} strokeLinecap="round" />
          <text x={30} y={centerY + 34} className="fnd-cable-label">
            INPUT: {data.inputCableName}
          </text>

          <OpticalEnclosure
            connections={data.connections}
            splitters={data.splitters}
            activeSplitterIndex={activeSplitterIndex}
            setActiveSplitterIndex={setActiveSplitterIndex}
          />

          {/* output trunk */}
          <line x1={CONVERGE_X} y1={centerY} x2={VB_W - 30} y2={centerY} stroke={TRUNK_COLOR} strokeWidth={8} strokeLinecap="round" />
          <text x={CONVERGE_X + 20} y={centerY + 34} className="fnd-cable-label">
            OUTPUT: {data.outputCableName}
          </text>

          <Legend />

          {activeSplitter && (
            <>
              <SplitterDetailModal splitter={activeSplitter} anchorY={rowY(activeSplitter.sourceCoreIndex)} />
              <ModalPointer anchorY={rowY(activeSplitter.sourceCoreIndex)} modalLeftX={RIGHT_PORT_X + 55} />
            </>
          )}
        </svg>
      )}
    </div>
  );
}