#!/usr/bin/env bash
# Fetches one commit of the private infra repo into a new directory, quietly.
#
#   fetch-infra.sh <dir> <ref> [<expected sha>]
#
# <ref> is a branch ref (refs/heads/main), a pull request ref (refs/pull/<n>/head, which also
# works for pull requests from forks) or a full commit sha. With <expected sha>, the fetched
# commit must be exactly that one: exit 3 when it isn't (the pull request moved on).
#
# Why not actions/checkout: it logs "HEAD is now at <sha> <commit subject>", and infra commit
# subjects can name droplets. This repo's logs are public (decision 7: counts and pass/fail only).
# git runs with -q, the token goes in a header (never in the URL or .git/config), and nothing
# from the infra repo is printed.
#
# Needs INFRA_GH_TOKEN (read access to the infra repo). INFRA_REPO defaults to Lascade-Co/infra.
set -euo pipefail

dir=${1:?usage: fetch-infra.sh <dir> <ref> [<expected sha>]}
ref=${2:?usage: fetch-infra.sh <dir> <ref> [<expected sha>]}
expect=${3:-}
repo=${INFRA_REPO:-Lascade-Co/infra}
: "${INFRA_GH_TOKEN:?INFRA_GH_TOKEN is not set}"

auth=$(printf 'x-access-token:%s' "$INFRA_GH_TOKEN" | base64 | tr -d '\n')
echo "::add-mask::$auth"

rm -rf "$dir"
mkdir -p "$dir"
git -C "$dir" init -q
git -C "$dir" -c "http.extraHeader=Authorization: Basic $auth" \
  fetch -q --depth 1 --no-tags "https://github.com/$repo.git" "$ref"

got=$(git -C "$dir" rev-parse FETCH_HEAD)
if [ -n "$expect" ] && [ "$got" != "$expect" ]; then
  echo "The fetched commit is not the expected one."
  rm -rf "$dir"
  exit 3
fi
git -C "$dir" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
echo "Fetched infra at $got."
