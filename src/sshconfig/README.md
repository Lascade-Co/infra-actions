# sshconfig (B6): ssh config on the `ssh-config` branch

This replaces the Worker's `GET /<file>` endpoint (decision 4). The tool generates the OpenSSH config on every apply and commits it to a branch of the private `infra` repo that holds only that file. People clone that one branch once (`git clone --single-branch -b ssh-config`), add an `Include` line to `~/.ssh/config`, and update it with `git pull`.

## What it must do

- **`sshHosts(desired)`:** returns the droplets that get an Access for Infrastructure target, as the Cloudflare plan does: `status: "exists"`, a `privateIpv4`, an `sshHostname` (name in a zone), and a `tunnelId` (a region with a tunnel). Sort them by name.
- **`renderSshConfig(hosts, { title, user })`** (pure): port the Worker's `renderSshConfig`. Each host gets `Host <name>`, `HostName <private ip>`, `User <user>` and `HostKeyAlias <name>`.
  - The header's first line comes from `account.ssh_config.title`. Keep org names out of this repo's code.
  - Keep the Worker's explanatory comments, but generic.
  - Make it deterministic, with no timestamps, so the same hosts give the same bytes.
- **`observeSshConfig(ctx)`:** `GET /repos/{account.github.infra_repo}/contents/{ssh_config_file}?ref={ssh_config_branch}` with `INFRA_GH_TOKEN`.
  - A 404 means there's no file or branch yet, so return `{}`.
  - Read the `github-authentication-token-expiration` response header into `tokenExpiresAt` (an ISO date). The drift report shows it.
- **`planSshConfig(desired, observed)`** (pure): at most one op, `kind: "ssh-config"`, key `"<repo>@<branch>:<file>"`.
  - The action is `create` when there's no file yet, or `update` when the rendered text differs.
  - `before` and `after` are `{ hosts: <count>, added: [...names], removed: [...names] }`, not the whole file.
- **`applySshConfig(ctx, ops, observed)`:**
  - Commit the file with `PUT /repos/{repo}/contents/{file}` on the branch, passing `sha` when updating.
  - If the branch doesn't exist, create it as an orphan holding only the file, using the git data API (tree → commit → ref).
  - Never touch any other branch.

## Inputs and outputs

- **Input:** `DesiredState`.
- **Observed:** `SshConfigObserved`.
- **Output:** a `ModulePlan` and an `ApplyResult`.
- **Credentials:** `credentials()` is already wired. It reports the token's expiry from `observed`.

## Port from

`src/sshconfig.ts` in the infra-sync Worker. Its header text names the org, so take that from the account config instead. Tests go in `test/sshconfig/` and use fake data only.
