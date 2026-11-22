// VisionAssist feedback survey agent on the Flashpoint MCP.
//
// Claude Code (or a person) drives it one step at a time:
//   node survey-agent.mjs plan
//   node survey-agent.mjs panel --csv panel.csv --name "VisionAssist testers" [--yes]
//   node survey-agent.mjs draft [--brief survey-brief.md] [--yes]
//   node survey-agent.mjs revise --note "<change>" [--yes]
//   node survey-agent.mjs publish [--yes]            then: confirm --step publish [--yes]
//   node survey-agent.mjs preview [--yes]
//   node survey-agent.mjs send --panel "<exact panel name>" [--yes]   then: confirm --step send --panel "<name>" [--yes]
//   node survey-agent.mjs report | results | synthetic [-n 20] | status | compare   (paid ones need --yes)
//
// Safety gates: a step that costs more than $0.10 stops unless --yes is given; publishing and
// emailing people are two separate calls, and the "confirm" call needs the matching --step (and,
// for sending, the exact panel name again). Email addresses never appear in output or logs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PRICE = { tool_survey: 0.5, synthetic: 0.6, status: 0 };
const APPROVAL_LIMIT = 0.1;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export class ApprovalNeeded extends Error {}

export const maskEmails = (text) => String(text).replace(EMAIL, "<email>");

// Panel CSV: header row with name,email and any extra per-person details (e.g. role).
export function readPanel(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error(`${file} needs a header row and at least one person.`);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  if (!header.includes("name") || !header.includes("email")) throw new Error(`${file} needs name and email columns.`);
  const seen = new Set();
  return lines.slice(1).map((line, i) => {
    const cells = line.split(",").map((c) => c.trim());
    const row = Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ""]));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) throw new Error(`Row ${i + 2}: "${row.name}" has no valid email.`);
    const key = row.email.toLowerCase();
    if (seen.has(key)) throw new Error(`Row ${i + 2}: duplicate email for "${row.name}".`);
    seen.add(key);
    return row;
  });
}

// Find a key anywhere in a nested result (the surveys agent nests ids in varying places).
export function findKey(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (key in value && value[key] != null) return value[key];
  for (const child of Object.values(value)) {
    const found = findKey(child, key);
    if (found != null) return found;
  }
  return undefined;
}

export function agentText(result) {
  if (typeof result === "string") return result;
  for (const key of ["message", "response", "reply", "answer", "text", "content", "summary"]) {
    const value = findKey(result, key);
    if (typeof value === "string" && value.trim()) return value;
  }
  return JSON.stringify(result, null, 2);
}

const links = (text) => [...new Set(String(text).match(/https?:\/\/[^\s)"'<>\]]+/g) ?? [])];

export function createAgent({ client, stateFile = "state.json", runDir = "runs", resultDir = "results", yes = false, print = console.log }) {
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { spent: 0 };
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  function record(tool, args, result) {
    fs.mkdirSync(runDir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${tool}.json`;
    fs.writeFileSync(path.join(runDir, name), maskEmails(JSON.stringify({ tool, args, result }, null, 2)));
  }

  async function paid(tool, args, price, why) {
    if (price > APPROVAL_LIMIT && !yes) {
      throw new ApprovalNeeded(`Needs approval: ${why} costs $${price.toFixed(2)} of Flashpoint credit. Re-run with --yes after you agree.`);
    }
    const result = await client.call(tool, args);
    state.spent = Math.round(((state.spent ?? 0) + price) * 100) / 100;
    record(tool, args, result);
    save();
    return result;
  }

  // Every survey step stays on ONE conversation with the surveys agent.
  async function survey(brief, why) {
    const args = { brief };
    if (state.conversation_id) args.conversation_id = state.conversation_id;
    if (state.survey_id) args.survey_id = state.survey_id;
    const result = await paid("tool_survey", args, PRICE.tool_survey, why);
    state.conversation_id = findKey(result, "conversation_id") ?? state.conversation_id;
    state.survey_id = findKey(result, "survey_id") ?? state.survey_id;
    save();
    const text = maskEmails(agentText(result));
    print(text);
    return text;
  }

  function needPanel() {
    if (!state.panel) throw new Error("No panel yet. Run: panel --csv panel.csv --name \"<panel name>\"");
  }

  return {
    state,

    plan() {
      print([
        "VisionAssist feedback survey on Flashpoint (each surveys-agent step costs $0.50):",
        "  1. panel    create the first-party panel from panel.csv",
        "  2. draft    write the survey from survey-brief.md and show the questions",
        "  3. publish  then confirm --step publish",
        "  4. preview  how many people can receive it",
        "  5. send     then confirm --step send (emails real people, cannot be undone)",
        "  6. report   delivered / opened / responded",
        "  7. results  summary, breakdown by role, themes, CSV/XLSX links",
        "  8. synthetic + compare (optional, $0.60 + $0.50): synthetic low-vision personas vs. real answers",
        `State: panel=${state.panel ?? "-"} survey=${state.survey_id ?? "-"} conversation=${state.conversation_id ?? "-"} pending=${state.pending ?? "-"} spent=$${(state.spent ?? 0).toFixed(2)}`,
      ].join("\n"));
    },

    async panel(csv, name) {
      if (!name) throw new Error("Give the panel a name with --name.");
      const rows = readPanel(csv);
      const extra = Object.keys(rows[0]).filter((k) => k !== "name" && k !== "email");
      print(`Panel "${name}" with ${rows.length} people: ${rows.map((r) => r.name).join(", ")}`);
      const members = rows.map((r) => {
        const details = extra.filter((k) => r[k]).map((k) => `${k} ${r[k]}`).join(", ");
        return `${r.name} ${r.email}${details ? ` (${details})` : ""}`;
      });
      await survey(`Create a first-party panel called '${name}' with these members: ${members.join("; ")}. Use only these addresses.`,
        `creating panel "${name}" (${rows.length} people)`);
      state.panel = name;
      save();
    },

    async draft(briefFile = "survey-brief.md") {
      const brief = fs.readFileSync(briefFile, "utf8");
      return survey(`${brief}\n\nDraft this survey and show me every question. Do not publish it yet.`, "drafting the survey");
    },

    async revise(note) {
      if (!note) throw new Error("Say what to change with --note.");
      return survey(`Revise the draft survey: ${note}. Show me the updated questions. Do not publish yet.`, "revising the survey");
    },

    async publish() {
      const text = await survey("Publish the survey.", "asking the agent to publish");
      state.pending = "publish";
      save();
      print("\nThe agent may be asking to confirm publishing. If you agree: confirm --step publish");
      return text;
    },

    async preview() {
      needPanel();
      return survey(`How many people on the '${state.panel}' panel can receive this survey? Use preview_panel_audience and give me the number.`,
        "checking how many people can receive it");
    },

    async send(panelName) {
      needPanel();
      if (panelName !== state.panel) throw new Error(`To send, repeat the exact panel name with --panel "${state.panel}".`);
      const text = await survey(`Send the survey to the '${state.panel}' panel.`, `asking to email the "${state.panel}" panel`);
      state.pending = "send";
      save();
      print(`\nSending emails real people and cannot be undone. Check the count above. If you agree: confirm --step send --panel "${state.panel}"`);
      return text;
    },

    async confirm(step, panelName) {
      if (!step || step !== state.pending) throw new Error(`Nothing to confirm for "${step ?? ""}". Pending step: ${state.pending ?? "none"}.`);
      if (step === "send" && panelName !== state.panel) throw new Error(`Confirming a send needs --panel "${state.panel}".`);
      const text = await survey("confirm", `confirming the ${step} step`);
      delete state.pending;
      save();
      return text;
    },

    async report() {
      needPanel();
      return survey(`Show the send report for the '${state.panel}' panel: delivered, opened and responded.`, "getting the send report");
    },

    async results() {
      const text = await survey(
        "Summarise the results: the average of each rating question overall and by role, the most valued feature, " +
        "the main themes in the open questions with one short quote each, and give me CSV and XLSX export download links. " +
        "Do not include anyone's email address.",
        "summarising the results");
      fs.mkdirSync(resultDir, { recursive: true });
      fs.writeFileSync(path.join(resultDir, "summary.md"), text + "\n");
      fs.writeFileSync(path.join(resultDir, "links.txt"), links(text).join("\n") + "\n");
      print(`\nSaved ${resultDir}/summary.md and ${links(text).length} link(s) in ${resultDir}/links.txt`);
      return text;
    },

    async synthetic(count = 20) {
      if (!state.survey_id) throw new Error("Publish a survey first; the synthetic panel answers the same survey.");
      const result = await paid("panel", {
        action: "create_and_run", name: "Synthetic low-vision users", num_respondents: count, survey_id: state.survey_id,
        research_objective: "Adults with low vision or blindness who walk independently and would try a phone-camera " +
          "assistant that speaks obstacle alerts and answers questions about their surroundings.",
      }, PRICE.synthetic, `running ${count} synthetic low-vision personas through the survey (can take 30+ minutes)`);
      state.synthetic = { job_id: findKey(result, "job_id"), panel_id: findKey(result, "panel_id") };
      save();
      print(maskEmails(agentText(result)));
    },

    async status() {
      const job = state.synthetic?.job_id;
      if (!job) throw new Error("No synthetic panel job to check.");
      const result = await paid("panel", { action: "status", job_id: job }, PRICE.status, "checking the synthetic panel");
      print(maskEmails(agentText(result)));
    },

    async compare() {
      const id = state.synthetic?.panel_id ?? state.synthetic?.job_id;
      if (!id) throw new Error("Run synthetic first.");
      return survey(`Compare the answers from the '${state.panel}' panel with the synthetic low-vision panel (${id}) on the same survey. ` +
        "Where do real testers and synthetic low-vision users agree and differ, especially on trusting the alerts?",
        "comparing real and synthetic answers");
    },
  };
}

// The real client: one signed-in session, renewed once on a 401.
async function flashpointClient() {
  if (!fs.existsSync(new URL("./.env", import.meta.url)) && !process.env.FLASHPOINT_WALLET_KEY) {
    throw new Error("No wallet yet. Create it only after you agree: node flashpoint.mjs wallet");
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opt = options(process.argv.slice(2));
  const command = opt._[0] ?? "plan";
  const offline = command === "plan";
  try {
    const agent = createAgent({ client: offline ? null : await flashpointClient(), yes: opt.yes });
    const run = {
      plan: () => agent.plan(),
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
    }[command];
    if (!run) throw new Error(`Unknown command "${command}". Try: plan`);
    await run();
  } catch (error) {
    console.error(maskEmails(error.message));
    process.exitCode = error instanceof ApprovalNeeded ? 3 : 1;
  }
}
