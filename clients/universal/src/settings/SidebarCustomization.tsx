// Settings › Sidebar customization: the sidebar entries in the person's order (drag them, or use the
// arrow buttons, which also work from the keyboard), a way to hide each one or add any other
// available module, and Restore defaults. Only navigation changes: a hidden module keeps working and
// stays reachable from Settings and the Feature Library; no financial record is touched. Settings is
// fixed at the bottom and cannot be moved or hidden. Order and visibility are saved per account and
// synchronized (hooks/useModules.tsx, services/moduleSync.ts). The website has the same section
// (app/views/finance/feature_library/_sidebar_customization.html.erb).
import { useRef, useState, type DragEvent } from "react";
import { ModuleIcon } from "../components/ModuleIcon";
import { useModules } from "../hooks/useModules";
import { useI18n } from "../i18n";
import type { SectionProps } from "./registry";

export function SidebarCustomizationSection(_props: SectionProps) {
  const { m, t } = useI18n();
  const x = m.modules;
  const { sidebarList, hiddenList, setSidebarOrder, setSidebarVisible, restoreSidebarDefaults, conflicts } = useModules();
  const [status, setStatus] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  // Where the dragged entry would land, shown as a line on that entry. The list itself is not
  // rearranged during the drag: moving DOM nodes under the pointer makes browsers cancel the drop.
  const [marker, setMarker] = useState<{ id: string; before: boolean } | null>(null);
  // Refs as well as state: a browser sends the first dragenter/dragover before React re-renders after
  // dragstart, and an event that is not prevented means the drop never comes.
  const dragRef = useRef<string | null>(null);
  const markerRef = useRef<{ id: string; before: boolean } | null>(null);
  const entries = sidebarList;
  const save = (order: string[]) => {
    setSidebarOrder(order);
    setStatus(x.sidebar.saved);
  };
  const move = (id: string, step: -1 | 1) => {
    const order = entries.map((module) => module.id as string);
    const from = order.indexOf(id);
    const to = from + step;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    save(order);
  };
  const endDrag = () => {
    dragRef.current = null;
    markerRef.current = null;
    setMarker(null);
    setDragging(null);
  };
  const dragOver = (event: DragEvent<HTMLLIElement>, id: string) => {
    const moving = dragRef.current;
    if (!moving) return;
    event.preventDefault(); // allows the drop, also over the entry being moved
    const box = event.currentTarget.getBoundingClientRect();
    const next = { id, before: event.clientY < box.top + box.height / 2 };
    if (markerRef.current?.id !== next.id || markerRef.current.before !== next.before) {
      markerRef.current = next;
      setMarker(next);
    }
  };
  const drop = (event: DragEvent<HTMLLIElement>) => {
    event.preventDefault();
    const moving = dragRef.current;
    const target = markerRef.current;
    if (moving && target && target.id !== moving) {
      const order = entries.map((module) => module.id as string).filter((id) => id !== moving);
      order.splice(order.indexOf(target.id) + (target.before ? 0 : 1), 0, moving);
      save(order);
    }
    endDrag();
  };

  return (
    <section className="bw-panel bw-sidebar-customization" id="settings-sidebar" aria-labelledby="sidebar-customization-title" data-sidebar-customization>
      <h2 id="sidebar-customization-title">{x.sidebar.title}</h2>
      <p className="bw-muted">{x.sidebar.intro}</p>
      <p className="bw-sr-status" role="status" aria-live="polite">{status}</p>
      <ol className="bw-sidebar-order" aria-describedby="sidebar-order-help" data-sidebar-order>
        {entries.map((module, index) => {
          const name = x.names[module.id];
          return (
            <li key={module.id} className={`bw-sidebar-order-item${dragging === module.id ? " is-dragging" : ""}${marker?.id === module.id && dragging !== module.id ? (marker.before ? " is-drop-before" : " is-drop-after") : ""}`} draggable data-module-key={module.id}
              onDragStart={(event) => { dragRef.current = module.id; setDragging(module.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", module.id); }}
              onDragEnter={(event) => { if (dragRef.current) event.preventDefault(); }}
              onDragOver={(event) => dragOver(event, module.id)} onDrop={drop} onDragEnd={endDrag}>
              <span className="bw-drag-handle" aria-hidden="true" title={x.sidebar.drag}><ModuleIcon name="grip" size={16} /></span>
              <span className="bw-sidebar-order-name"><ModuleIcon name={module.icon} size={18} /> {name}</span>
              <span className="bw-sidebar-order-actions">
                <button type="button" className="bw-icon-button" disabled={index === 0} aria-label={t("modules.sidebar.move_up", { name })} title={t("modules.sidebar.move_up", { name })} onClick={() => move(module.id, -1)}>↑</button>
                <button type="button" className="bw-icon-button" disabled={index === entries.length - 1} aria-label={t("modules.sidebar.move_down", { name })} title={t("modules.sidebar.move_down", { name })} onClick={() => move(module.id, 1)}>↓</button>
                <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={!!conflicts[module.id]} aria-label={t("modules.sidebar.hide_label", { name })}
                  onClick={() => { setSidebarVisible(module.id, false); setStatus(t("modules.library.savedHidden", { name })); }}>{x.sidebar.hide}</button>
              </span>
            </li>
          );
        })}
        <li className="bw-sidebar-order-item is-fixed" data-module-key="settings">
          <span className="bw-drag-handle" aria-hidden="true"><ModuleIcon name="lock" size={16} /></span>
          <span className="bw-sidebar-order-name"><ModuleIcon name="settings" size={18} /> {x.nav.settings}</span>
          <span className="bw-caption">{x.sidebar.settings_fixed}</span>
        </li>
      </ol>
      <p className="bw-caption" id="sidebar-order-help">{x.sidebar.help}</p>
      <h3>{x.sidebar.add_heading}</h3>
      {hiddenList.length === 0 ? <p className="bw-muted">{x.sidebar.nothing_to_add}</p> : (
        <ul className="bw-sidebar-add" data-sidebar-add>
          {hiddenList.map((module) => {
            const name = x.names[module.id];
            return (
              <li key={module.id} data-module-key={module.id}>
                <span className="bw-sidebar-order-name"><ModuleIcon name={module.icon} size={18} /> {name}</span>
                <button type="button" className="bw-button bw-button-outline bw-button-small" disabled={!!conflicts[module.id]} aria-label={t("modules.sidebar.add_label", { name })}
                  onClick={() => { setSidebarVisible(module.id, true); setStatus(t("modules.library.savedShown", { name })); }}>{x.sidebar.add}</button>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="bw-button bw-button-outline bw-feature-reset" onClick={() => { restoreSidebarDefaults(); setStatus(x.library.resetSaved); }}>{x.library.reset}</button>
    </section>
  );
}
