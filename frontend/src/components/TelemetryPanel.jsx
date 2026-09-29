import React from "react";

const LABELS = {
  healthy: "healthy",
  link_down: "link-down",
  low_signal: "low-signal",
  stale: "stale",
  unknown: "unknown",
};

function ageText(seconds) {
  if (seconds == null) return "age unknown";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default function TelemetryPanel({ telemetry, error }) {
  const summary = telemetry?.summary || {};
  const devices = telemetry?.devices || [];
  return (
    <section className="telemetry-panel">
      <div className="section-title telemetry-title-row">
        <span>Live OLT / ONT telemetry</span>
        {telemetry?.available && <span className="sub">source: {telemetry.source || "external"}</span>}
      </div>
      {!telemetry?.available ? (
        <p className="empty-state telemetry-empty">
          No telemetry feed configured. Manual box impact simulation remains available.
        </p>
      ) : (
        <>
          <div className="telemetry-summary" aria-label="Telemetry summary">
            <span className="telemetry-chip chip-active">{summary.active || 0} active</span>
            <span className="telemetry-chip chip-healthy">{summary.healthy || 0} healthy</span>
            <span className="telemetry-chip chip-link-down">{summary.link_down || 0} link-down</span>
            <span className="telemetry-chip chip-low-signal">{summary.low_signal || 0} low-signal</span>
            <span className="telemetry-chip chip-stale">{summary.stale || 0} stale</span>
          </div>
          {telemetry.correlation?.likely_failure && (
            <div className="telemetry-correlation">
              <b>Likely failure point:</b>{" "}
              {telemetry.correlation.likely_failure.label || telemetry.correlation.likely_failure.id}
              <span className="sub"> · ranked from active device evidence</span>
            </div>
          )}
          <div className="telemetry-device-list">
            {devices.slice(0, 8).map((device) => (
              <div className="telemetry-device" key={`${device.source}:${device.external_id}`}>
                <span className={`telemetry-state telemetry-state-${device.state}`}>
                  {LABELS[device.state] || device.state}
                </span>
                <span className="code">{device.external_id}</span>
                <span className="sub">
                  {device.signal_dbm != null ? `${Number(device.signal_dbm).toFixed(1)} dBm · ` : ""}
                  {ageText(device.age_seconds)}
                </span>
              </div>
            ))}
            {devices.length > 8 && <div className="sub">+{devices.length - 8} more devices</div>}
          </div>
        </>
      )}
      {error && <p className="impact-error telemetry-error">{error}</p>}
    </section>
  );
}
