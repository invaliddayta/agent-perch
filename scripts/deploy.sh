#!/usr/bin/env bash
# For working on perch on the machine it runs on: deploy the committed HEAD of this checkout to a
# separate worktree (PERCH_APP, default ~/.perch/app) and run `perch install` from there, so the
# dashboard and the agents never run your work in progress. Arguments go to `perch install`
# (it remembers them in PERCH_HOME/install.json). Agents keep running; the dashboard restarts.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
APP=${PERCH_APP:-$HOME/.perch/app}
if ! git diff --quiet || ! git diff --cached --quiet; then
	echo "uncommitted changes: commit first" >&2
	exit 1
fi
REV=$(git rev-parse HEAD)
if [ -e "$APP/.git" ]; then
	git -C "$APP" checkout -q --detach "$REV"
else
	git worktree add -q --detach "$APP" "$REV"
fi
(cd "$APP/web" && bun install --frozen-lockfile >/dev/null)
if [ -d "$REPO/web/voice" ]; then ln -sfn "$REPO/web/voice" "$APP/web/voice"; fi # ~300 MB speech model, shared
(cd "$APP" && bun web/build.ts) # fail here, before the restart, if the page does not build
(cd "$APP" && bun bin/perch.ts install "$@")
echo "deployed $(git log -1 --format='%h %s' "$REV")"
