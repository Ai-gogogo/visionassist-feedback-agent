// MCP server on top of the Flashpoint MCP: exposes the VisionAssist research agent as tools any MCP
// client (Claude Code, Cursor, ...) can call. Approval gates survive the wrap: a paid step answers
// NEEDS_APPROVAL until the client calls again with approve_spend: true after asking its user, and
// publishing, emailing and interview invitations still need a separate research_confirm call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createAgent, ApprovalNeeded, maskEmails, FOLLOWUP_STEPS } from "./agent.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEPS = ["context", "panel", "draft", "revise", "publish", "preview", "send", "report", "results", "synthetic",
  "status", "compare", "interview", "interview_invite", "interview_results", "skip_interview", "roadmap", "deck", "followup"];

export function createServer({ connect, dir = HERE } = {}) {
  let flashpoint;
  const client = {
    async call(tool, args) {
      flashpoint ??= await connect();
      return flashpoint.call(tool, args);
    },
  };

  // Run one agent call, capturing what it prints. Approval requests come back as plain text, not errors,
  // so the calling model relays the price to its user.
  async function run(fn, { approve = false, round = 1 } = {}) {
    const out = [];
    try {
      const agent = createAgent({ client, dir, yes: approve, round, print: (t) => out.push(String(t)) });
      await fn(agent);
      return { content: [{ type: "text", text: maskEmails(out.join("\n") || "Done.") }] };
    } catch (error) {
      const text = maskEmails([...out, error.message].join("\n"));
      if (error instanceof ApprovalNeeded) {
        const ask = text.replace("Re-run with --yes after you agree.", "Ask your user; if they agree, call again with approve_spend: true.");
        return { content: [{ type: "text", text: `NEEDS_APPROVAL: ${ask}` }] };
      }
      return { content: [{ type: "text", text }], isError: true };
    }
  }

  const server = new McpServer({ name: "visionassist-research", version: "1.0.0" });

  server.registerTool("research_plan", {
    title: "Research plan and next step",
    description: "Free. Shows the VisionAssist research pipeline (census context, first-party survey, synthetic low-vision panel, comparison, interviews, roadmap, deck), what is done, what is next, and credit spent.",
    inputSchema: { round: z.union([z.literal(1), z.literal(2)]).optional() },
    annotations: { readOnlyHint: true },
  }, ({ round }) => run((a) => a.plan(), { round }));

  server.registerTool("research_step", {
    title: "Run one research step",
    description: "Runs one step against the Flashpoint MCP. Steps over $0.10 return NEEDS_APPROVAL with the price: ask your user, then call again with approve_spend true. " +
      "'publish', 'send' and 'interview_invite' only ask Flashpoint; finish them with research_confirm after your user agrees. " +
      "'send' and 'interview_invite' need panel_name to equal the panel's exact name. Only add people the user listed in panel.csv.",
    inputSchema: {
      step: z.enum(STEPS),
      round: z.union([z.literal(1), z.literal(2)]).optional().describe("Use 2 for the follow-up survey and its subsequent steps."),
      approve_spend: z.boolean().optional().describe("True only after the user agreed to the quoted price."),
      csv: z.string().optional().describe("Panel CSV path (step 'panel'), default panel.csv"),
      panel_name: z.string().optional().describe("Panel name ('panel', 'send', 'interview_invite')"),
      note: z.string().optional().describe("Requested change (step 'revise')"),
      location: z.string().optional().describe("Place for census context (step 'context'), default New York, NY"),
      objective: z.string().trim().min(1).optional().describe("High-level research objective (step 'draft'). Flashpoint designs the questions."),
      min_responses: z.number().int().positive().optional().describe("Minimum submitted real replies before answering the objective (step 'draft', default 1)."),
      respondents: z.number().int().min(5).max(50).optional().describe("Synthetic personas (step 'synthetic'), default 20"),
    },
    annotations: { openWorldHint: true },
  }, ({ step, round = step === "followup" ? 2 : 1, approve_spend = false, csv, panel_name, note, location, objective, min_responses, respondents }) => run(async (a) => {
    if (round === 2 && !FOLLOWUP_STEPS.includes(step)) throw new Error("That step is not available for round two.");
    const calls = {
      context: () => a.context(location), panel: () => a.panel(path.resolve(dir, csv ?? "panel.csv"), panel_name),
      draft: () => a.draft(path.join(dir, "survey-brief.md"), { objective, minResponses: min_responses }),
      followup: () => a.followup(),
      revise: () => a.revise(note), publish: () => a.publish(),
      preview: () => a.preview(), send: () => a.send(panel_name), report: () => a.report(), results: () => a.results(),
      synthetic: () => a.synthetic(respondents ?? 20), status: () => a.status(), compare: () => a.compare(),
      interview: () => a.interview(path.join(dir, "interview-brief.md")), interview_invite: () => a.interviewInvite(panel_name),
      interview_results: () => a.interviewResults(), skip_interview: () => a.skipInterview(), roadmap: () => a.roadmap(), deck: () => a.deck(),
    };
    await calls[step]();
  }, { approve: approve_spend, round }));

  server.registerTool("research_confirm", {
    title: "Confirm publishing, emailing or interview invitations",
    description: "Sends 'confirm' to the Flashpoint agent for the pending step. Emailing people cannot be undone: call this only after your user explicitly agreed, " +
      "with the panel's exact name for 'send' and 'interview'. Costs $0.50 (needs approve_spend true).",
    inputSchema: {
      step: z.enum(["publish", "send", "interview"]),
      round: z.union([z.literal(1), z.literal(2)]).optional(),
      panel_name: z.string().optional(),
      approve_spend: z.boolean().optional(),
    },
    annotations: { destructiveHint: true, openWorldHint: true },
  }, ({ step, round, panel_name, approve_spend = false }) => run((a) => a.confirm(step, panel_name), { approve: approve_spend, round }));

  server.registerTool("research_artifacts", {
    title: "Read research outputs",
    description: "Free. Lists the files in results/ and returns the objective answer, roadmap, and summary (email addresses masked).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => {
    const folder = path.join(dir, "results");
    const files = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
    const read = (name) => (files.includes(name) ? `\n\n## ${name}\n${fs.readFileSync(path.join(folder, name), "utf8")}` : "");
    const followup = ["decision.json", "answer.md"].map((name) => {
      const file = path.join(folder, "followup", "results", name);
      return fs.existsSync(file) ? `\n\n## Follow-up ${name}\n${fs.readFileSync(file, "utf8")}` : "";
    }).join("");
    const text = files.length ? `Files: ${files.join(", ")}${read("answer.md")}${followup}${read("roadmap.md")}${read("summary.md")}` : "No results yet.";
    return { content: [{ type: "text", text: maskEmails(text) }] };
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { flashpointClient } = await import("./survey-agent.mjs");
  await createServer({ connect: flashpointClient }).connect(new StdioServerTransport());
}
