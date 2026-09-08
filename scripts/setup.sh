#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" != "" && "${1:-}" != "--check" ]]; then
  echo 'Usage: bash scripts/setup.sh [--check]' >&2
  exit 2
fi

failures=0
missing() { echo "Setup prerequisite: $*" >&2; failures=$((failures + 1)); }
[[ "$(uname -s)" == Darwin ]] || missing 'This workflow requires macOS (including sips and its sRGB profile).'
if ! command -v node >/dev/null 2>&1; then
  missing 'Install Node.js 24.12.0; with nvm installed, run nvm install && nvm use in this folder.'
elif [[ "$(node --version)" != v24.12.0 ]]; then
  missing 'Select Node.js 24.12.0; run nvm install && nvm use in this folder.'
fi
if ! command -v npm >/dev/null 2>&1; then
  missing 'npm 11.6.2 is required with the pinned Node runtime.'
elif [[ "$(npm --version)" != 11.6.2 ]]; then
  missing 'Select npm 11.6.2; install it in the selected Node runtime with npm install --global npm@11.6.2.'
fi
if ! command -v python3.11 >/dev/null 2>&1; then
  missing 'Install Python 3.11 and make python3.11 available on PATH.'
elif ! python3.11 -c 'import sys; assert sys.version_info[:2] == (3, 11)' >/dev/null 2>&1; then
  missing 'python3.11 must resolve to a Python 3.11 interpreter.'
fi
for executable in "${REEL_FFMPEG_PATH:-ffmpeg}" "${REEL_FFPROBE_PATH:-ffprobe}"; do
  command -v "$executable" >/dev/null 2>&1 || missing "Install $executable with the pipeline filters and codecs listed in README.md."
done
if [[ -e .venv && ! -x .venv/bin/python ]]; then
  missing 'The existing .venv is incomplete. Move it aside and rerun setup to create a Python 3.11 environment.'
elif [[ -x .venv/bin/python ]] && ! .venv/bin/python -c 'import sys; assert sys.version_info[:2] == (3, 11)' >/dev/null 2>&1; then
  missing 'The existing .venv does not use Python 3.11. Move it aside and rerun setup.'
fi
[[ "$failures" == 0 ]] || exit 1
echo 'Prerequisites passed. Setup installs only project dependencies and the Remotion browser.'
[[ "${1:-}" != --check ]] || exit 0

npm ci
if [[ ! -d .venv ]]; then python3.11 -m venv .venv; fi
.venv/bin/python -m pip install -r requirements.txt
npx remotion browser ensure
npm run reel -- doctor
