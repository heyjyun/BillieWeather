// The in-app welcome shown once to a newly registered account after it signs in (see
// services/onboarding.ts for when). One shared page for macOS, Windows, iOS and Android.
//
// It only explains and navigates: it reads no financial data, writes nothing to SQLite, makes no
// network or AI call, and starts no import or sync. It is unrelated to the welcome *email*.
import { icons } from "@billie/design-tokens";
import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { BrandMark } from "../components/BrandMark";

const STEPS = [
  { id: "import", icon: icons.upload },
  { id: "organize", icon: icons.insights },
  { id: "forecast", icon: icons.forecast },
] as const;

const ARROW = "M5 12h14 M13 6l6 6-6 6";

function Glyph({ d, size = 22 }: { d: string; size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

export function Welcome({ name, onStart, onExplore }: { name?: string | null; onStart: () => void; onExplore: () => void }) {
  const { m, t } = useI18n();
  const w = m.welcome;
  const heading = useRef<HTMLHeadingElement>(null);
  // Screen readers and keyboard users start at the headline, as on a newly opened screen.
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  const display = name?.trim();

  return (
    <main className="bw-welcome" aria-labelledby="bw-welcome-title">
      <div className="bw-welcome-inner">
        <section className="bw-welcome-hero">
          <span className="bw-welcome-glow" aria-hidden="true" />
          <div className="bw-welcome-brand"><BrandMark /><span>BillieWeather</span></div>
          <p className="bw-welcome-greeting">{display ? t("welcome.greeting", { name: display }) : w.ready}</p>
          <h1 id="bw-welcome-title" ref={heading} tabIndex={-1}>{w.title}</h1>
          <p className="bw-welcome-subtitle">{w.subtitle}</p>
        </section>

        <ol className="bw-welcome-steps" aria-label={w.stepsLabel}>
          {STEPS.map((step, index) => (
            <li key={step.id} className="bw-welcome-step" style={{ animationDelay: `${120 + index * 80}ms` }}>
              <span className="bw-welcome-step-icon"><Glyph d={step.icon} /></span>
              <div>
                <span className="bw-welcome-step-number">{t("welcome.step", { n: index + 1 })}</span>
                <h2>{w.steps[step.id].title}</h2>
                <p>{w.steps[step.id].body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="bw-welcome-actions">
          <button type="button" className="bw-button bw-button-dark bw-welcome-start" onClick={onStart}>
            <span>{w.start}</span><Glyph d={ARROW} size={18} />
          </button>
          <button type="button" className="bw-button bw-button-outline bw-welcome-explore" onClick={onExplore}>{w.explore}</button>
        </div>

        <p className="bw-welcome-privacy"><Glyph d={icons.lock} size={16} /><span>{w.privacy}</span></p>
      </div>
    </main>
  );
}
