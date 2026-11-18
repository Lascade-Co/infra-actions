// Test helpers. Everything here is fake: example.com/example.net names, RFC 5737 and
// 10.0.0.x addresses, placeholder UUIDs.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readInfraDir, type InfraFiles } from "../src/core/loader.js";
import type { ObservedDroplet } from "../src/core/observed.js";

export const EXAMPLE_DIR = fileURLToPath(new URL("../examples/infra/", import.meta.url));

/** The example checkout as an in-memory file map. */
export async function exampleFiles(): Promise<InfraFiles> {
  const { files, diagnostics } = await readInfraDir(EXAMPLE_DIR);
  if (diagnostics.length) throw new Error(`example checkout has layout problems: ${JSON.stringify(diagnostics)}`);
  return files;
}

/** The example checkout with some files replaced (value) or removed (null). */
export async function exampleWith(changes: Record<string, string | null>): Promise<InfraFiles> {
  const files = { ...(await exampleFiles()) };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete files[k];
    else files[k] = v;
  }
  return files;
}

export function observedDroplet(name: string, over: Partial<ObservedDroplet> = {}): ObservedDroplet {
  return {
    id: over.id ?? 1000 + name.length,
    name,
    region: "nyc1",
    privateIpv4: "10.0.0.10",
    publicIpv4: "203.0.113.10",
    tags: [],
    status: "active",
    ...over,
  };
}

/** A temp directory that the returned cleanup removes (call it in afterEach / finally). */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "infra-actions-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
