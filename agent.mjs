// Core of the VisionAssist research agent. The CLI (survey-agent.mjs), the MCP server (mcp-server.mjs)
// and the tests all drive this one object. It never talks to the network itself: `client.call(tool, args)`
// is injected (the real one pays Flashpoint over x402, the tests use a fake).
import fs from "node:fs";
import path from "node:path";
import { buildDashboard, buildRoadmap, extractJson } from "./report.mjs";

// Prices from the Flashpoint hackathon manual (USD per call).
export const PRICE = { tool_survey: 0.5, tool_qual: 0.5, synthetic: 0.6, status: 0, demographics: 0.05, presentation: 0.25 };
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

// Find a key anywhere in a nested result (the Flashpoint agents nest ids in varying places).
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

export const links = (text) => [...new Set(String(text).match(/https?:\/\/[^\s)"'<>\]]+/g) ?? [])];

// The research pipeline, in order. `done` says whether a stage is finished; `next` reads it.
export const STAGES = [
  ["context", "census context for the people VisionAssist serves", (s) => s.context],
  ["panel", "first-party panel of consenting testers", (s) => s.panel],
  ["draft", "survey drafted and reviewed", (s) => s.drafted],
  ["publish", "survey published (then confirm --step publish)", (s) => s.published],
  ["preview", "sendable count checked", (s) => s.previewed],
  ["send", "survey emailed (then confirm --step send)", (s) => s.sent],
  ["report", "replies tracked", (s) => s.reported],
  ["results", "results summarised with structured data", (s) => s.results],
  ["synthetic", "synthetic low-vision personas answered the same survey", (s) => s.synthetic],
  ["compare", "real vs. synthetic comparison", (s) => s.compared],
  ["interview", "AI-moderated interview guide (optional)", (s) => s.interview?.designed || s.skipInterview],
  ["roadmap", "roadmap and dashboard written", (s) => s.roadmap],
  ["deck", "results deck (.pptx)", (s) => s.deck],
];

export function createAgent({ client, dir = ".", yes = false, print = console.log }) {
  const at = (...p) => path.join(dir, ...p);
  const stateFile = at("state.json");
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { spent: 0 };
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const write = (name, text) => {
    fs.mkdirSync(at("results"), { recursive: true });
    fs.writeFileSync(at("results", name), text);
    return path.join("results", name);
  };

  function record(tool, args, result) {
    fs.mkdirSync(at("runs"), { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${tool}.json`;
    fs.writeFileSync(at("runs", name), maskEmails(JSON.stringify({ tool, args, result }, null, 2)));
  }

  async function paid(tool, args, price, why) {
    if (price > APPROVAL_LIMIT && !yes) {
      throw new ApprovalNeeded(`Needs approval: ${why} costs $${price.toFixed(2)} of Flashpoint credit. Re-run with --yes after you agree.`);
    }
    if (!client) throw new Error("No Flashpoint connection.");
    const result = await client.call(tool, args);
    state.spent = Math.round(((state.spent ?? 0) + price) * 100) / 100;
    record(tool, args, result);
    save();
    return result;
  }

  // Multi-turn Flashpoint agents: every step stays on ONE conversation per agent.
  const CHANNEL = {
    survey: { tool: "tool_survey", conv: "conversation_id", id: "survey_id" },
    qual: { tool: "tool_qual", conv: "qual_conversation_id", id: "study_id" },
  };
  async function converse(channel, brief, why) {
    const { tool, conv, id } = CHANNEL[channel];
    const args = { brief };
    if (state[conv]) args.conversation_id = state[conv];
    if (state[id]) args[id] = state[id];
    const result = await paid(tool, args, PRICE[tool], why);
    state[conv] = findKey(result, "conversation_id") ?? state[conv];
    state[id] = findKey(result, id) ?? state[id];
    save();
    const text = maskEmails(agentText(result));
    print(text);
    return text;
  }
  const survey = (brief, why) => converse("survey", brief, why);

  function needPanel() {
    if (!state.panel) throw new Error("No panel yet. Run: panel --csv panel.csv --name \"<panel name>\"");
  }

  const agent = {
    state,

    next() {
      const stage = STAGES.find(([, , done]) => !done(state));
      return stage ? { step: stage[0], why: stage[1] } : null;
    },

    plan() {
      const lines = ["VisionAssist research pipeline (surveys/interview steps $0.50, census $0.05, synthetic $0.60, deck $0.25):"];
      for (const [step, why, done] of STAGES) lines.push(`  [${done(state) ? "x" : " "}] ${step.padEnd(9)} ${why}`);
      const nxt = agent.next();
      lines.push(nxt ? `Next: ${nxt.step} (${nxt.why})` : "Pipeline complete.");
      if (state.pending) lines.push(`Waiting for: confirm --step ${state.pending}`);
      lines.push(`Spent: $${(state.spent ?? 0).toFixed(2)}`);
      print(lines.join("\n"));
    },

    async context(location = "New York, NY") {
      const result = await paid("demographics", {
        location,
        question: "How many adults have a vision difficulty (ACS disability data), what share are 65 or older, and how many live alone?",
        audience: "Adults with low vision or blindness who walk independently",
      }, PRICE.demographics, `census context for ${location}`);
      const text = maskEmails(agentText(result));
      state.context = write("context.md", `# Who VisionAssist serves: ${location}\n\n${text}\n`);
      save();
      print(text);
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
      state.panelSize = rows.length;
      save();
    },

    async draft(briefFile = "survey-brief.md") {
      const text = await survey(`${fs.readFileSync(briefFile, "utf8")}\n\nDraft this survey and show me every question. Do not publish it yet.`, "drafting the survey");
      state.drafted = true;
      save();
      return text;
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
      const text = await survey(`How many people on the '${state.panel}' panel can receive this survey? Use preview_panel_audience and give me the number.`,
        "checking how many people can receive it");
      state.previewed = true;
      save();
      return text;
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
      if ((step === "send" || step === "interview") && panelName !== state.panel) {
        throw new Error(`Confirming ${step === "send" ? "a send" : "interview invitations"} needs --panel "${state.panel}".`);
      }
      const channel = step === "interview" ? "qual" : "survey";
      const text = await converse(channel, "confirm", `confirming the ${step} step`);
      if (step === "publish") state.published = true;
      if (step === "send") state.sent = true;
      if (step === "interview") state.interview = { ...state.interview, sent: true };
      delete state.pending;
      save();
      return text;
    },

    async report() {
      needPanel();
      const text = await survey(`Show the send report for the '${state.panel}' panel: delivered, opened and responded.`, "getting the send report");
      state.reported = true;
      save();
      return text;
    },

    async results() {
      const text = await survey(
        "Summarise the results: the average of each rating question overall and by role, the alert timing answers, the most valued feature, " +
        "the main themes in the open question with one short quote each, and give me CSV and XLSX export download links. " +
        "Do not include anyone's email address. At the end, add one JSON object between <results-json> and </results-json> with exactly: " +
        '{"respondents": number, "ratings": {"<question>": {"overall": number, "by_role": {"<role>": number}}}, ' +
        '"timing": {"<answer>": count}, "features": {"<feature>": count}, ' +
        '"themes": [{"theme": string, "mentions": number, "quote": string}], ' +
        '"fixes": [{"fix": string, "mentions": number, "severity": "high"|"medium"|"low"}]}.',
        "summarising the results");
      const data = extractJson(text, "results-json");
      write("summary.md", text + "\n");
      write("links.txt", links(text).join("\n") + "\n");
      if (data) write("results.json", JSON.stringify(data, null, 2));
      state.results = true;
      save();
      print(`\nSaved results/summary.md${data ? ", results/results.json" : " (no structured JSON found; roadmap will use the summary text)"} and ${links(text).length} link(s).`);
      return text;
    },

    async synthetic(count = 20) {
      if (!state.survey_id) throw new Error("Publish a survey first; the synthetic panel answers the same survey.");
      const result = await paid("panel", {
        action: "create_and_run", name: "Synthetic low-vision users", num_respondents: count, survey_id: state.survey_id,
        research_objective: "Adults with low vision or blindness who walk independently and would try a phone-camera " +
          "assistant that speaks obstacle alerts and answers questions about their surroundings.",
      }, PRICE.synthetic, `running ${count} synthetic low-vision personas through the survey (can take 30+ minutes)`);
      state.synthetic = { job_id: findKey(result, "job_id"), panel_id: findKey(result, "panel_id"), count };
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
      const text = await survey(`Compare the answers from the '${state.panel}' panel with the synthetic low-vision panel (${id}) on the same survey. ` +
        "Where do real testers and synthetic low-vision users agree and differ, especially on trusting the alerts and on alert timing? " +
        "At the end, add one JSON object between <compare-json> and </compare-json> with exactly: " +
        '{"agreements": [string], "differences": [{"topic": string, "real": string, "synthetic": string}]}.',
        "comparing real and synthetic answers");
      const data = extractJson(text, "compare-json");
      write("compare.md", text + "\n");
      if (data) write("compare.json", JSON.stringify(data, null, 2));
      state.compared = true;
      save();
      return text;
    },

    // AI-moderated interviews (Flashpoint tool_qual) on their own conversation.
    async interview(briefFile = "interview-brief.md") {
      const text = await converse("qual", `${fs.readFileSync(briefFile, "utf8")}\n\nDesign this AI-moderated interview study and show me the guide. Do not launch or invite anyone yet.`,
        "designing the AI-moderated interview");
      state.interview = { ...state.interview, designed: true };
      save();
      return text;
    },

    async interviewInvite(panelName) {
      needPanel();
      if (!state.interview?.designed) throw new Error("Design the interview first: interview");
      if (panelName !== state.panel) throw new Error(`To invite, repeat the exact panel name with --panel "${state.panel}".`);
      const text = await converse("qual", `Launch the interview study and invite the members of the '${state.panel}' panel who opted in. Tell me how many will be invited.`,
        `asking to invite the "${state.panel}" panel to interviews`);
      state.pending = "interview";
      save();
      print(`\nInviting emails real people. If you agree: confirm --step interview --panel "${state.panel}"`);
      return text;
    },

    async interviewResults() {
      if (!state.interview?.designed) throw new Error("No interview study yet.");
      const text = await converse("qual", "Summarise the interviews so far: key themes, one short quote each, and anything that contradicts the survey. Do not include email addresses.",
        "summarising the interviews");
      write("interviews.md", text + "\n");
      state.interview = { ...state.interview, summarised: true };
      save();
      return text;
    },

    skipInterview() {
      state.skipInterview = true;
      save();
      print("Interview stage skipped.");
    },

    // Free and local: turn the results into a prioritised VisionAssist roadmap and an accessible dashboard.
    roadmap() {
      const read = (name) => (fs.existsSync(at("results", name)) ? fs.readFileSync(at("results", name), "utf8") : null);
      const results = read("results.json") ? JSON.parse(read("results.json")) : null;
      const compare = read("compare.json") ? JSON.parse(read("compare.json")) : null;
      if (!results && !read("summary.md")) throw new Error("No results yet. Run: results");
      const roadmap = buildRoadmap({ results, compare, summary: read("summary.md") });
      write("roadmap.md", roadmap.markdown);
      write("dashboard.html", buildDashboard({ results, compare, context: read("context.md"), interviews: read("interviews.md"),
        roadmap: roadmap.items, panel: state.panel, sample: Boolean(results?.sample) }));
      state.roadmap = true;
      save();
      print(`Wrote results/roadmap.md (${roadmap.items.length} items) and results/dashboard.html`);
      return roadmap;
    },

    async deck() {
      const read = (name) => (fs.existsSync(at("results", name)) ? fs.readFileSync(at("results", name), "utf8") : "");
      const dataContext = [read("context.md"), read("summary.md"), read("compare.md"), read("interviews.md"), read("roadmap.md")]
        .filter(Boolean).join("\n\n").slice(0, 12000);
      if (!dataContext) throw new Error("Nothing to present yet. Run results and roadmap first.");
      const result = await paid("presentation", {
        title: "VisionAssist: what our testers told us",
        data_context: maskEmails(dataContext),
        custom_instructions: "High contrast, large text, one finding per slide. End with the prioritised roadmap. No email addresses.",
        max_slides: 10,
      }, PRICE.presentation, "making the results deck (.pptx)");
      const text = maskEmails(agentText(result));
      const found = links(JSON.stringify(result)).concat(links(text));
      state.deck = found[0] ?? true;
      write("deck-links.txt", [...new Set(found)].join("\n") + "\n");
      save();
      print(text);
    },
  };
  return agent;
}
