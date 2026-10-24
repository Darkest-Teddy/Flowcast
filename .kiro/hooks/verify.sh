#!/usr/bin/env bash
# Fast checks run by the Flowcast agent's stop hook: Python pipeline tests and TypeScript typechecks.
# Prints one line per check so the agent sees failures without a wall of output.
# (The 36 s map simulation suite is left to `npm test`.)
set -u
root="$(cd "$(dirname "$0")/../.." && pwd)"
status=0

check() {
  local name="$1"; shift
  local output
  if output="$("$@" 2>&1)"; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    echo "$output" | tail -15
    status=1
  fi
}

python="$root/data-pipeline/.venv/bin/python"
[ -x "$python" ] || python=python3
check "python tests" bash -c "cd '$root/data-pipeline' && '$python' -m unittest discover -s tests -q"
[ -d "$root/map-client/node_modules" ] && check "map-client typecheck" bash -c "cd '$root/map-client' && npx tsc -b"
[ -d "$root/web/node_modules" ] && check "web typecheck" bash -c "cd '$root/web' && npx tsc -b"
exit $status
