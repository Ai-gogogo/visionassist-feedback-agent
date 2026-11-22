# Instructions for Claude Code in this folder

You run a survey for the VisionAssist team through the Flashpoint MCP, using `survey-agent.mjs`. The person you work with decides; you do the steps and explain each in one or two plain sentences.

## How to run a step

- `node survey-agent.mjs plan` is free and shows where the survey stands. Start every session with it.
- Every other command calls the Flashpoint surveys agent. A step that costs more than $0.10 exits with code 3 and the message `Needs approval: … costs $0.50`. Tell the person the step and its price, and re-run with `--yes` only after they say yes in this conversation.
- `publish` and `send` only ask the surveys agent. Show the person what the agent said. Run `confirm --step publish`, or `confirm --step send --panel "<exact name>"`, only after they agree. Sending emails real people and cannot be undone: state the panel name and the sendable count from `preview` before asking.
- Results land in `results/summary.md` and `results/links.txt`.

## Never

- Never create the wallet (`node flashpoint.mjs wallet`) unless the person asks for it in this conversation.
- Never print, copy, commit or upload `.env`. It holds the wallet key.
- Never add an email address the person did not give you, and never print panel members' email addresses back.
- Never use `panel` with `action: "recruit"` or `payment_confirmation`: those pay for real outside respondents.
- Never commit `panel.csv`, `state.json`, `runs/` or `results/` (they are git-ignored).
