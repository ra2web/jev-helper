#!/bin/sh
# Start the local Laya decision server using the laya-vs-jev virtual environment.
# Set LAYA_REPO to point at a laya-vs-jev checkout; defaults to a sibling directory.
set -e
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="${LAYA_REPO:-$here/../laya-vs-jev}"
if [ ! -d "$repo" ]; then
  echo "laya-vs-jev repository not found at $repo. Set LAYA_REPO=/path/to/laya-vs-jev." >&2
  exit 1
fi
python="$repo/.venv/bin/python"
if [ -x "$python" ]; then
  exec "$python" "$here/tools/laya-server.py" --repo "$repo" "$@"
fi
if command -v uv >/dev/null 2>&1; then
  exec uv run --project "$repo" python "$here/tools/laya-server.py" --repo "$repo" "$@"
fi
echo "No Python environment found. Run 'uv sync' inside $repo first." >&2
exit 1
