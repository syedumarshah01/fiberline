import React, { useEffect, useRef, useState } from "react";

/**
 * A dropdown for picking a fiber core (or splitter port) in the splice form.
 *
 * It replaces the native <select> for one reason: native <option> elements
 * don't fire per-option hover events, and the form must highlight the cable of
 * the core currently being hovered on the map. This listbox fires
 * onHoverCable(cableId) / onHoverCable(null) as the pointer moves over options.
 *
 * Props:
 *   value        — currently selected option value ("" for none)
 *   onChange     — (value) => void
 *   groups       — [{ label, options: [{ value, label, coreNumber?, cableId? }] }]
 *   placeholder  — text when nothing is selected
 *   onHoverCable — (cableId | null) => void
 *
 * The dropdown panel is position:fixed (anchored to the button) so it isn't
 * clipped by the scrollable right panel.
 */
export default function CorePicker({ value, onChange, groups, placeholder = "Select…", onHoverCable }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const rootRef = useRef(null);
  const listRef = useRef(null);

  const allOptions = groups.flatMap((g) => g.options);
  const selected = allOptions.find((o) => o.value === value);

  const close = () => {
    setOpen(false);
    onHoverCable?.(null);
  };

  // Close on outside click; reposition-or-close on scroll/resize (scroll would
  // leave the fixed panel detached from the button, so we simply close).
  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e) {
      if (rootRef.current?.contains(e.target)) return;
      if (listRef.current?.contains(e.target)) return;
      close();
    }
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    // Scroll detaches the fixed panel from its button, so close — but NOT when
    // what scrolled is the option list itself (captured scrolls include it).
    function onScroll(e) {
      if (listRef.current && listRef.current.contains(e.target)) return;
      close();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function toggle() {
    if (!open && rootRef.current) {
      const r = rootRef.current.getBoundingClientRect();
      // Keep the list on-screen vertically: upward if there is more room above.
      const spaceBelow = window.innerHeight - r.bottom;
      const maxHeight = Math.min(260, Math.max(140, spaceBelow - 12));
      setRect({ left: r.left, top: r.bottom + 4, width: r.width, maxHeight });
    }
    setOpen((o) => !o);
  }

  function pick(option) {
    onChange(option.value);
    close();
  }

  return (
    <div className="core-picker" ref={rootRef}>
      <button
        type="button"
        className={"core-picker-btn" + (open ? " open" : "") + (selected ? "" : " placeholder")}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="core-picker-btn-label">
          {selected ? (
            <>
              {typeof selected.coreNumber === "number" && <FiberChip coreNumber={selected.coreNumber} />}
              {selected.label}
            </>
          ) : (
            placeholder
          )}
        </span>
        <span className="core-picker-caret">{open ? "▴" : "▾"}</span>
      </button>

      {open && rect && (
        <div
          ref={listRef}
          className="core-picker-list"
          role="listbox"
          style={{
            left: rect.left,
            top: rect.top,
            width: rect.width,
            maxHeight: rect.maxHeight,
          }}
        >
          {groups.map((g) =>
            g.options.length === 0 ? null : (
              <div key={g.label} className="core-picker-group">
                <div className="core-picker-group-label">{g.label}</div>
                {g.options.map((o) => (
                  <div
                    key={o.value}
                    role="option"
                    aria-selected={o.value === value}
                    className={"core-picker-option" + (o.value === value ? " selected" : "")}
                    onMouseEnter={() => onHoverCable?.(o.cableId || null)}
                    onClick={() => pick(o)}
                  >
                    {typeof o.coreNumber === "number" && <FiberChip coreNumber={o.coreNumber} />}
                    <span className="core-picker-option-label">{o.label}</span>
                  </div>
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// Standard 12-fiber color code (IEC 60304 sequence, same shades as the
// visual documentation dots)
const FIBER_COLORS = [
  "#3b82f6", "#f59e0b", "#22c55e", "#a16207", "#94a3b8", "#e2e8f0",
  "#ef4444", "#1f2937", "#eab308", "#8b5cf6", "#f472b6", "#22d3ee",
];

/** Small square chip in the standard fiber color — matches the dot colors
 *  used everywhere else (IEC 60304 sequence). */
export function FiberChip({ coreNumber }) {
  const color = FIBER_COLORS[(coreNumber - 1) % 12] || "#808080";
  return (
    <span
      className="fiber-chip"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}
