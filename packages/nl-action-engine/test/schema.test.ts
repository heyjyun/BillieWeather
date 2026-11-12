// The JSON Schemas in schema/ are the language-neutral contract. These tests check that what the
// TypeScript engine actually produces conforms to them, using a small built-in validator for the
// subset of JSON Schema the files use (so no validator dependency is needed).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionExecutor, DialogueSession, NaturalLanguageEngine, PROTOCOL_VERSION } from "../src";
import { aliceExec, aliceParse, toyAuthorizer, toyData, toyEntities, toyHandlers, toyRegistry } from "./toyApp";

type Schema = Record<string, unknown>;
const DIR = join(__dirname, "../schema");
const files: Record<string, Schema> = Object.fromEntries(["action-plan", "execution", "manifest"].map((n) => [`${n}.schema.json`, JSON.parse(readFileSync(join(DIR, `${n}.schema.json`), "utf8"))]));

function resolve(ref: string, base: string): { schema: Schema; base: string } {
  const [file, pointer] = ref.split("#");
  const doc = file ? file : base;
  let node: unknown = files[doc];
  for (const part of (pointer ?? "").split("/").filter(Boolean)) node = (node as Record<string, unknown>)[part];
  return { schema: node as Schema, base: doc };
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function validate(value: unknown, schema: Schema, base: string, path = "$"): string[] {
  if (schema.$ref) { const r = resolve(String(schema.$ref), base); return validate(value, r.schema, r.base, path); }
  const errors: string[] = [];
  if ("const" in schema && value !== schema.const) errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  if (schema.enum && !(schema.enum as unknown[]).includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (schema.type) {
    const types = ([] as string[]).concat(schema.type as string);
    const actual = typeOf(value);
    if (!types.includes(actual) && !(actual === "integer" && types.includes("number"))) errors.push(`${path}: type ${actual}, expected ${types.join("|")}`);
  }
  if (typeof value === "string" && schema.pattern && !new RegExp(String(schema.pattern)).test(value)) errors.push(`${path}: pattern`);
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: minimum`);
  if (typeof value === "number" && typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: maximum`);
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => errors.push(...validate(item, schema.items as Schema, base, `${path}[${i}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in object)) errors.push(`${path}: missing ${key}`);
    const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [key, child] of Object.entries(object)) {
      if (child === undefined) continue;
      if (properties[key]) errors.push(...validate(child, properties[key], base, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") errors.push(...validate(child, schema.additionalProperties as Schema, base, `${path}.${key}`));
    }
  }
  if (schema.allOf) for (const part of schema.allOf as Schema[]) errors.push(...validate(value, part, base, path));
  if (schema.oneOf) {
    const passing = (schema.oneOf as Schema[]).filter((option) => validate(value, option, base, path).length === 0).length;
    if (passing !== 1) errors.push(`${path}: matches ${passing} of oneOf`);
  }
  return errors;
}

const PLAN = { $ref: "action-plan.schema.json#" };
const RESULT = { $ref: "execution.schema.json#/$defs/result" };
const REQUEST = { $ref: "execution.schema.json#/$defs/request" };

describe("JSON Schema contract", () => {
  it("every plan the engine produces conforms, whatever its status", async () => {
    const data = toyData();
    const engine = new NaturalLanguageEngine(toyRegistry(), toyEntities(data));
    const session = new DialogueSession(engine);
    const inputs = ["add task \"Call the bank\" to Home", "show tasks last month", "delete project", "delete it", "what is the weather", "", "don't delete project Home", "切換到淺色", "rename project Work to Office"];
    for (const input of inputs) {
      const plan = await session.submit(input, aliceParse);
      expect(validate(JSON.parse(JSON.stringify(plan)), PLAN, "action-plan.schema.json"), input).toEqual([]);
    }
  });

  it("requests and results conform, including rejections and undo", async () => {
    const data = toyData();
    const registry = toyRegistry();
    const engine = new NaturalLanguageEngine(registry, toyEntities(data));
    const executor = new ActionExecutor({ registry, entities: toyEntities(data), authorizer: toyAuthorizer, handlers: toyHandlers(data) });
    const plan = (await executor.preview(await engine.interpret("rename project Work to Office", aliceParse), aliceExec())).plan;
    const request = { protocol: PROTOCOL_VERSION, plan, confirmation: { confirmed: true } };
    expect(validate(JSON.parse(JSON.stringify(request)), REQUEST, "execution.schema.json")).toEqual([]);
    const rejected = await executor.execute({ ...request, confirmation: { confirmed: false } }, aliceExec());
    const done = await executor.execute(request, aliceExec());
    const undone = await executor.undo(done.undo!.token, aliceExec());
    for (const result of [rejected, done, undone]) expect(validate(JSON.parse(JSON.stringify(result)), RESULT, "execution.schema.json")).toEqual([]);
  });

  it("the manifest conforms", () => {
    expect(validate(JSON.parse(JSON.stringify(toyRegistry().manifest())), { $ref: "manifest.schema.json#" }, "manifest.schema.json")).toEqual([]);
  });

  it("the validator itself rejects bad documents", () => {
    expect(validate({ protocol: "nlae/0" }, PLAN, "action-plan.schema.json").length).toBeGreaterThan(0);
  });
});
