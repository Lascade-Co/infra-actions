// JSON Schema validation (ajv, draft-07) of the three file kinds, with error messages a
// person can act on: dotted path, what was wrong, and the allowed values.
//
// Schemas are read from schema/ at run time, relative to this file, so the same code works
// from src/ (tests) and dist/ (the built CLI).

import { readFileSync } from "node:fs";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

export type SchemaKind = "droplet" | "profile" | "account";

const SCHEMA_DIR = new URL("../../schema/", import.meta.url);

export function readSchema(kind: SchemaKind): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`${kind}.schema.json`, SCHEMA_DIR), "utf8")) as Record<string, unknown>;
}

let validators: Record<SchemaKind, ValidateFunction> | undefined;

function getValidators(): Record<SchemaKind, ValidateFunction> {
  if (validators) return validators;
  const ajv = new Ajv({ allErrors: true, verbose: true, strict: true, strictTypes: false, strictRequired: false, useDefaults: false });
  // Annotation: a human message for a schema whose own errors would be unhelpful (oneOf, if/then, not).
  ajv.addKeyword({ keyword: "x-error", schemaType: "string" });
  validators = {
    droplet: ajv.compile(readSchema("droplet")),
    profile: ajv.compile(readSchema("profile")),
    account: ajv.compile(readSchema("account")),
  };
  return validators;
}

export interface SchemaIssue {
  /** Path segments into the document (keys and array indexes). */
  segments: Array<string | number>;
  /** Dotted form, e.g. web.exceptions[0].path ("" for the top level). */
  path: string;
  message: string;
}

/** web.exceptions[0].path */
export function dottedPath(segments: ReadonlyArray<string | number>): string {
  let out = "";
  for (const s of segments) out += typeof s === "number" ? `[${s}]` : out ? `.${s}` : s;
  return out;
}

function segmentsOf(instancePath: string): Array<string | number> {
  if (!instancePath) return [];
  return instancePath
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

const hint = (e: ErrorObject): string | undefined => {
  const ps = e.parentSchema as Record<string, unknown> | undefined;
  return typeof ps?.["x-error"] === "string" ? (ps["x-error"] as string) : undefined;
};
const describe = (e: ErrorObject): string | undefined => {
  const ps = e.parentSchema as Record<string, unknown> | undefined;
  return typeof ps?.description === "string" ? (ps.description as string) : undefined;
};

function messageOf(e: ErrorObject): string {
  const p = e.params as Record<string, unknown>;
  const h = hint(e);
  switch (e.keyword) {
    case "required":
      return h ?? `missing required key "${String(p.missingProperty)}"`;
    case "additionalProperties":
      return `unknown key "${String(p.additionalProperty)}"`;
    case "enum":
      return `must be one of: ${(p.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
    case "const":
      return `must be ${JSON.stringify(p.allowedValue)}`;
    case "pattern": {
      const d = describe(e);
      return `${JSON.stringify(e.data)} is not valid${d ? `: ${d}` : ` (expected pattern ${String(p.pattern)})`}`;
    }
    case "type":
      return `must be ${String(p.type)}`;
    case "minItems":
      return `must have at least ${String(p.limit)} item(s)`;
    case "uniqueItems":
      return `has duplicate items (${String(p.j)} and ${String(p.i)})`;
    case "minProperties":
      return h ?? `must have at least ${String(p.limit)} key(s)`;
    case "oneOf":
    case "anyOf":
    case "not":
      return h ?? describe(e) ?? `is not any of the allowed forms`;
    default:
      return h ?? e.message ?? `is not valid (${e.keyword})`;
  }
}

/**
 * Validates `data` against the schema of `kind`. Returns [] when valid. Errors inside a
 * oneOf/anyOf branch are folded into the one message of the oneOf/anyOf; the bare
 * "must match then schema" of if/then is dropped (its then-errors carry the message).
 */
export function validate(kind: SchemaKind, data: unknown): SchemaIssue[] {
  const v = getValidators()[kind];
  if (v(data)) return [];
  const errs = v.errors ?? [];
  const out: SchemaIssue[] = [];
  const seen = new Set<string>();
  // Branch errors of a failed oneOf/anyOf come from $ref'd definitions too (so their schemaPath
  // doesn't show the branch): fold every error at or under a oneOf/anyOf's instance path into it.
  const folded = errs.filter((e) => e.keyword === "oneOf" || e.keyword === "anyOf").map((e) => e.instancePath);
  const underFold = (p: string) => folded.some((f) => p === f || p.startsWith(`${f}/`));
  for (const e of errs) {
    if (e.keyword === "if") continue;
    if (e.keyword !== "oneOf" && e.keyword !== "anyOf" && underFold(e.instancePath)) continue;
    let segments = segmentsOf(e.instancePath);
    if (e.keyword === "additionalProperties") segments = [...segments, String((e.params as Record<string, unknown>).additionalProperty)];
    const issue = { segments, path: dottedPath(segments), message: messageOf(e) };
    const k = `${issue.path}\u0000${issue.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(issue);
  }
  return out;
}
