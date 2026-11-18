# sshconfig (B6): ssh config on the `ssh-config` branch

This replaces the Worker's `GET /<file>` endpoint (decision 4). The tool generates the OpenSSH config on every apply and commits it to a branch of the private `infra` repo that holds only that file and a `README.md` with the install steps. People clone that one branch once (`git clone --single-branch -b ssh-config <url> ~/.ssh/<team>`), add `Include ~/.ssh/<team>/<ssh_config_file>` at the top of `~/.ssh/config`, and update it with `git pull`. `<team>` is the first label of `cloudflare.team_domain`, so no org name is written in this repo.

## What it must do

- **`sshHosts(desired)`:** returns the droplets that get an Access for Infrastructure target, as the Cloudflare plan does: `status: "exists"`, a `privateIpv4`, an `sshHostname` (name in a zone), and a `tunnelId` (a region with a tunnel). Sort them by name.
- **`renderSshConfig(hosts, { title, user })`** (pure): port the Worker's `renderSshConfig`. Each host gets `Host <name>`, `HostName <private ip>`, `User <user>` and `HostKeyAlias <name>`.
  - The header's first line comes from `account.ssh_config.title`. Keep org names out of this repo's code.
  - Keep the Worker's explanatory comments, but generic. The team name and the `Include` path come from the account config (`team`, `include` options).
  - The host blocks are the Worker's, byte for byte (the test pins them); only the header differs.
  - Make it deterministic, with no timestamps, so the same hosts give the same bytes.
- **`observeSshConfig(ctx)`:** `GET /repos/{account.github.infra_repo}/contents/{ssh_config_file}?ref={ssh_config_branch}` with `INFRA_GH_TOKEN`, and the same for `README.md`.
  - A 404 means there's no file or branch yet, so that field stays unset.
  - Read the `github-authentication-token-expiration` response header into `tokenExpiresAt` (an ISO date). The drift report shows it.
- **`planSshConfig(desired, observed)`** (pure): at most one op, `kind: "ssh-config"`, key `"<repo>@<branch>:<file>"`.
  - The action is `create` when there's no file yet, or `update` when the rendered text or the README differs.
  - `before` is `{ hosts: <count> }` (null for create); `after` is `{ hosts: <count>, added: [...names], removed: [...names], changed?: [...names with a new IP] }`, not the whole file.
  - The rendered text and README travel to apply in `op.ids` (`content`, `readme`); `src/output` never renders `ids`.
- **`applySshConfig(ctx, ops, observed)`:**
  - Commit the config and README in one commit with the git data API: a tree of exactly those two files → a commit whose parent is the branch head read at apply time → `PATCH` the ref (`force: false`).
  - If the branch doesn't exist, the commit has no parent and the ref is created (an orphan branch).
  - Refuses to write when the branch is `main`/`master` or already holds any other file.
  - Never touch any other branch.

## Inputs and outputs

- **Input:** `DesiredState`.
- **Observed:** `SshConfigObserved`.
- **Output:** a `ModulePlan` and an `ApplyResult`.
- **Credentials:** `credentials()` is already wired. It reports the token's expiry from `observed`.

## Port from

`src/sshconfig.ts` in the infra-sync Worker. Its header text names the org, so take that from the account config instead. Tests go in `test/sshconfig/` and use fake data only.
