# infra-actions

This repo holds the code and workflows that keep our infrastructure in step with the private data repo
`Lascade-Co/infra`; it replaces the infra-sync Cloudflare Worker. `infra` dispatches its pull requests (check)
and its pushes to `main` (apply) here, and each run is pinned to the dispatched `infra` commit. This repo is
public: it holds no real hostnames, IPs, account ids or droplet names, and the CLI and workflows log counts and
pass/fail only (decision 7). See `README.md`.

## Sealed output

This repo is public and its CI output is sealed. Rules, enforced by `.github/workflows/seal-policy.yml`:

- Every job starts with `Lascade-Co/actions/actions/seal@<full commit SHA> # seal-v1` and ends with `Lascade-Co/actions/actions/seal-upload@<the same SHA> # seal-v1` (`if: always()`). Neither takes `with:`.
- Pin every action, including the seal action, to a full commit SHA; bump the seal action SHA deliberately (it runs beside the live infrastructure tokens).
- Never use plain `shell: bash`; the default shell is `seal-bash {0}` or `seal-bash-e {0}`.
- Never expand private values into `run:` text, `env:` or a third-party `with:`; the public step header shows them.
- Pack artifacts with `seal-pack` and read them with `seal-unpack` (`REPO_AGE_KEY` from secrets); keep retention at 7 days or less.
- Mask private values with `::add-mask::` in an earlier sealed step; never mask public metadata.
- No secrets in `pull_request` workflows; no `pull_request_target`.
- Jobs with a `permissions:` block need `contents: read`.
- Full rules: https://github.com/Lascade-Co/actions/blob/main/docs/sealed-output.md
- Open runs at https://ci.lascade.com/?repo=infra-actions
