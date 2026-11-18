// The dashboard's personal header: "Good morning, Jyun!" with a calm line for the context.
// The same messages and rules as the website dashboard (app/models/personalization.rb).
import { icons } from "@billie/design-tokens";
import { useEffect, useState, type ReactNode } from "react";
import { usePersonal } from "../hooks/usePersonal";
import { dayPart, type DayPart } from "../services/greeting";

const GLYPH: Record<DayPart, string> = { morning: icons.sun, afternoon: icons.cloudSun, evening: icons.moon };

/** The part of the day, re-checked every few minutes so an app left open stays in step with the clock. */
export function useDayPart(): DayPart {
  const [part, setPart] = useState(() => dayPart());
  useEffect(() => {
    const timer = setInterval(() => setPart(dayPart()), 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
  return part;
}

export function GreetingHeader({ eyebrow, hasData, needsAttention, children }: { eyebrow: string; hasData: boolean; needsAttention: boolean; children?: ReactNode }) {
  const { p, say } = usePersonal();
  const part = useDayPart();
  // The greeting already says the name, so the line under it never repeats it.
  const subtitle = !hasData ? p.dashboard.first_use.plain : needsAttention ? p.dashboard.attention : p.dashboard[part];
  return (
    <header className="bw-page-heading bw-greeting-heading">
      <div>
        <span className="bw-eyebrow">{eyebrow}</span>
        <h1 className="bw-greeting" data-day-part={part}>
          <span className={`bw-greeting-glyph bw-greeting-${part}`} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={GLYPH[part]} /></svg>
          </span>
          <span>{say(p.greeting[part])}</span>
        </h1>
        <p className="bw-greeting-subtitle">{subtitle}</p>
      </div>
      {children}
    </header>
  );
}
