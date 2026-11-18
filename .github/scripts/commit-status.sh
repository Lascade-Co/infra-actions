#!/usr/bin/env bash
# Sets the commit status infra-actions/check on an infra commit. Never fails the job: the PR
# comment is what counts, the status is a convenience. It needs "Commit statuses: write" on the
# infra repo for INFRA_GH_TOKEN; without it GitHub answers 403 and this says so and moves on.
#
#   commit-status.sh <sha> <pending|success|failure|error> <description>
#
# INFRA_REPO defaults to Lascade-Co/infra.
set -uo pipefail

sha=${1:?usage: commit-status.sh <sha> <state> <description>}
state=${2:?usage: commit-status.sh <sha> <state> <description>}
desc=${3:?usage: commit-status.sh <sha> <state> <description>}
repo=${INFRA_REPO:-Lascade-Co/infra}
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-Lascade-Co/infra-actions}/actions/runs/${GITHUB_RUN_ID:-0}"

payload=$(jq -n --arg s "$state" --arg d "$desc" --arg u "$run_url" \
  '{state: $s, description: $d, target_url: $u, context: "infra-actions/check"}')

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${INFRA_GH_TOKEN:-}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  --data "$payload" \
  "https://api.github.com/repos/$repo/statuses/$sha" 2>/dev/null) || code=000

case "$code" in
  201) echo "Commit status infra-actions/check set to $state." ;;
  403 | 404) echo "Commit status skipped: the token can't set commit statuses on the infra repo (HTTP $code). Give INFRA_GH_TOKEN \"Commit statuses: write\" to turn it on." ;;
  *) echo "Commit status skipped: HTTP $code." ;;
esac
exit 0
