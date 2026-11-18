// The module registry: which modules exist and the order they plan and apply in.
// Later build phases fill in the modules; they should not need to edit this file.

import { checkChange, checkConfig, checkDesired } from "./checks/index.js";
import { createCloudflareProvider } from "./cloudflare/index.js";
import type { Provider, RunContext } from "./core/plan.js";
import { createDropletsProvider, type DropletsProvider } from "./droplets/index.js";
import { createFirewallProvider } from "./firewall/index.js";
import { createOneUptimeProvider } from "./oneuptime/index.js";
import { renderTelegram, sendTelegram } from "./output/index.js";
import { createSshConfigProvider } from "./sshconfig/index.js";

export interface Checks {
  checkConfig: typeof checkConfig;
  checkDesired: typeof checkDesired;
  checkChange: typeof checkChange;
}

export interface Notifier {
  renderTelegram: typeof renderTelegram;
  sendTelegram: typeof sendTelegram;
}

export interface Modules {
  /** Observed first (the desired state is built from it) and applied first (new droplets need IPs). */
  droplets: DropletsProvider;
  /**
   * Planned and applied in this order, after droplets:
   * cloudflare (needs the droplets' IPs), firewall (report-only), oneuptime (sites exist), sshconfig (last).
   */
  providers: Array<Provider<unknown>>;
  checks: Checks;
  notifier: Notifier;
}

export function createModules(ctx: RunContext): Modules {
  return {
    droplets: createDropletsProvider(ctx),
    providers: [
      createCloudflareProvider(ctx),
      createFirewallProvider(ctx),
      createOneUptimeProvider(ctx),
      createSshConfigProvider(ctx),
    ] as Array<Provider<unknown>>,
    checks: { checkConfig, checkDesired, checkChange },
    notifier: { renderTelegram, sendTelegram },
  };
}
