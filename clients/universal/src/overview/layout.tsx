import { useState } from "react";
import messages from "./messages.json";
import { widgets, metrics, type Widget, type Metric } from "./model";

export type Copy = typeof messages.en;
interface Layout {
  order: Widget[];
  hidden: Widget[];
  wide: Widget[];
  cards: Metric[];
}
const defaults = (): Layout => ({ order: [...widgets], hidden: [], wide: ["trend"], cards: metrics.slice(0, 4) });
function valid<T extends string>(input: unknown, choices: readonly T[], fallback: T[]): T[] {
  return Array.isArray(input) ? [...new Set(input.filter((v): v is T => choices.includes(v)))] : fallback;
}
function read(key: string): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!v || v.version !== 1) return defaults();
    const order = valid(v.order, widgets, []);
    return {
      order: [...order, ...widgets.filter((id) => !order.includes(id))],
      hidden: valid(v.hidden, widgets, []),
      cards: valid(v.cards, metrics, defaults().cards),
      wide: valid(v.wide, widgets, ["trend"]),
    };
  } catch {
    return defaults();
  }
}
export function useLayout(owner: string) {
  const key = "billie.overview.layout.v1:" + encodeURIComponent(owner);
  const [layout, setLayout] = useState(() => read(key));
  const [failed, setFailed] = useState(false);
  function save(next: Layout) {
    setLayout(next);
    try {
      localStorage.setItem(key, JSON.stringify({ ...next, version: 1 }));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  return { layout, save, failed };
}
const toggle = <T,>(items: T[], id: T) => (items.includes(id) ? items.filter((i) => i !== id) : [...items, id]);
export function Editor({
  c,
  layout,
  save,
  close,
}: {
  c: Copy;
  layout: Layout;
  save: (v: Layout) => void;
  close: () => void;
}) {
  const [drag, setDrag] = useState<Widget | null>(null);
  function move(id: Widget, index: number) {
    if (index < 0 || index >= layout.order.length) return;
    const order = layout.order.filter((v) => v !== id);
    order.splice(index, 0, id);
    save({ ...layout, order });
  }
  return (
    <section className="fo-editor" id="overview-editor" aria-label={c.customize}>
      <fieldset>
        <legend>{c.metricList}</legend>
        <div className="fo-checks">
          {metrics.map((id) => (
            <label key={id}>
              <input
                type="checkbox"
                checked={layout.cards.includes(id)}
                onChange={() => save({ ...layout, cards: toggle(layout.cards, id) })}
              />
              {c[id]}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{c.widgetList}</legend>
        {layout.order.map((id, index) => (
          <div
            className="fo-edit-row"
            key={id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/plain", id);
              setDrag(id);
            }}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (drag) move(drag, index);
              setDrag(null);
            }}
          >
            <span aria-hidden="true" className="fo-grip">
              ⠿
            </span>
            <label>
              <input
                type="checkbox"
                checked={!layout.hidden.includes(id)}
                onChange={() => save({ ...layout, hidden: toggle(layout.hidden, id) })}
              />
              {c[id]}
            </label>
            <select
              aria-label={c.width + " · " + c[id]}
              value={layout.wide.includes(id) ? "full" : "half"}
              onChange={() => save({ ...layout, wide: toggle(layout.wide, id) })}
            >
              <option value="half">{c.half}</option>
              <option value="full">{c.full}</option>
            </select>
            <button disabled={!index} aria-label={c.up + " · " + c[id]} onClick={() => move(id, index - 1)}>
              ↑
            </button>
            <button
              disabled={index === layout.order.length - 1}
              aria-label={c.down + " · " + c[id]}
              onClick={() => move(id, index + 1)}
            >
              ↓
            </button>
          </div>
        ))}
      </fieldset>
      <footer>
        <button onClick={() => save(defaults())}>{c.restore}</button>
        <button onClick={close}>{c.done}</button>
      </footer>
    </section>
  );
}
