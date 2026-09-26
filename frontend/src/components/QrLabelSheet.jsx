import React, { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { qrSvgUrl, qrLink } from "../api";
import { buildDeepLink } from "../utils/deepLink.js";
import { labelCaption as captionFor } from "../utils/worksheet.js";

/**
 * The QR sticker for a pole, box or cable — shown so it can be printed and stuck
 * on the thing it names.
 *
 * The code carries a deep link to *this* deployment, built from the browser's own
 * origin because that is the only base URL that is certainly right (in
 * development the app is on :5173 while the API is on :4000). The SVG is made by
 * the API — `GET /api/qr.svg?data=…` — so the sticker and the app can never
 * disagree about how a link looks.
 */
export default function QrLabelSheet({ kind, id, label, onClose }) {
  const [copies, setCopies] = useState(6);
  const [showLink, setShowLink] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  // What the sticker will say when scanned. Null only if the kind is unknown.
  const link = useMemo(() => {
    try {
      return buildDeepLink(kind, id, window.location.origin);
    } catch {
      return null;
    }
  }, [kind, id]);

  const caption = captionFor(kind, label || id);
  const svgUrl = link ? qrSvgUrl(link, { scale: 10, ec: "M" }) : null;
  const scanUrl = useMemo(() => qrLink(kind, id, { base: typeof window !== "undefined" ? window.location.origin : "" }), [kind, id]);

  // Rendered into <body>: the panel this button lives in is hidden when
  // printing, and the sticker sheet has to survive that (and the panel's
  // scrolling) to reach paper.
  const portal = (child) => createPortal(child, document.body);

  if (!link) {
    return portal(
      <div className="sheet-overlay" role="dialog" aria-label="QR tag">
        <div className="sheet-panel">
          <p className="error-row">This selection cannot carry a QR tag.</p>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>,
    );
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setShowLink(true); // clipboard refused (http, or a policy): show it to copy
    }
  };

  const downloadSvg = async () => {
    try {
      const res = await fetch(svgUrl);
      if (!res.ok) throw new Error(`The QR code could not be generated (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${caption.replace(/[^A-Za-z0-9._-]+/g, "-")}.svg`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    }
  };

  return portal(
    <div className="sheet-overlay" role="dialog" aria-label={`QR tag for ${caption}`}>
      <div className="sheet-panel">
        <div className="sheet-toolbar no-print">
          <span className="sheet-title">QR tag — {caption}</span>
          <label className="sheet-field">
            Labels
            <select value={copies} onChange={(e) => setCopies(Number(e.target.value))}>
              {[1, 2, 4, 6, 8, 12, 24].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={() => window.print()}>Print</button>
          <button className="btn" onClick={downloadSvg}>Download SVG</button>
          <button className="btn" onClick={copyLink}>{copied ? "Copied" : "Copy link"}</button>
          <button className="btn" onClick={() => setShowLink((v) => !v)}>
            {showLink ? "Hide link" : "Show link"}
          </button>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {error && <p className="error-row no-print">{error}</p>}

        {showLink && (
          <p className="sheet-link no-print">
            <code>{link}</code>
          </p>
        )}

        {/* The printable part: label cards, sized to be cut and stuck on. */}
        <div className="qr-labels print-area">
          {Array.from({ length: copies }, (_, index) => (
            <div className="qr-label" key={index}>
              <img src={svgUrl} alt={`QR code for ${caption}`} width="132" height="132" />
              <div className="qr-label-text">
                <strong>{caption}</strong>
                <span className="qr-label-kind">{scanUrl?.kind || kind}</span>
                <span className="qr-label-hint">Scan for documentation</span>
              </div>
            </div>
          ))}
        </div>
        <p className="sheet-footnote no-print">
          The sticker opens this box's documentation in the app — {link}
        </p>
      </div>
    </div>,
  );
}
