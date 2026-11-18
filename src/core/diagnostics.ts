// Diagnostics: errors and warnings from loading, checks and planning.
//
// They carry real names and are only ever written to the detail file (--out), never to
// stdout/stderr: the logs of this public repo show counts only.

export type Level = "error" | "warning" | "info";

export interface Diagnostic {
  level: Level;
  /** Stable machine code, e.g. "schema", "file-name", "unknown-profile", "udp-needs-staff". */
  code: string;
  message: string;
  /** File relative to the infra checkout, e.g. droplets/app.example.com.yaml. */
  file?: string;
  /** Dotted path inside the file, e.g. web.exceptions[0].path. */
  path?: string;
  /** 1-based line in the file, when known. */
  line?: number;
  /** Droplet name this is about, when there is one. */
  droplet?: string;
}

export const errorsIn = (ds: readonly Diagnostic[]): Diagnostic[] => ds.filter((d) => d.level === "error");
export const hasErrors = (ds: readonly Diagnostic[]): boolean => ds.some((d) => d.level === "error");

/** "droplets/x.yaml:12 web.origin: message" */
export function formatDiagnostic(d: Diagnostic): string {
  const where = [d.file ? `${d.file}${d.line ? `:${d.line}` : ""}` : "", d.path ?? ""].filter(Boolean).join(" ");
  return `${d.level}${where ? ` ${where}` : ""}: ${d.message}`;
}

/** Thrown by a module function that a later build phase still has to write. */
export class NotImplementedError extends Error {
  constructor(readonly what: string) {
    super(`${what} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

export const notImplemented = (what: string): never => {
  throw new NotImplementedError(what);
};
