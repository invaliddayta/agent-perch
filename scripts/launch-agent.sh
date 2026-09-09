#!/bin/sh
# Perch releases this gate after installing pane identity and event observation.
"$PERCH_BUN" --no-env-file "${0%/*}/await-observer.ts"
exec "$@"
