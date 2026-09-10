# AI Berkshire Codex Guide

This repository contains investment research workflows, reports, and shared
validation tools. Keep compatibility with both Claude Code and Codex users.

## Project Layout

- `skills/*.md`: Claude Code slash-command source files.
- `codex-skills/*/SKILL.md`: Codex skill packages. Most are generated from
  `skills/*.md`; Codex-only hand-written packages are allowed when clearly
  marked and no same-named `skills/*.md` source exists.
- `codex-prompts/*.md`: generated Codex custom prompts for slash-command
  style entry points. These are a compatibility layer; skills remain preferred.
- `tools/*.py`: shared financial validation and data tools used by both systems.
- `reports/`: research outputs. Do not rewrite unrelated reports while changing
  tooling or skills.
- `scripts/sync-codex-skills.py`: regenerates Codex skills from `skills/*.md`.
- `scripts/install-codex-skills.sh` / `scripts/install-codex-skills.bat`:
  installs Codex skills locally.
- `scripts/install-codex-prompts.sh` / `scripts/install-codex-prompts.bat`:
  installs generated Codex slash prompts locally.
- `scripts/install-claude-commands.sh` / `scripts/install-claude-commands.bat`:
  installs Claude Code commands locally.

## Compatibility Rules

- Treat `skills/*.md` as the canonical workflow source.
- After changing any file in `skills/`, run:
  `python3 scripts/sync-codex-skills.py`
- If slash prompt compatibility is needed, also run:
  `python3 scripts/sync-codex-prompts.py`
- Do not manually edit generated `codex-skills/*/SKILL.md` unless also updating
  the corresponding source in `skills/`.
- For Codex-only hand-written packages under `codex-skills/`, keep them clearly
  marked as Codex-only and do not create a same-named `skills/*.md` file unless
  intentionally adopting the workflow for Claude Code too.
- Keep tool paths compatible with the documented checkout path:
  `~/ai-berkshire/tools/...`
- Keep `CLAUDE.md` for Claude Code behavior and this `AGENTS.md` for Codex
  behavior.

## Research Quality Rules

- Before starting any research, run the `date` command to confirm today's
  date. Treat that date as the baseline for "latest" data (prices, market cap,
  most recent filings), and state the data cutoff date in the report header.
  Never assume the current date from training data.
- Financial data must come from at least two independent sources when the skill
  requires verification.
- Use exact arithmetic tools for market cap, valuation, cross-source checks, and
  scenario analysis:
  `python3 tools/financial_rigor.py ...`
- Use report audit tooling before treating generated research as publishable:
  `python3 tools/report_audit.py ...`
- Clearly label low-confidence conclusions, incomplete data, and source gaps.
- This project is for learning and research, not investment advice.

## Cost Discipline

Long research runs are the main cost driver. Measured ledger from one machine: a
single 654-call session averaged **88.8k tokens of context per call** and alone
consumed 51.8% of all spend. Cost splits roughly as: re-sent context 29%,
newly-added content 40%, output+reasoning 31%. Cache hit rate (89%) and model
pricing are already optimal, so the only real lever left is
**call count × context size**.

Hard rules:

- **Split long tasks by phase into separate sessions.** Write intermediates to
  disk; the next session reads only the slice it needs. A several-hundred-turn
  marathon session is the most expensive way to work.
- **Compact at 60k tokens**, do not wait for automatic compaction. pi reports
  `deepseek-v4-flash` with a 1,000,000-token window, so the built-in threshold
  (`window - reserveTokens`) sits near 984k and effectively never fires.
- **Delegate reading and searching to subagents.** Raw search noise kept in the
  main session is re-read on every later call. The `subagent` tool plus the four
  research agents in `pi-toolkit/agents/` keep the main session small. Each
  dispatch costs ~4.2k input tokens of fixed overhead, so do not use it for
  trivial tasks.
- **Route mechanical work to cheap tiers** (data fetching, screening, formatting)
  and reserve the expensive tier for final judgment and prose.
- Do not `/reload` or edit `skills/` or `AGENTS.md` mid-session; it invalidates
  the prompt prefix cache.

Tooling and acceptance thresholds: `pi-toolkit/README.md`.
Inspect real spend with `/cost`, live context with `/guard`.

## Editing Rules

- Preserve existing report files unless the task specifically asks to change
  them.
- Keep changes scoped to the requested skill, tool, script, or documentation.
- Before finishing a skill/tool change, run the relevant syntax or generation
  check. For compatibility changes, run:
  `python3 scripts/sync-codex-skills.py`
- To verify generated Codex artifacts are current without rewriting files, run:
  `python3 scripts/sync-codex-skills.py --check`
  and, when slash prompts are relevant:
  `python3 scripts/sync-codex-prompts.py --check`
