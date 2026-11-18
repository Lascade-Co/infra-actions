// B6: the ssh config, published to the ssh-config branch of the infra repo.
// Contract only; see README.md in this folder.

import type { DesiredState } from "../core/desired.js";
import { notImplemented } from "../core/diagnostics.js";
import type { ApplyResult, ModulePlan, PlanOp, Provider, RunContext } from "../core/plan.js";
import type { CredentialStatus } from "../core/report.js";

export interface SshHost {
  /** Droplet name, e.g. app.example.com. */
  name: string;
  privateIp: string;
}

export interface SshConfigObserved {
  /** Current file on the branch; undefined when the branch or file doesn't exist yet. */
  content?: string;
  /** Blob sha of that file (the contents API needs it to update). */
  sha?: string;
  /** From the github-authentication-token-expiration response header, ISO date. */
  tokenExpiresAt?: string;
}

/** Hosts for the config: the droplets that get an Access for Infrastructure target (status exists, private IP, name in a zone, region with a tunnel). */
export function sshHosts(_desired: DesiredState): SshHost[] {
  return notImplemented("sshconfig.sshHosts");
}

/**
 * Pure: the OpenSSH config (as the Worker's renderSshConfig: Host <name> / HostName <private ip> /
 * User <account.ssh_config.user> / HostKeyAlias <name>), sorted by name, header from
 * account.ssh_config.title. Deterministic: no timestamps, so an unchanged set means no commit.
 */
export function renderSshConfig(_hosts: SshHost[], _opts: { title: string; user: string }): string {
  return notImplemented("sshconfig.renderSshConfig");
}

/** Read-only: GET the file on account.github.ssh_config_branch of account.github.infra_repo (INFRA_GH_TOKEN). */
export async function observeSshConfig(_ctx: RunContext): Promise<SshConfigObserved> {
  return notImplemented("sshconfig.observeSshConfig");
}

/** Pure: at most one op, kind "ssh-config", create (no file yet) or update (content differs). */
export function planSshConfig(_desired: DesiredState, _observed: SshConfigObserved): ModulePlan {
  return notImplemented("sshconfig.planSshConfig");
}

/** Commits the file to the branch (creating the branch as an orphan if missing). Never touches other branches. */
export async function applySshConfig(_ctx: RunContext, _ops: PlanOp[], _observed: SshConfigObserved): Promise<ApplyResult> {
  return notImplemented("sshconfig.applySshConfig");
}

export function createSshConfigProvider(ctx: RunContext): Provider<SshConfigObserved> {
  return {
    module: "sshconfig",
    observe: () => observeSshConfig(ctx),
    diff: (desired, observed) => planSshConfig(desired, observed),
    apply: (ops, observed) => applySshConfig(ctx, ops, observed),
    credentials: (observed): CredentialStatus[] => [
      { name: "INFRA_GH_TOKEN", ...(observed.tokenExpiresAt ? { expiresAt: observed.tokenExpiresAt } : {}) },
    ],
  };
}
