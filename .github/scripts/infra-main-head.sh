#!/usr/bin/env bash
# Fails unless <sha> is the current head of infra's main.
#
#   infra-main-head.sh <sha>
#
# The apply runs only for the tip of main: a dispatch for an older commit (stale, or delivered
# out of order) applies nothing; the dispatch for the newer push applies the current state.
# Needs GH_TOKEN (read access to the infra repo). INFRA_REPO defaults to Lascade-Co/infra.
# Prints shas only, never commit subjects.
set -euo pipefail

sha=${1:?usage: infra-main-head.sh <sha>}
repo=${INFRA_REPO:-Lascade-Co/infra}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::sha must be 40 lowercase hex characters"; exit 1; }

head=$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha)
if [ "$head" != "$sha" ]; then
  echo "::error::The dispatched commit $sha is not the head of infra's main ($head); nothing applied. The run for the newer push applies the current state."
  exit 1
fi
echo "The commit is the head of infra's main."
