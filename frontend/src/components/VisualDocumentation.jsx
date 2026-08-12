import React, { useMemo } from "react";

/**
 * Box wiring diagram — the visual view of an enclosure's documentation.
 *
 * Fed by GET /enclosures/:id/documentation (already loaded by the parent
 * panel) and drawn entirely from real data:
 *   left column  – cables arriving INTO this box
 *   center       – the box itself, with splice curves crossing it
 *   right column – cables leaving this box
 *   splitters    – diamond nodes fanning one input core out to N ports
 *
 * Core dots: fill = live status, ring = standard fiber color code. Everything
 * uses CSS theme variables so it follows the dark/light theme.
 */

// Standard 12-fiber color code (same sequence as the text view's FiberColorDot)
const FIBER_COLORS = [
  "#3b82f6", "#f59e0b", "#22c55e", "#a16207", "#94a3b8", "#e2e8f0",
  "#ef4444", "#1f2937", "#eab308", "#8b5cf6", "#f472b6", "#22d3ee",
];

const STATUS_COLORS = {
  available: "var(--amber)",
  spliced: "var(--teal)",
  terminated: "var(--violet)",
  reserved: "#8b96a8",
  damaged: "var(--red)",
};

const STATUS_ORDER = ["available", "spliced", "terminated", "reserved", "damaged"];

// Layout constants (SVG user units)
const CARD_W = 176;
const CARD_PAD = 10;
const HEADER_H = 20;
const DOT_R = 6.5;
const DOT_DX = 25;
const DOT_DY = 21;
const DOT_COLS = 6;
const LEFT_X = 16;
const RIGHT_X = 560;
const BOX_X = 330;
const VB_W = 760;
const TOP_Y = 54;

function cardHeight(coreCount) {
  const rows = Math.max(1, Math.ceil(coreCount / DOT_COLS));
  return HEADER_H + 12 + rows * DOT_DY + CARD_PAD - 6;
}

function statusCountsOf(cores) {
  const counts = {};
  for (const c of cores) counts[c.status] = (counts[c.status] || 0) + 1;
  return counts;
}

/** Lay out one column of cable cards; fills posByCoreId with dot positions. */
function layoutColumn(groups, x, posByCoreId, side) {
  const cards = [];
  let y = TOP_Y;
  for (const g of groups) {
    const cores = [...g.cores].sort((a, b) => a.core_number - b.core_number);
    const h = cardHeight(cores.length);
    const card = { group: g, x, y, h, cores };
    cores.forEach((core, i) => {
      const col = i % DOT_COLS;
      const row = Math.floor(i / DOT_COLS);
      posByCoreId.set(core.id, {
        x: x + CARD_PAD + DOT_R + col * DOT_DX,
        y: y + HEADER_H + 12 + DOT_R + row * DOT_DY,
        side,
        core,
        card,
      });
    });
    cards.push(card);
    y += h + 12;
  }
  return { cards, bottom: y };
}

function bezier(x1, y1, x2, y2) {
  const dx = Math.max(60, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export default function VisualDocumentation({ doc, onBack, onChanged }) {
  const layout = useMemo(() => {
    if (!doc) return null;
    const groups = doc.cables_landing_here || [];
    const inGroups = groups.filter((g) => g.direction === "in");
    const outGroups = groups.filter((g) => g.direction === "out");

    const posByCoreId = new Map();
    const left = layoutColumn(inGroups, LEFT_X, posByCoreId, "in");
    const right = layoutColumn(outGroups, RIGHT_X, posByCoreId, "out");

    const colBottom = Math.max(left.bottom, right.bottom);
    const splitterCount = (doc.splitters || []).length;
    // Box must be tall enough for the splitter diamonds even when cable
    // columns are short.
    const boxH = Math.max(150, colBottom - TOP_Y - 12, 70 + splitterCount * 62 + 16);
    const box = { x: BOX_X, y: TOP_Y, w: VB_W - RIGHT_X - BOX_X - 24, h: boxH };
    const height = Math.max(colBottom, TOP_Y + boxH) + 96;

    // Splitter diamond positions: stacked under the box title inside the box
    const splitters = (doc.splitters || []).map((s, i) => ({
      ...s,
      cx: box.x + box.w / 2,
      cy: box.y + 70 + i * 62,
    }));

    return { left, right, box, height, posByCoreId, splitters };
  }, [doc]);

  if (!doc) {
    return <p className="loading-row">Loading visual documentation…</p>;
  }

  const { enclosure, summary } = doc;
  const noCables = (doc.cables_landing_here || []).length === 0;

  return (
    <div className="vdoc">
      <style>{`
        .vdoc { font-family: inherit; }
        .vdoc-card { fill: var(--surface-raised); stroke: var(--border); }
        .vdoc-cable-code { fill: var(--teal); font: 600 10.5px var(--font-mono, monospace); }
        .vdoc-cable-sub { fill: var(--text-faint); font: 9.5px var(--font-mono, monospace); }
        .vdoc-box { fill: var(--surface); stroke: var(--border); }
        .vdoc-box-title { fill: var(--text); font: 600 12px var(--font-mono, monospace); }
        .vdoc-box-sub { fill: var(--text-muted); font: 10px var(--font-mono, monospace); }
        .vdoc-col-title { fill: var(--text-faint); font: 600 10px var(--font-mono, monospace); letter-spacing: 1px; }
        .vdoc-splice { fill: none; stroke-width: 1.8; opacity: 0.9; }
        .vdoc-splitter { fill: var(--surface-raised); stroke: var(--text-muted); }
        .vdoc-splitter-label { fill: var(--text-muted); font: 8.5px var(--font-mono, monospace); }
        .vdoc-legend-text { fill: var(--text-muted); font: 10px var(--font-mono, monospace); }
        .vdoc-empty { fill: var(--text-faint); font: 11px var(--font-mono, monospace); }
        .vdoc-summary { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 10px; }
      `}</style>

      {/* Summary strip (HTML so it can reuse the chip styles) */}
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

      <svg
        viewBox={`0 0 ${VB_W} ${layout.height}`}
        width="100%"
        style={{ display: "block" }}
        role="img"
        aria-label={`Wiring diagram for ${enclosure.code}`}
      >
        {/* Column titles */}
        <text x={LEFT_X} y={TOP_Y - 28} className="vdoc-col-title">IN ▸ from upstream</text>
        <text x={RIGHT_X} y={TOP_Y - 28} className="vdoc-col-title">OUT ▸ to downstream</text>

        {/* The box itself */}
        <rect
          x={layout.box.x}
          y={layout.box.y}
          width={layout.box.w}
          height={layout.box.h}
          rx={10}
          className="vdoc-box"
        />
        <text x={layout.box.x + layout.box.w / 2} y={layout.box.y + 22} textAnchor="middle" className="vdoc-box-title">
          {enclosure.code}
        </text>
        <text x={layout.box.x + layout.box.w / 2} y={layout.box.y + 38} textAnchor="middle" className="vdoc-box-sub">
          {enclosure.type.replace("_", " ")}
        </text>

        {/* Splice curves (drawn first so cable dots sit on top) */}
        {(doc.splices || []).map((s) => {
          const a = layout.posByCoreId.get(s.core_a_id);
          const b = layout.posByCoreId.get(s.core_b_id);
          if (!a || !b) return null;
          return (
            <path
              key={s.id}
              d={bezier(a.x, a.y, b.x, b.y)}
              className="vdoc-splice"
              style={{ stroke: "var(--teal)" }}
              strokeDasharray={s.splice_type === "mechanical" ? "5 4" : "none"}
            >
              <title>
                {s.cable_a_code}#{s.core_a_number} ⇄ {s.cable_b_code}#{s.core_b_number}
                {s.tray_number ? ` · tray ${s.tray_number}` : ""}
                {s.splice_type ? ` · ${s.splice_type}` : ""}
              </title>
            </path>
          );
        })}

        {/* Splitter diamonds + fan-out */}
        {layout.splitters.map((sp) => {
          const input = layout.posByCoreId.get(sp.input_core_id);
          const d = 11;
          return (
            <g key={sp.id}>
              {input && (
                <path
                  d={bezier(input.x, input.y, sp.cx - d, sp.cy)}
                  className="vdoc-splice"
                  style={{ stroke: "var(--violet)" }}
                />
              )}
              <rect
                x={sp.cx - d}
                y={sp.cy - d}
                width={d * 2}
                height={d * 2}
                rx={3}
                className="vdoc-splitter"
                transform={`rotate(45 ${sp.cx} ${sp.cy})`}
              >
                <title>{sp.name || `1:${sp.split_count} splitter`}</title>
              </rect>
              <text x={sp.cx} y={sp.cy + d + 10} textAnchor="middle" className="vdoc-splitter-label">
                1:{sp.split_count}
              </text>
              {(sp.ports || []).map((p) => {
                const out = p.core_id && layout.posByCoreId.get(p.core_id);
                if (!out) return null;
                return (
                  <path
                    key={p.port_number}
                    d={bezier(sp.cx + d, sp.cy, out.x, out.y)}
                    className="vdoc-splice"
                    style={{ stroke: "var(--violet)" }}
                  >
                    <title>Port {p.port_number} → {p.cable_code || "?"}#{p.core_number}</title>
                  </path>
                );
              })}
            </g>
          );
        })}

        {/* Cable cards */}
        {[...layout.left.cards, ...layout.right.cards].map((card) => (
          <g key={card.group.cable.id}>
            <rect x={card.x} y={card.y} width={CARD_W} height={card.h} rx={7} className="vdoc-card" />
            <text x={card.x + CARD_PAD} y={card.y + 14} className="vdoc-cable-code">
              {card.group.cable.code}
            </text>
            <text x={card.x + CARD_W - CARD_PAD} y={card.y + 14} textAnchor="end" className="vdoc-cable-sub">
              {card.group.cable.cores.length}/{card.group.cable.core_count}
            </text>
            <text x={card.x + CARD_PAD} y={card.y + HEADER_H + 4} className="vdoc-cable-sub">
              {card.group.cable.cable_type}
              {card.group.cable.customer_label ? ` · ${card.group.cable.customer_label}` : ""}
            </text>
            {card.cores.map((core) => {
              const pos = layout.posByCoreId.get(core.id);
              return (
                <circle
                  key={core.id}
                  cx={pos.x}
                  cy={pos.y}
                  r={DOT_R}
                  style={{
                    fill: STATUS_COLORS[core.status] || "var(--text-muted)",
                    stroke: FIBER_COLORS[(core.core_number - 1) % 12],
                    strokeWidth: 1.6,
                  }}
                >
                  <title>
                    {card.group.cable.code} · core #{core.core_number} · {core.status}
                  </title>
                </circle>
              );
            })}
          </g>
        ))}

        {noCables && (
          <>
            <text x={LEFT_X + CARD_W / 2} y={TOP_Y + 30} textAnchor="middle" className="vdoc-empty">
              no cables in
            </text>
            <text x={RIGHT_X + CARD_W / 2} y={TOP_Y + 30} textAnchor="middle" className="vdoc-empty">
              no cables out
            </text>
          </>
        )}

        {/* Legend */}
        <g transform={`translate(${LEFT_X}, ${layout.height - 66})`}>
          <text x={0} y={8} className="vdoc-col-title">STATUS</text>
          {STATUS_ORDER.map((s, i) => (
            <g key={s} transform={`translate(${i * 128}, 16)`}>
              <circle cx={6} cy={0} r={5.5} style={{ fill: STATUS_COLORS[s] }} />
              <text x={17} y={3.5} className="vdoc-legend-text">
                {s}
              </text>
            </g>
          ))}
          <g transform="translate(0, 40)">
            <line x1={0} y1={0} x2={18} y2={0} style={{ stroke: "var(--teal)" }} strokeWidth={1.8} />
            <text x={24} y={3.5} className="vdoc-legend-text">fusion splice</text>
            <line x1={112} y1={0} x2={130} y2={0} style={{ stroke: "var(--teal)" }} strokeWidth={1.8} strokeDasharray="4 3" />
            <text x={136} y={3.5} className="vdoc-legend-text">mechanical</text>
            <rect x={238} y={-5} width={10} height={10} rx={2} className="vdoc-splitter" transform="rotate(45 243 0)" />
            <text x={258} y={3.5} className="vdoc-legend-text">splitter</text>
            <text x={330} y={3.5} className="vdoc-legend-text">dot ring = fiber color code · hover dots/wires for details</text>
          </g>
        </g>
      </svg>
    </div>
  );
}
