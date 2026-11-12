// @nlae/core — a domain-agnostic, offline natural-language action engine.
// Headless: no UI, no network, no runtime dependencies. See ../README.md.
export * from "./protocol";
export * from "./adapter";
export { ActionRegistry, RegistryError, checkDefinition } from "./registry";
export { NaturalLanguageEngine, formatRange, type EngineOptions, type HistoryTurn, type InterpretOptions, type Suggestion } from "./engine";
export { DialogueSession, chooseOption, isCancel, isNo, isYes, type DialogueOptions } from "./dialogue";
export { ActionExecutor, MemoryIdempotencyStore, MemoryUndoStore, type ExecutorOptions, type IdempotencyStore, type UndoRecord, type UndoStore } from "./executor";
export { checkValue, fingerprint, planShapeProblem, sameTypedPhrase, validateArguments } from "./validate";
export { defaultPhonetic, editDistance, matchPhrase, tableEncoder, type PhoneticEncoder } from "./fuzzy";
export { detectLanguage, normalize, originalSlice, parseChineseNumber, tokenize, toSimplifiedChar, type LanguageTag, type ScriptConverter } from "./text";
export { findDates, findMoney, localIsoDate } from "./values";
