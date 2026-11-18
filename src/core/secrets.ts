// Secrets come only from environment variables. Values are never logged, never written
// to the detail file, never put in error messages: only the variable names are.

export const SECRET_NAMES = [
  "CF_API_TOKEN",
  "DO_TOKEN",
  "INFRA_GH_TOKEN",
  "ONEUPTIME_API_KEY",
  "ONEUP_ACCESS_CLIENT_ID",
  "ONEUP_ACCESS_CLIENT_SECRET",
  "TELEGRAM_BOT_TOKEN",
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

export class MissingSecretError extends Error {
  constructor(readonly secret: SecretName) {
    super(`environment variable ${secret} is not set`);
    this.name = "MissingSecretError";
  }
}

export class Secrets {
  private readonly values: Partial<Record<SecretName, string>>;

  constructor(env: Record<string, string | undefined>) {
    this.values = {};
    for (const n of SECRET_NAMES) {
      const v = env[n]?.trim();
      if (v) this.values[n] = v;
    }
  }

  has(name: SecretName): boolean {
    return this.values[name] !== undefined;
  }

  /** The value, or MissingSecretError (which names the variable, never a value). */
  require(name: SecretName): string {
    const v = this.values[name];
    if (v === undefined) throw new MissingSecretError(name);
    return v;
  }

  /** Replaces every secret value in `text` with "***". Last line of defence for anything printed. */
  redact(text: string): string {
    let out = text;
    for (const v of Object.values(this.values)) {
      if (v && v.length >= 4) out = out.split(v).join("***");
    }
    return out;
  }

  /** Never serialise values. */
  toJSON(): Record<string, boolean> {
    return Object.fromEntries(SECRET_NAMES.map((n) => [n, this.has(n)]));
  }
}
