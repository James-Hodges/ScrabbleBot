#!/usr/bin/env bash
# Regenerate the SpacetimeDB client bindings in src/module_bindings.
#
# The bindings come from the game server's module source, which lives in the
# official repo. This clones (or updates) it into bot/.upstream, which git
# ignores, runs `spacetime generate` against it, and copies the server's
# wordlist into data/ so the bot uses the same dictionary as the server.
#
# Needs: git, npm, and the spacetime CLI (https://spacetimedb.com/install).
set -euo pipefail

cd "$(dirname "$0")/.."
UPSTREAM=.upstream
REPO=https://github.com/clockworklabs/scrabblebot

if [ -d "$UPSTREAM/.git" ]; then
  git -C "$UPSTREAM" pull --ff-only --quiet
else
  git clone --depth 1 --quiet "$REPO" "$UPSTREAM"
fi
echo "Upstream at $(git -C "$UPSTREAM" log --oneline -1)"

npm install --prefix "$UPSTREAM/spacetimedb" --silent
rm -rf src/module_bindings
spacetime generate --lang typescript \
  --out-dir src/module_bindings \
  --module-path "$UPSTREAM/spacetimedb" --yes
echo "Bindings written to src/module_bindings"

mkdir -p data
cp "$UPSTREAM/spacetimedb/wordlist.txt" data/wordlist.txt
echo "Wordlist copied to data/wordlist.txt ($(wc -l < data/wordlist.txt | tr -d ' ') words)"
