# VisionAssist Feedback Agent

A Claude Code agent that runs a real user-feedback survey for **VisionAssist**, our student prototype that helps people with low vision, on the **Flashpoint MCP**. You talk to Claude Code in plain language; it builds a first-party panel of testers who agreed to take part, drafts and publishes the survey, emails it, tracks replies and returns the findings. It can also run a synthetic panel of AI low-vision personas through the same survey and compare their answers with the real ones. Every request is paid from a hackathon USDC wallet over x402.

## Why this agent

VisionAssist uses two phone cameras and a laptop. It speaks obstacle alerts such as "Caution, chair straight ahead, about 1 meter", and a local LLM answers questions like "What is in front of me?" or "Why did you warn me?". Before our final demo we need evidence, not opinions: are the alerts clear and early enough, are the answers useful, and would people trust the system? This agent collects that evidence from the people who tried the demo, and uses synthetic low-vision personas to show where our sighted testers might be misleading us.

## How it works

```
You ──chat──▶ Claude Code ──runs──▶ survey-agent.mjs ──x402-paid MCP calls──▶ Flashpoint MCP
                  ▲                     │  tool_survey (one conversation_id)        │
                  └── asks you before ──┘  panel create_and_run (synthetic)          ├─ first-party panel
                      paying, publishing   state.json, runs/, results/               ├─ survey design + publish
                      or emailing people                                             ├─ email + send report
                                                                                     └─ analysis + CSV/XLSX
```

- `flashpoint.mjs`: the organizers' starter, unchanged. It creates the wallet, signs in, and pays for each MCP tool call over x402.
- `survey-agent.mjs`: the agent's steps (`panel`, `draft`, `revise`, `publish`, `preview`, `send`, `confirm`, `report`, `results`, `synthetic`, `status`, `compare`). It keeps the surveys agent on one `conversation_id` and saves state in `state.json`.
- `survey-brief.md`: the seven questions about alert clarity, alert timing, answer usefulness, trust and the most valued feature, with results broken down by role.
- `CLAUDE.md`: how Claude Code drives the agent and what it must never do.

## Safety by design

| Gate | What happens |
| --- | --- |
| Spending | A step over $0.10 stops with exit code 3 and the price; it runs only when re-run with `--yes` after you agree. |
| Publishing | `publish` only asks; a separate `confirm --step publish` publishes. |
| Emailing people | `send` needs the exact panel name, and the separate `confirm --step send` needs it again. Run `preview` first for the sendable count. |
| Privacy | Email addresses are masked in all output, run logs and saved results. `panel.csv`, `state.json`, `runs/` and `results/` are git-ignored. |
| Wallet key | Never printed. The agent refuses to connect when there is no wallet, instead of creating one silently. |
| Consent | Only people who agreed to take part go on the panel; every email has an unsubscribe link. The agent never uses paid recruitment. |

## Run it

Requirements: Node.js 18 or newer, and a funded Flashpoint hackathon wallet.

```sh
npm install
node flashpoint.mjs wallet       # once: prints the 0x address to send to the organizers (the key stays in .env)
node flashpoint.mjs balance      # free: check that credit arrived
cp panel.example.csv panel.csv   # replace with real testers who agreed: name,email,role
node survey-agent.mjs plan       # free: the steps and the current state
```

Then, step by step (each paid step is $0.50 and needs `--yes`):

```sh
node survey-agent.mjs panel --csv panel.csv --name "VisionAssist testers" --yes
node survey-agent.mjs draft --yes
node survey-agent.mjs publish --yes && node survey-agent.mjs confirm --step publish --yes
node survey-agent.mjs preview --yes
node survey-agent.mjs send --panel "VisionAssist testers" --yes
node survey-agent.mjs confirm --step send --panel "VisionAssist testers" --yes
node survey-agent.mjs report --yes
node survey-agent.mjs results --yes
node survey-agent.mjs synthetic -n 20 --yes && node survey-agent.mjs compare --yes   # optional
```

In practice you do not type these: open Claude Code in this folder and say "Run the VisionAssist feedback survey for my testers". Claude Code follows `CLAUDE.md`, asks before each paid, publishing or emailing step, and reports the results.

Expected cost: about $5 for the full run with the synthetic comparison (≈ 9 surveys-agent steps at $0.50 plus $0.60).

## Tests

```sh
npm test
```

Eight offline tests use a fake Flashpoint client (no wallet, no network, no credit). They check the spending gate, the publish and send confirmations, the single conversation, email masking in output and logs, saved results and links, the synthetic-panel flow, and panel CSV validation.

## Demo script (2–3 minutes)

1. Show VisionAssist speaking an obstacle alert and answering "What is in front of me?" (10 s).
2. In Claude Code: "Run the VisionAssist feedback survey for my testers." Claude creates the panel and shows the drafted questions.
3. Ask for one change, approve publishing, check the sendable count, approve sending.
4. Show a tester's inbox: the survey email with its unsubscribe link.
5. "Summarise the results by role." Show the averages, the top feature and the themes.
6. "Compare with synthetic low-vision users." Show where real testers and synthetic users differ on trusting the alerts.
7. Close with one change we made to VisionAssist because of the results.

## Limitations

- Testers are mostly sighted classmates; the synthetic panel is a stand-in for low-vision users, not a replacement for them.
- The Flashpoint surveys agent's reply format may change; the agent reads ids and text defensively and keeps the raw (masked) replies in `runs/`.
- VisionAssist itself is a research demo, not a validated mobility aid.
