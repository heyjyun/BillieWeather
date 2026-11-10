// The lightweight region validator: compares the region a person selected with what rule-based
// detection found in the statement (finance-core regionDetect.ts) and, only when it matters,
// shows a non-blocking suggestion or warning. It never changes the selection by itself: every
// change goes through one of its buttons.
import { checkRegion, type RegionDetection, type RegionEvidence, type RegionSource } from "@billie/finance-core";
import { interpolate, useI18n } from "../i18n";

/** Display name of a region code in the interface language (null = Not specified). Never detected from the device. */
export function useRegionName() {
  const { m, locale } = useI18n();
  return (code: string | null | undefined): string => {
    if (!code) return m.universal.region.none;
    const known = (m.universal.region.names as Record<string, string>)[code];
    if (known) return known;
    try {
      return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
}

/** "Bank: Chase · Payment network: Zelle", translated labels with the rule's own name. */
export function useEvidenceText() {
  const { m } = useI18n();
  const region = useRegionName();
  const signals = m.universal.region.signals as Record<string, string>;
  return (items: readonly RegionEvidence[], withRegion = false): string =>
    items.slice(0, 4).map((item) => {
      const label = signals[item.signal] ?? item.signal;
      const text = item.detail ? `${label}: ${item.detail}` : label;
      return withRegion ? `${text} (${region(item.region)})` : text;
    }).join(" · ");
}

export function RegionNotice({ selected, source, detection, busy, onAccept, onKeep }: {
  selected: string | null;
  source: RegionSource | null | undefined;
  detection: RegionDetection | null | undefined;
  busy?: boolean;
  onAccept: (region: string) => void;
  onKeep: () => void;
}) {
  const { m } = useI18n();
  const r = m.universal.region;
  const name = useRegionName();
  const evidenceText = useEvidenceText();
  const check = checkRegion(selected, detection, { keptSelection: source === "user_confirmed" });
  if (!detection || (check.kind !== "suggest" && check.kind !== "conflict")) return null; // Scenarios B and D: nothing to say
  const confidence = (r.confidence as Record<string, string>)[detection.confidence ?? "low"];
  const evidence = detection.evidence.length > 0 ? <small>{interpolate(r.evidence, { list: evidenceText(detection.evidence) })}</small> : null;
  const others = detection.conflictingEvidence.length > 0 ? <small className="bw-muted">{interpolate(r.conflicting, { list: evidenceText(detection.conflictingEvidence, true) })}</small> : null;
  if (check.kind === "suggest") {
    return (
      <div className="bw-message bw-message-ok bw-region-notice" role="status" data-region-check="suggest">
        <span>{interpolate(r.suggest, { region: name(check.detected), confidence })}</span>
        {evidence}{others}
        <span>
          <button type="button" className="bw-button bw-button-small" disabled={busy} onClick={() => onAccept(check.detected)}>{r.useDetected}</button>
        </span>
      </div>
    );
  }
  return (
    <div className="bw-message bw-message-warn bw-region-notice" role="status" data-region-check="conflict">
      <span>{interpolate(r.conflict, { detected: name(check.detected), selected: name(check.selected) })}</span>
      {evidence}{others}
      <span>
        <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={busy} onClick={onKeep}>{r.keepSelection}</button>{" "}
        <button type="button" className="bw-button bw-button-small" disabled={busy} onClick={() => onAccept(check.detected)}>{r.useDetected}</button>
      </span>
    </div>
  );
}
