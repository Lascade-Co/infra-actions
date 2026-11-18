#!/usr/bin/env bash
# Posts the check report as THE plan comment on an infra pull request, or updates it.
#
#   pr-comment.sh <pr number> <report file> <head sha>
#
# The plan comment is the one written by the token's own account whose body starts with the
# marker below; it is edited in place, so a pull request has one plan comment however often it
# is checked. Without a report file (the check did not get that far) a short note replaces it,
# so an old plan never stays up for a newer commit.
#
# Never prints the report or GitHub's responses (they hold the plan): only what was done.
# Needs GH_TOKEN (pull requests write on the infra repo). INFRA_REPO defaults to Lascade-Co/infra.
set -euo pipefail

pr=${1:?usage: pr-comment.sh <pr> <report file> <head sha>}
report=${2:?usage: pr-comment.sh <pr> <report file> <head sha>}
sha=${3:?usage: pr-comment.sh <pr> <report file> <head sha>}
repo=${INFRA_REPO:-Lascade-Co/infra}
marker='<!-- infra-actions:plan -->'
max=60000 # GitHub refuses comment bodies over 65536 characters

body=$(mktemp "${RUNNER_TEMP:-/tmp}/infra-comment.XXXXXX")
trap 'rm -f "$body"' EXIT

if [ -s "$report" ]; then
  # The tool's report starts with the marker; its internal-error report doesn't.
  if [ "$(head -n 1 "$report")" != "$marker" ]; then printf '%s\n' "$marker" >"$body"; fi
  cat "$report" >>"$body"
else
  printf '%s\n## What happens when this is merged\n\n❌ **The check of %s did not finish**, so there is no plan for it. Push again or ask an infra admin to look at the run in infra-actions. Don'"'"'t merge this until a plan shows here.\n' \
    "$marker" "$sha" >"$body"
fi

payload=$(jq -Rs --argjson max "$max" \
  'if length > $max then .[:$max] + "\n\n_The plan was cut here: it is longer than a GitHub comment allows._\n" else . end | {body: .}' \
  "$body")

me=$(gh api user --jq .login)
id=$(gh api --paginate "repos/$repo/issues/$pr/comments?per_page=100" \
  --jq ".[] | select(.user.login == \"$me\" and (.body | startswith(\"$marker\"))) | .id" | awk 'NR == 1')

if [ -n "$id" ]; then
  printf '%s' "$payload" | gh api -X PATCH "repos/$repo/issues/comments/$id" --input - --silent
  echo "Plan comment updated."
else
  printf '%s' "$payload" | gh api -X POST "repos/$repo/issues/$pr/comments" --input - --silent
  echo "Plan comment posted."
fi
