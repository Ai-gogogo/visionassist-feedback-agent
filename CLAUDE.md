# Instructions for Claude Code in this folder

You run the VisionAssist research study through the Flashpoint MCP. Use the `visionassist-research` MCP tools from `.mcp.json` (or the same steps through `node survey-agent.mjs`). The person decides; you do the steps and explain each in one or two plain sentences.

## How to run the study

- Start with `research_plan` (or `node survey-agent.mjs plan`): it is free and shows what is done and what comes next.
- A paid step answers `NEEDS_APPROVAL: … costs $X` (CLI: exit code 3). Tell the person the step and the price, and call again with `approve_spend: true` (CLI: `--yes`) only after they say yes in this conversation.
- `publish`, `send` and `interview_invite` only ask Flashpoint. Show the person what Flashpoint said, then use `research_confirm` (CLI: `confirm --step …`) only after they agree.
- Sending emails real people and cannot be undone. Before asking, run `preview` and state the panel name and the sendable count.
- `roadmap` is free and writes `results/roadmap.md` and `results/dashboard.html`. Creating GitHub issues (`issues --repo … --yes`) is a separate, explicit request.

## Never

- Never print, copy, commit or upload `.env`. It holds the wallet key. Never create a new wallet unless the person asks.
- Never add an email address the person did not give you, and never print panel members' email addresses back.
- Never use `panel` with `action: "recruit"` or `payment_confirmation`: those pay for real outside respondents.
- Never present `docs/sample-*` or `sample-data.mjs` numbers as real results.
- Never commit `panel.csv`, `state.json`, `runs/` or `results/` (they are git-ignored).
