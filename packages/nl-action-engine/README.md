# @nlae/core — Natural Language Action Engine

A headless engine that turns typed commands in English, Simplified Chinese, Traditional Chinese
or a mix of them into a typed, validated **ActionPlan**. It then runs that plan through a
**trusted executor** that checks everything again before calling your application's own code.

- No business vocabulary. The host describes what it can do in an **Action Registry**.
- Runs offline and deterministically. It needs no LLM, cloud API, GPU, network or runtime dependency.
- Tolerates typos, same-sounding Chinese characters (IME slips), Traditional script, full-width
  characters and filler words.
- Keeps people's own text (names, search phrases) exactly as typed.
- Parsing never writes anything. Only the executor runs handlers, and only after re-validation,
  authorization, confirmation and a fresh preview.

```
src/
  text.ts       normalization (NFKC, case, T→S, punctuation), index map to the original, tokens, language detection
  fuzzy.ts      edit distance with transpositions, toneless-pinyin homophones, semi-global phrase alignment
  values.ts     dates / ranges (EN + ZH, relative and absolute), money with comparisons, numbers, quoted strings
  engine.ts     intent → parameters → context → plan → clarification; suggestions; preview edits
  dialogue.ts   bounded multi-turn session: answers, cancel, follow-ups, references
  executor.ts   trusted side: shape/scope/auth/argument checks, confirmation, preview fingerprint, idempotency, undo
  validate.ts   argument validation shared by both sides; plan shape check; fingerprint
  registry.ts   declarative Action Registry and JSON manifest
  protocol.ts   stable types (protocol "nlae/1")
  adapter.ts    the interfaces a host implements
schema/         JSON Schemas of the same protocol, for hosts written in other languages
```

## Pipeline

| Stage | What happens | Where |
|---|---|---|
| 1. Normalize, detect language | NFKC width folding, lower case, Traditional → Simplified through a bounded table, unified CJK punctuation. A map back to the original keeps values verbatim. Script counts give `en`, `zh-Hans`, `zh-Hant`, `zh` or `mixed`. | `text.ts` |
| 2. Tokenize, fuzzy match | Latin words, numbers and single Han characters become tokens. Phrases are aligned semi-globally, so command words may have gaps between them. Typos are accepted by length (≤2 letters: exact; 3: one transposition; 4–5: one edit; 6+: two edits). Han characters can match by shared toneless pinyin. A one-character Chinese expression must match exactly. | `fuzzy.ts` |
| 3. Intent | Every registered expression is scored. Quoted text, dates and amounts are never command words. Past-tense forms (“moved”, “deleted”) never count as commands. If a reading's matched tokens are contained in a longer reading's, the longer one wins. A negation earlier in the same clause (“don't”, “never”, 不要, 别把…) cancels the command. | `engine.ts` |
| 4. Parameters | Quoted strings, then dates, money and numbers, then enum options, then entities from the host's `EntityProvider` (searched after their marker word when there is one), then marker text (“rename X **to** Y”), then pronouns, then free-text remainder minus stopwords and action fillers. | `engine.ts`, `values.ts` |
| 5. Context and references | Pronouns (“it”, “them”, 它们, 这些…) fill parameters that share a `contextKey` with an earlier turn or with the host's `focus`. A missing *required* value of a non-destructive action may be taken from the previous turn; this is recorded as an assumption. | `engine.ts`, `dialogue.ts` |
| 6. Plan | Typed `ActionPlan` with arguments (including their source and raw text), targets, notes about corrections and assumptions, risk, confirmation level and scope. | `protocol.ts` |
| 7. Ambiguity and clarification | The engine asks a question instead of producing a ready plan when two actions or entities score within the ambiguity margin, a required value is missing, a reference is unresolved, or a data-changing command explains less than half of the input or has a sentence-long free-text value. | `engine.ts` |
| 8. Validation and safe execution | Shape, protocol, readiness, product/tenant scope, action, arguments (against the trusted entity list) and the host's `Authorizer` are checked. The confirmation level comes from the registry, not the plan, and the typed phrase is recomputed on the trusted side. The preview fingerprint must match. Idempotency is scoped by product and tenant. Undo tokens are one-shot, belong to one tenant and expire. | `executor.ts` |

**Confidence is never permission.** A score only ranks readings. Whether something runs depends on
the registry's risk level and the person's explicit confirmation.

| Risk | Meaning | Confirmation |
|---|---|---|
| `none` | reads, navigation, reversible UI preferences | none |
| `low` | creates something small | explicit confirm |
| `medium` | changes existing records | explicit confirm |
| `high` | deletes or hard-to-reverse changes | the person types a phrase, recomputed server-side |

## Integrating it into another application

### 1. Describe your capabilities

```ts
import { ActionRegistry } from "@nlae/core";

export const registry = new ActionRegistry("acme-notes", "1", [
  {
    id: "notes.create", description: "Create a note", risk: "low", undoable: true,
    expressions: ["create note", "new note", "add note", "新建笔记", "添加笔记"],
    examples: ["new note \"Groceries\" in Personal"],
    params: [
      { name: "title", type: "text", required: true, capture: "remainder", maxLength: 120 },
      { name: "folder", type: "entity", entityKind: "folder", markers: ["in", "to", "到"] },
    ],
  },
  {
    id: "folders.delete", description: "Delete a folder", risk: "high", typedConfirmationParam: "folder",
    expressions: ["delete folder", "删除文件夹"],
    context: [{ param: "folder", requirement: "reference" }],
    params: [{ name: "folder", type: "entity", entityKind: "folder", required: true, contextKey: "folder" }],
  },
]);
```

Guidelines:

- Use specific multi-word expressions for data-changing actions. Avoid giving two actions the
  same bare verb.
- Put translations and synonyms in `aliases` or `expressions`. The engine itself contains no
  domain vocabulary.
- Use `fillers` for generic words that must not become part of a search phrase (“notes”, “记录”).
- Give parameters that should be reachable by “it/them” a shared `contextKey`.

### 2. Implement the adapter

```ts
import type { EntityProvider, Authorizer, ActionHandler } from "@nlae/core";

const entities: EntityProvider = {
  // Only what this tenant may see: the list doubles as object-level validation on the trusted side.
  list: (kind, { tenant }) => kind === "folder" ? db.folders(tenant).map((f) => ({ id: f.id, label: f.name, aliases: f.aliases })) : [],
};

const authorizer: Authorizer = {
  authorize: ({ ctx, definition, args }) =>
    !ctx.principal ? { allowed: false, code: "unauthenticated", message: "Sign in" }
    : acl.can(ctx.principal, definition.id, args) ? { allowed: true } : { allowed: false, code: "forbidden", message: "Not allowed" },
};

const handlers: Record<string, ActionHandler> = {
  "notes.create": {
    async prepare(args) { return { operations: [{ op: "create", target: { kind: "note", id: "new", label: String(args.title) } }] }; },
    async execute(_prepared, args, ctx) {
      const note = await notesService.create(ctx.tenant, args);      // your existing business service
      return { summary: { code: "created", message: "Created." }, undo: note.id };
    },
    async undo(id, ctx) { await notesService.remove(ctx.tenant, String(id)); return { code: "undone", message: "Undone." }; },
  },
  // …one handler per action; the executor refuses to start if one is missing.
};
```

Handler rules:

- `prepare` must not write. Return the concrete operations. They are shown to the person and
  fingerprinted, and execution is refused if the data changed in the meantime.
- `execute` must be all-or-nothing. Use a database transaction where your storage supports one;
  otherwise record the previous state and restore it on failure (as the BillieWeather adapter does).
- Return `undo` data only when undo or compensation is actually possible.
- Return an empty `operations` list with a `summary` explaining why when nothing would change.

### 3. Wire the engine, session and executor

```ts
import { ActionExecutor, DialogueSession, NaturalLanguageEngine, PROTOCOL_VERSION } from "@nlae/core";

const engine = new NaturalLanguageEngine(registry, entities);
const executor = new ActionExecutor({ registry, entities, authorizer, handlers /*, idempotency, undo stores */ });
const session = new DialogueSession(engine);            // one per user + workspace

const plan = await session.submit("新建笔记 买牛奶 到 Personal", { product: "acme-notes", tenant: workspaceId });
if (plan.status === "needs_clarification") ask(plan.clarification);   // the next submit() is read as the answer
if (plan.status === "ready") {
  const preview = await executor.preview(plan, execCtx);            // concrete operations + fingerprint
  // show preview.plan; on explicit confirmation:
  const result = await executor.execute({ protocol: PROTOCOL_VERSION, plan: preview.plan, confirmation: { confirmed: true } }, execCtx);
  if (result.status === "succeeded") session.remember(preview.plan);
}
```

Create one session and one executor per tenant (account, workspace or database). Persist
`IdempotencyStore` and `UndoStore` in your database if executions must survive restarts. The
in-memory defaults are bounded and per-process.

### 4. Optional UI

`@nlae/react` provides an accessible command bar (combobox suggestions, keyboard navigation,
clarification questions, editable previews, typed confirmation, undo) that takes its colors from
your design tokens. See its README.

### Backends in other languages

Keep parsing in one place, for example in the client or in a small Node service. The trusted side
only needs to:

1. Load the manifest (`registry.manifest()`, validated by `schema/manifest.schema.json`).
2. Accept `ExecutionRequest` JSON (`schema/execution.schema.json`) and check it the way
   `ActionExecutor` does: shape, protocol, scope equals the authenticated tenant, action exists,
   arguments are valid against the manifest and the tenant's own objects, authorization,
   confirmation level from the manifest, typed phrase recomputed from trusted labels, and preview
   fingerprint (canonical JSON + FNV-1a, see `validate.ts`).
3. Run its own business services inside a transaction and return `ExecutionResult` JSON.

Never trust `risk`, `confirmation`, `confirmationPhrase`, `targets[].label` or `fingerprint` from
the client as authority. They are recomputed or compared on the trusted side.

### Optional LLM

`EngineOptions.fallback` accepts an `IntentFallback`. It is called only when nothing in the
registry matches. Its proposal goes through the same validation, and any data-changing proposal
always comes back as a `confirmIntent` question first. If it throws, the result is "unsupported",
not an error.

## Dependency assessment

| Library | Considered for | Decision |
|---|---|---|
| Fuse.js | fuzzy search | Not used. Matching is token alignment over short phrases with length-dependent edit limits and gaps, which Fuse's Bitap scoring doesn't express. About 60 lines of edit distance + alignment cover it. |
| pinyin-pro | homophones | Not bundled (its dictionary is large). A small toneless-pinyin table covers command vocabulary. A full encoder can be plugged in through `EngineOptions.phonetic` (`PhoneticEncoder.readings`). |
| opencc-js | Traditional → Simplified | Not bundled (its dictionaries are several hundred KB). A bounded character table covers command and UI vocabulary. Pass `scriptConverter` for full coverage. |
| chrono-node | dates | Not used. Its Chinese support is limited, and commands need a small, predictable set (relative periods, ISO/US dates, 年/月, month names). `values.ts` handles these in both languages. |
| Grammar parsers (nearley, PEG) | structure | Not needed. The constrained registry vocabulary plus markers handles command shapes, and a grammar would have to be written per host. |

Runtime dependencies: **none**. `@nlae/react` has peer dependencies on React ≥ 18 and `@nlae/core`.

## Versioning and publishing

- The protocol is versioned separately (`PROTOCOL_VERSION = "nlae/1"`, the `$id`s in `schema/`).
  Breaking changes to plan, request, result or manifest shapes bump it, and the executor rejects
  other versions.
- The packages are plain TypeScript source with `exports`. To publish, remove `"private": true`,
  add a build step (e.g. `tsc --declaration`), and publish `@nlae/core` before `@nlae/react`.

## Known limitations

- Built-in vocabulary tables (pinyin, T→S, stopwords, negations, date words) are bounded. Rare
  characters, idioms and languages other than English and Chinese are not covered. Japanese,
  Korean and Spanish commands are not parsed.
- Matching is lexical. Paraphrases with no shared words (“get rid of the house stuff”) are not
  understood without the optional fallback.
- Free-text parameters take the longest leftover run. Unusual word orders can leave a filler word
  in a search phrase. The preview shows it and it can be edited.
- Homophone tolerance is toneless and character-by-character. It can occasionally accept a wrong
  character of the same syllable, which is why every data change is previewed and confirmed.
- The in-memory idempotency and undo stores are per process. Persist them if you need durability
  across restarts.
