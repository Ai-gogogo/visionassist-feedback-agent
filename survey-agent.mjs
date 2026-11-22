// CLI for the VisionAssist research agent. Claude Code (or a person) runs one step at a time:
//   node survey-agent.mjs plan                       free: the pipeline and what is next
//   node survey-agent.mjs next [--yes]               run the next stage of the pipeline
//   node survey-agent.mjs context [--location "New York, NY"] [--yes]
//   node survey-agent.mjs panel --csv panel.csv --name "VisionAssist testers" [--yes]
//   node survey-agent.mjs draft | revise --note "..." | publish | preview | report | results [--yes]
//   node survey-agent.mjs send --panel "<exact name>" [--yes]          then confirm --step send --panel "<name>"
//   node survey-agent.mjs confirm --step publish|send|interview [--panel "<name>"] [--yes]
//   node survey-agent.mjs synthetic [-n 20] | status | compare [--yes]
//   node survey-agent.mjs interview | interview-invite --panel "<name>" | interview-results | skip-interview
//   node survey-agent.mjs roadmap                    free: results/roadmap.md + results/dashboard.html
//   node survey-agent.mjs deck [--yes]               results deck (.pptx) via Flashpoint
//   node survey-agent.mjs issues --repo owner/name [--yes]   roadmap items as GitHub issues (dry run without --yes)
//   node survey-agent.mjs sample                     free: dashboard from sample data, for layout checks
//
// Gates: a step over $0.10 stops unless --yes; publishing, emailing and interview invitations each need a
// separate confirm with the matching step (and the exact panel name). Emails never appear in output or logs.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAgent, ApprovalNeeded, maskEmails } from "./agent.mjs";
import { buildDashboard, buildRoadmap } from "./report.mjs";
import { SAMPLE_RESULTS, SAMPLE_COMPARE } from "./sample-data.mjs";

export { createAgent, ApprovalNeeded, readPanel, maskEmails, findKey } from "./agent.mjs";

// The real client: one signed-in session, renewed once on a 401.
export async function flashpointClient() {
  if (!fs.existsSync(new URL("./.env", import.meta.url)) && !process.env.FLASHPOINT_WALLET_KEY) {
    throw new Error("No wallet yet. Put the organizers' key in .env as FLASHPOINT_WALLET_KEY=0x... (never commit it).");
  }
  const { connect, callTool } = await import("./flashpoint.mjs");
  let session = await connect();
  return {
    async call(tool, args) {
      try { return await callTool(session, tool, args); } catch (error) {
        if (!/401|expired/i.test(error.message)) throw error;
        session = await connect();
        return callTool(session, tool, args);
      }
    },
  };
}

function options(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--yes") out.yes = true;
    else if (arg.startsWith("--")) out[arg.slice(2)] = argv[++i];
    else if (arg === "-n") out.n = Number(argv[++i]);
    else out._.push(arg);
  }
  return out;
}

// Roadmap items as GitHub issues in the VisionAssist repo. Without --yes it only prints what it would create.
export function createIssues({ repo, yes, dir = ".", print = console.log, run = execFileSync }) {
  if (!repo) throw new Error("Name the repo with --repo owner/name.");
  const file = `${dir}/results/roadmap.md`;
  if (!fs.existsSync(file)) throw new Error("No roadmap yet. Run: roadmap");
  const rows = fs.readFileSync(file, "utf8").split("\n").filter((l) => /^\| \d+ \|/.test(l)).slice(0, 5)
    .map((l) => l.split("|").map((c) => c.trim()).filter(Boolean));
  for (const [n, title, severity, evidence] of rows) {
    const body = `From the VisionAssist user research (Flashpoint first-party panel).\n\nSeverity: ${severity}\nEvidence: ${evidence}`;
    if (!yes) { print(`Would create issue ${n}: ${title}`); continue; }
    print(String(run("gh", ["issue", "create", "--repo", repo, "--title", title, "--body", body], { encoding: "utf8" })).trim());
  }
  if (!yes) print(`Dry run. Re-run with --yes after you agree to create ${rows.length} issue(s) in ${repo}.`);
}

export function sampleDashboard({ dir = ".", print = console.log } = {}) {
  const roadmap = buildRoadmap({ results: SAMPLE_RESULTS, compare: SAMPLE_COMPARE });
  fs.mkdirSync(`${dir}/docs`, { recursive: true });
  fs.writeFileSync(`${dir}/docs/sample-dashboard.html`, buildDashboard({ results: SAMPLE_RESULTS, compare: SAMPLE_COMPARE,
    roadmap: roadmap.items, panel: "VisionAssist testers", sample: true }));
  fs.writeFileSync(`${dir}/docs/sample-roadmap.md`, roadmap.markdown);
  print("Wrote docs/sample-dashboard.html and docs/sample-roadmap.md (sample data, not real responses).");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opt = options(process.argv.slice(2));
  const command = opt._[0] ?? "plan";
  const offline = ["plan", "roadmap", "issues", "sample", "skip-interview"].includes(command);
  try {
    const agent = createAgent({ client: offline ? null : await flashpointClient(), yes: opt.yes });
    const steps = {
      plan: () => agent.plan(),
      context: () => agent.context(opt.location),
      panel: () => agent.panel(opt.csv ?? "panel.csv", opt.name),
      draft: () => agent.draft(opt.brief),
      revise: () => agent.revise(opt.note),
      publish: () => agent.publish(),
      preview: () => agent.preview(),
      send: () => agent.send(opt.panel),
      confirm: () => agent.confirm(opt.step, opt.panel),
      report: () => agent.report(),
      results: () => agent.results(),
      synthetic: () => agent.synthetic(opt.n || 20),
      status: () => agent.status(),
      compare: () => agent.compare(),
      interview: () => agent.interview(opt.brief),
      "interview-invite": () => agent.interviewInvite(opt.panel),
      "interview-results": () => agent.interviewResults(),
      "skip-interview": () => agent.skipInterview(),
      roadmap: () => agent.roadmap(),
      deck: () => agent.deck(),
      issues: () => createIssues({ repo: opt.repo, yes: opt.yes }),
      sample: () => sampleDashboard(),
      next: () => {
        const nxt = agent.next();
        if (!nxt) return agent.plan();
        if (["panel", "send"].includes(nxt.step)) {
          throw new Error(`Next: ${nxt.step}. It needs your input: ${nxt.step === "panel" ? "panel --csv panel.csv --name \"<name>\"" : `send --panel "${agent.state.panel}"`}`);
        }
        if (agent.state.pending) throw new Error(`Waiting for: confirm --step ${agent.state.pending}`);
        console.log(`Running: ${nxt.step} (${nxt.why})`);
        return steps[nxt.step]();
      },
    };
    const run = steps[command];
    if (!run) throw new Error(`Unknown command "${command}". Try: plan`);
    await run();
  } catch (error) {
    console.error(maskEmails(error.message));
    process.exitCode = error instanceof ApprovalNeeded ? 3 : 1;
  }
}
