#!/usr/bin/env bash
# For type checking only: link pi's own node_modules (pi-coding-agent, typebox, ...) as ./node_modules.
# At run time pi supplies these modules to extensions itself.
set -euo pipefail
cd "$(dirname "$0")/.."
dir=$(dirname "$(readlink -f "$(command -v pi)")")
root=""
while [ "$dir" != "/" ]; do
	managed=""
	# pi's own installer (pi.dev/install.sh): ~/.pi/agent/install/releases/<version>/node_modules
	if [ -f "$dir/install/current-version" ]; then managed="$dir/install/releases/$(cat "$dir/install/current-version")/node_modules"; fi
	for c in "$dir/node_modules" "$dir/lib/pi/node_modules" "$dir/lib/node_modules" $managed; do
		if [ -d "$c/@earendil-works/pi-coding-agent" ]; then root=$c; break 2; fi
	done
	if [ "$(basename "$dir")" = node_modules ] && [ -d "$dir/@earendil-works/pi-coding-agent" ]; then root=$dir; break; fi
	dir=$(dirname "$dir")
done
[ -n "$root" ] || { echo "cannot find pi's node_modules next to $(command -v pi)" >&2; exit 1; }
if [ -d node_modules ] && [ ! -L node_modules ]; then echo "node_modules is a directory (left from v1?): remove it first" >&2; exit 1; fi
ln -sfn "$root" node_modules
echo "node_modules -> $root"
