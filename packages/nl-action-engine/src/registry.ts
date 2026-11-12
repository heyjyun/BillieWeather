// Declarative Action Registry: what the host can do, described as data.

import { PROTOCOL_VERSION, type ActionDefinition, type RegistryManifest } from "./protocol";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

const ID = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/i;
const PARAM = /^[a-z][a-zA-Z0-9_]*$/;
const RISKS = new Set(["none", "low", "medium", "high"]);
const TYPES = new Set(["text", "enum", "entity", "number", "money", "date", "dateRange", "boolean"]);

/** Throws a RegistryError describing the first problem in a definition. */
export function checkDefinition(definition: ActionDefinition): void {
  const where = `action ${JSON.stringify(definition.id)}`;
  if (!ID.test(definition.id)) throw new RegistryError(`${where}: id must be namespaced like "area.verb"`);
  if (!definition.description?.trim()) throw new RegistryError(`${where}: description is required`);
  if (!RISKS.has(definition.risk)) throw new RegistryError(`${where}: unknown risk ${definition.risk}`);
  if (!definition.expressions?.length) throw new RegistryError(`${where}: at least one expression is required`);
  for (const expression of definition.expressions) {
    const trimmed = expression.trim();
    if (!trimmed) throw new RegistryError(`${where}: empty expression`);
    if (/^[a-z]{1,2}$/i.test(trimmed)) throw new RegistryError(`${where}: expression ${JSON.stringify(expression)} is too short to match safely`);
  }
  const names = new Set<string>();
  for (const param of definition.params) {
    if (!PARAM.test(param.name)) throw new RegistryError(`${where}: invalid parameter name ${JSON.stringify(param.name)}`);
    if (names.has(param.name)) throw new RegistryError(`${where}: duplicate parameter ${param.name}`);
    names.add(param.name);
    if (!TYPES.has(param.type)) throw new RegistryError(`${where}: parameter ${param.name} has unknown type ${param.type}`);
    if ((param.type === "enum" || param.type === "boolean") && !param.options?.length) throw new RegistryError(`${where}: ${param.type} parameter ${param.name} needs options`);
    if (param.type === "entity" && !param.entityKind) throw new RegistryError(`${where}: entity parameter ${param.name} needs entityKind`);
    if (param.type === "entity" && param.default !== undefined) throw new RegistryError(`${where}: entity parameter ${param.name} cannot have a default`);
  }
  if (definition.typedConfirmationParam && !names.has(definition.typedConfirmationParam)) {
    throw new RegistryError(`${where}: typedConfirmationParam ${definition.typedConfirmationParam} is not a parameter`);
  }
  for (const requirement of definition.context ?? []) {
    if (!names.has(requirement.param)) throw new RegistryError(`${where}: context requirement for unknown parameter ${requirement.param}`);
  }
}

export class ActionRegistry {
  private readonly definitions = new Map<string, ActionDefinition>();

  constructor(readonly product: string, readonly version = "1", definitions: readonly ActionDefinition[] = []) {
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(product)) throw new RegistryError("product must be a simple identifier");
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ActionDefinition): this {
    checkDefinition(definition);
    if (this.definitions.has(definition.id)) throw new RegistryError(`action ${definition.id} is already registered`);
    this.definitions.set(definition.id, Object.freeze(clone(definition)));
    return this;
  }

  get(id: string): ActionDefinition | undefined {
    return this.definitions.get(id);
  }

  all(): ActionDefinition[] {
    return [...this.definitions.values()];
  }

  /** Plain JSON for other runtimes (a backend in another language validates plans against it). */
  manifest(): RegistryManifest {
    return { protocol: PROTOCOL_VERSION, product: this.product, version: this.version, actions: this.all().map((d) => clone(d)) };
  }

  static fromManifest(manifest: RegistryManifest): ActionRegistry {
    if (manifest.protocol !== PROTOCOL_VERSION) throw new RegistryError(`unsupported protocol ${manifest.protocol}`);
    return new ActionRegistry(manifest.product, manifest.version, manifest.actions);
  }
}
