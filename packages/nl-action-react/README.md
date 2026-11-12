# @nlae/react — command bar for @nlae/core

An accessible, keyboard-driven command bar. It contains no business logic and has no fixed look.

- Suggestions use the combobox pattern: ↑/↓ to move, Enter or Tab to accept, Esc to close or
  cancel. ⌘K / Ctrl+K focuses the bar (`hotkey={false}` turns this off).
- Read-only commands run directly. Data changes show an **editable structured preview**: parameter
  editors, notes about corrections and assumptions, a list of concrete changes, then Confirm.
  High-risk actions need the phrase typed.
- Clarification questions offer numbered options. The person can also type an answer, a new
  command, or “cancel / 取消”.
- Undo is offered when the trusted side returned an undo token.
- Results are announced through a polite live region.

```tsx
import { ActionExecutor, DialogueSession, NaturalLanguageEngine } from "@nlae/core";
import { CommandBar, createLocalController } from "@nlae/react";
import "@nlae/react/commandBar.css";

const controller = createLocalController({
  session: new DialogueSession(new NaturalLanguageEngine(registry, entities)),
  executor: new ActionExecutor({ registry, entities, authorizer, handlers }),
  entities,
  parseContext: () => ({ product: "acme-notes", tenant: workspaceId, now: new Date() }),
  executionContext: () => ({ product: "acme-notes", tenant: workspaceId, principal: user.id, now: new Date() }),
});

<CommandBar
  controller={controller}
  labels={t.commandBar}                      // every visible string; English defaults in DEFAULT_LABELS
  format={(message) => t.messages[message.code] ?? message.message}   // translate engine/host messages by code
  actionName={(id) => t.actions[id]}
  paramName={(id, param) => t.params[param]}
  valueLabel={(id, param, value, fallback) => fallback}
/>
```

If your trusted side is remote, implement `CommandController` yourself. Point `preview`, `execute`
and `undo` at your API, which takes and returns the JSON in `@nlae/core/schema`. Keep `submit`,
`suggest` and `edit` local.

## Theming

`commandBar.css` only sets layout. Colors and shapes come from custom properties, so map them to
your design tokens on any ancestor:

```css
.my-command-area {
  --nlae-surface: var(--color-surface);   --nlae-text: var(--color-text);   --nlae-muted: var(--color-text-muted);
  --nlae-border: var(--color-border);     --nlae-accent: var(--color-accent); --nlae-accent-text: var(--color-on-accent);
  --nlae-danger: var(--color-danger);     --nlae-success: var(--color-success); --nlae-warning: var(--color-warning);
  --nlae-bg: var(--color-accent-soft);    --nlae-radius: 8px; --nlae-focus: var(--color-focus); --nlae-shadow: var(--shadow-md);
}
```

Without them, the bar falls back to CSS system colors (`Canvas`, `CanvasText`, `Highlight`…).
These follow the operating system's light, dark and high-contrast modes.
