# ScrabbleBot

Two people (James and ooVrq) each run one main Claude session on this repo. Follow the workflow in [PLAN.md](PLAN.md) under "Working with Claude":

- **Main session coordinates, subagents build.** Start one subagent per story from the sprint board, using the brief template in PLAN.md. Don't write a story's code in the main session.
- **Keep the main context lean.** Big outputs (logs, SQL results, long test runs) stay in subagents; they report back a short summary.
- **Only the main session commits and pushes.** Subagents never do. `git pull` before starting a story; claim it on the sprint board and push the claim; tick it after the work is pushed.
- **Parallel subagents only for stories with separate files** (see "Parallel work" in PLAN.md).
- **Definition of done:** `npm test` passes and `npx tsc --noEmit` is clean in `bot/`, and the bot still plays a full match.

## Project map

- `bot/`: the bot (TypeScript, from the official starter kit). Run instructions are in [README.md](README.md).
- `STRATEGY.md`: rules (checked against the server source) and game theory.
- `ANALYSIS.md`, `analysis/`: match-history analysis. The database is `data/scrabble.db` (git-ignored; rebuild with `python3 analysis/pull_data.py`).

## Never

- Read, print, paste or commit bot tokens (`bot/.token-*`). If one leaks, generate a new one on the team page.
- Commit `data/`, `logs/`, `node_modules/` or `bot/.upstream/`.
