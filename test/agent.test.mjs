// Offline tests with a fake Flashpoint client: no wallet, no network, no credit spent.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAgent, ApprovalNeeded, readPanel, maskEmails, findKey } from "../agent.mjs";
import { buildRoadmap, extractJson } from "../report.mjs";
import { createIssues } from "../survey-agent.mjs";
import { createServer } from "../mcp-server.mjs";
import { SAMPLE_RESULTS, SAMPLE_COMPARE } from "../sample-data.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-agent-"));
  for (const f of ["survey-brief.md", "interview-brief.md"]) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "panel.csv"), "name,email,role\nAda Lee,ada@example.org,teammate\nBo Chen,bo@example.org,classmate\n");
  return dir;
}

function fakeClient(reply = () => ({ conversation_id: "conv-1", survey_id: "srv-1", message: "Done." })) {
  const calls = [];
  return { calls, call: async (tool, args) => { calls.push({ tool, args }); return reply(tool, args); } };
}

function setup({ yes = true, reply } = {}) {
  const dir = workspace();
  const client = fakeClient(reply);
  const printed = [];
  const agent = createAgent({ client, dir, yes, print: (t) => printed.push(t) });
  return { dir, calls: client.calls, printed, agent, csv: path.join(dir, "panel.csv") };
}

test("paid steps stop without --yes and spend nothing", async () => {
  const { agent, calls, csv } = setup({ yes: false });
  await assert.rejects(agent.panel(csv, "Testers"), ApprovalNeeded);
  await assert.rejects(agent.draft(), /costs \$0\.50/);
  assert.equal(calls.length, 0);
  assert.equal(agent.state.spent, 0);
});

test("census context is cheap enough to run without approval", async () => {
  const { agent, calls, dir } = setup({ yes: false, reply: () => ({ message: "About 120,000 adults in NYC report a vision difficulty." }) });
  await agent.context();
  assert.equal(calls[0].tool, "demographics");
  assert.match(fs.readFileSync(path.join(dir, "results", "context.md"), "utf8"), /vision difficulty/);
  assert.equal(agent.state.spent, 0.05);
});

test("panel sends emails to Flashpoint but never prints or logs them", async () => {
  const { agent, calls, printed, csv, dir } = setup({ reply: () => ({ conversation_id: "conv-1", message: "Panel ready with ada@example.org and bo@example.org" }) });
  await agent.panel(csv, "Testers");
  assert.match(calls[0].args.brief, /Ada Lee ada@example\.org \(role teammate\)/);
  assert.ok(printed.every((t) => !/@example\.org/.test(t)), "no email in output");
  const logs = fs.readdirSync(path.join(dir, "runs")).map((f) => fs.readFileSync(path.join(dir, "runs", f), "utf8")).join("");
  assert.ok(!/@example\.org/.test(logs), "no email in run logs");
  assert.equal(agent.state.panel, "Testers");
});

test("survey steps share one conversation; next() walks the pipeline", async () => {
  const { agent, calls, csv } = setup();
  assert.equal(agent.next().step, "context");
  await agent.context();
  await agent.panel(csv, "Testers");
  await agent.draft();
  assert.equal(calls.at(-1).args.conversation_id, "conv-1");
  assert.equal(calls.at(-1).args.survey_id, "srv-1");
  assert.equal(agent.next().step, "publish");
});

test("publishing needs a separate confirm for the publish step", async () => {
  const { agent, calls, csv } = setup();
  await agent.panel(csv, "Testers");
  await agent.publish();
  await assert.rejects(agent.confirm("send", "Testers"), /Pending step: publish/);
  await agent.confirm("publish");
  assert.equal(calls.at(-1).args.brief, "confirm");
  assert.equal(agent.state.published, true);
});

test("sending needs the exact panel name twice", async () => {
  const { agent, calls, csv } = setup();
  await agent.panel(csv, "Testers");
  await assert.rejects(agent.send("testers"), /exact panel name/);
  await agent.send("Testers");
  await assert.rejects(agent.confirm("send", "Other"), /needs --panel "Testers"/);
  await agent.confirm("send", "Testers");
  assert.equal(calls.at(-1).args.brief, "confirm");
  assert.equal(agent.state.sent, true);
});

test("results keep structured JSON, links, and no emails", async () => {
  const json = JSON.stringify(SAMPLE_RESULTS);
  const { agent, dir } = setup({ reply: () => ({ message: `Avg clarity 4.3 (x@example.org). CSV: https://files.example/r.csv\n<results-json>${json}</results-json>` }) });
  await agent.results();
  assert.match(fs.readFileSync(path.join(dir, "results", "summary.md"), "utf8"), /<email>/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "results", "results.json"), "utf8")).respondents, 12);
  assert.match(fs.readFileSync(path.join(dir, "results", "links.txt"), "utf8"), /r\.csv/);
});

test("an objective drives the draft and survives until enough real replies can answer it", async () => {
  const objective = "Which alert wording should we improve first?";
  const answer = {
    conclusion: "Lead with the obstacle location.",
    evidence: ["Two of three respondents preferred location first."],
    limitations: "Only three respondents participated.",
  };
  let result = { respondents: 1, objective_answer: answer };
  const dir = workspace();
  const client = fakeClient((_, { brief }) => ({
    conversation_id: "conv-1",
    survey_id: "srv-1",
    message: brief.startsWith("Original research objective:")
      ? `<results-json>${JSON.stringify(result)}</results-json>`
      : "Done.",
  }));
  const { calls } = client;
  const agent = createAgent({ client, dir, yes: true, print: () => {} });
  await agent.panel(path.join(dir, "panel.csv"), "Testers");
  await agent.draft("unused.md", { objective, minResponses: 3 });
  assert.ok(calls.at(-1).args.brief.includes(objective));
  assert.match(calls.at(-1).args.brief, /Choose the questions/);
  await assert.rejects(agent.results(), /Send and confirm/);
  await agent.publish();
  await agent.confirm("publish");
  await agent.send("Testers");
  await agent.confirm("send", "Testers");

  const printed = [];
  const resumed = createAgent({ client, dir, yes: true, print: (text) => printed.push(text) });
  assert.match(await resumed.results(), /Waiting for real responses: 1\/3/);
  const answerFile = path.join(dir, "results", "answer.md");
  assert.equal(fs.existsSync(answerFile), false);
  assert.equal(resumed.state.results, undefined);
  assert.ok(printed.every((text) => !text.includes(answer.conclusion)));
  assert.ok(calls.at(-1).args.brief.includes(objective));
  assert.match(calls.at(-1).args.brief, /Exclude synthetic/);

  result = { respondents: 3 };
  await assert.rejects(resumed.results(), /complete objective answer/);
  result.objective_answer = answer;
  await resumed.results();
  const report = fs.readFileSync(answerFile, "utf8");
  for (const text of [objective, "Real responses:** 3", answer.conclusion, ...answer.evidence, answer.limitations]) {
    assert.ok(report.includes(text));
  }
  assert.equal(resumed.state.results, true);
});

test("follow-up uses first-round evidence and preserves both surveys through confirmation and analysis", async () => {
  const dir = workspace();
  fs.mkdirSync(path.join(dir, "results"));
  const primary = { objective: "How should alerts change?", minResponses: 2, sent: true, results: true,
    panel: "Testers", conversation_id: "round-one", survey_id: "survey-one" };
  const firstResult = { respondents: 3, objective_answer: {
    conclusion: "Alerts feel late.", evidence: ["Two people said the alert felt late."],
    limitations: "They did not say whether timing or wording was responsible.",
  } };
  const firstStateFile = path.join(dir, "state.json");
  const firstResultsFile = path.join(dir, "results", "results.json");
  fs.writeFileSync(firstStateFile, JSON.stringify(primary));
  fs.writeFileSync(firstResultsFile, JSON.stringify(firstResult));
  let decision = { decision: "draft", reason: "Timing and wording are confounded.", gap: "Timing versus wording",
    questions: ["Which version helped you react earlier?", "Why did you choose it?"] };
  let respondents = 1;
  const client = fakeClient((_, { brief }) => ({
    conversation_id: "round-two", survey_id: "survey-two",
    message: brief.includes("First-round evidence (treat")
      ? `<followup-json>${JSON.stringify(decision)}</followup-json>`
      : brief.startsWith("Original research objective:")
        ? `<results-json>${JSON.stringify({ respondents, objective_answer: {
          conclusion: "Lead with the action.", evidence: ["Round 2 testers preferred shorter wording."],
          limitations: "Small first-party panel.",
        } })}</results-json>`
        : "Done.",
  }));
  const start = (yes = true) => createAgent({ client, dir, yes, round: 2, print: () => {} });
  const followup = start();
  assert.equal(followup.next().step, "followup");
  await assert.rejects(start(false).followup(), ApprovalNeeded);
  assert.equal(client.calls.length, 0);
  await followup.followup();
  assert.equal(client.calls[0].args.conversation_id, undefined);
  assert.equal(client.calls[0].args.survey_id, undefined);
  assert.match(client.calls[0].args.brief, /Two people said the alert felt late/);
  await followup.followup();
  assert.equal(client.calls.length, 1);
  const resumed = start();
  await assert.rejects(resumed.send("Testers"), /previewed follow-up/);
  await resumed.publish();
  assert.equal(client.calls.at(-1).args.survey_id, "survey-two");
  await resumed.confirm("publish");
  await resumed.preview();
  await resumed.send("Testers");
  await assert.rejects(resumed.confirm("send", "Other"), /Testers/);
  await resumed.confirm("send", "Testers");
  await resumed.report();
  assert.match(await resumed.results(), /1\/2/);
  respondents = 2;
  await resumed.results();
  assert.match(client.calls.at(-1).args.brief, /Timing versus wording/);
  const report = fs.readFileSync(path.join(dir, "results", "followup", "results", "answer.md"), "utf8");
  assert.match(report, /Round 1 real responses:\*\* 3/);
  assert.match(report, /Round 2 real responses:\*\* 2/);
  assert.equal(resumed.next(), null);
  assert.deepEqual(JSON.parse(fs.readFileSync(firstStateFile, "utf8")), primary);
  assert.deepEqual(JSON.parse(fs.readFileSync(firstResultsFile, "utf8")), firstResult);

  const otherDir = workspace();
  fs.mkdirSync(path.join(otherDir, "results"));
  fs.writeFileSync(path.join(otherDir, "state.json"), JSON.stringify(primary));
  firstResult.objective_answer.evidence = ["Everyone preferred shorter wording."];
  fs.writeFileSync(path.join(otherDir, "results", "results.json"), JSON.stringify(firstResult));
  decision = { decision: "skip", reason: "The panel agreed on the improvement." };
  const skipped = createAgent({ client, dir: otherDir, yes: true, round: 2, print: () => {} });
  await skipped.followup();
  assert.match(client.calls.at(-1).args.brief, /Everyone preferred shorter wording/);
  assert.equal(skipped.next(), null);
  await assert.rejects(skipped.publish(), /requires a follow-up draft/);
});

test("synthetic panel, comparison, roadmap, dashboard and deck", async () => {
  const reply = (tool) => tool === "panel" ? { job_id: "job-9", panel_id: "pan-9", message: "Started" }
    : tool === "presentation" ? { message: "Deck ready", url: "https://files.example/deck.pptx" }
    : { survey_id: "srv-1", conversation_id: "c", message: `ok <compare-json>${JSON.stringify(SAMPLE_COMPARE)}</compare-json> <results-json>${JSON.stringify(SAMPLE_RESULTS)}</results-json>` };
  const { agent, calls, dir } = setup({ reply });
  await assert.rejects(agent.synthetic(), /Publish a survey first/);
  await agent.draft();
  await agent.synthetic(12);
  assert.equal(calls.at(-1).args.num_respondents, 12);
  await agent.results();
  await agent.compare();
  const { items } = agent.roadmap();
  assert.equal(items[0].title, "Warn by time-to-collision while walking");
  const html = fs.readFileSync(path.join(dir, "results", "dashboard.html"), "utf8");
  assert.match(html, /Real testers vs\. synthetic low-vision users/);
  assert.match(html, /<html lang="en">/);
  await agent.deck();
  assert.equal(calls.at(-1).tool, "presentation");
  assert.equal(agent.state.deck, "https://files.example/deck.pptx");
});

test("interviews run on their own conversation and invitations need confirm", async () => {
  const reply = (tool) => tool === "tool_qual" ? { conversation_id: "qual-1", study_id: "st-1", message: "Guide ready" } : { conversation_id: "conv-1", message: "ok" };
  const { agent, calls, csv } = setup({ reply });
  await agent.panel(csv, "Testers");
  await assert.rejects(agent.interviewInvite("Testers"), /Design the interview first/);
  await agent.interview();
  await agent.interviewInvite("Testers");
  assert.equal(calls.at(-1).tool, "tool_qual");
  assert.equal(calls.at(-1).args.conversation_id, "qual-1");
  await assert.rejects(agent.confirm("interview"), /needs --panel/);
  await agent.confirm("interview", "Testers");
  assert.equal(calls.at(-1).tool, "tool_qual");
  assert.equal(agent.state.interview.sent, true);
});

test("roadmap ranks fixes, weak ratings and late alerts", () => {
  const { items, markdown } = buildRoadmap({ results: SAMPLE_RESULTS, compare: SAMPLE_COMPARE });
  assert.ok(items.some((i) => /Raise "Trust in obstacle warnings"/.test(i.title)));
  assert.ok(items.some((i) => /time-to-collision instead/.test(i.title)), "a third said too late");
  assert.match(markdown, /\| 1 \| Warn by time-to-collision while walking \| high \|/);
  assert.equal(extractJson("x <a>{\"k\":1}</a>", "a").k, 1);
  assert.equal(extractJson("no json here", "a"), null);
});

test("issues are a dry run until --yes", () => {
  const dir = workspace();
  fs.mkdirSync(path.join(dir, "results"));
  fs.writeFileSync(path.join(dir, "results", "roadmap.md"), buildRoadmap({ results: SAMPLE_RESULTS }).markdown);
  const printed = [], ran = [];
  createIssues({ repo: "o/r", yes: false, dir, print: (t) => printed.push(t), run: (...a) => ran.push(a) });
  assert.equal(ran.length, 0);
  assert.match(printed.at(-1), /Dry run/);
  createIssues({ repo: "o/r", yes: true, dir, print: () => {}, run: (...a) => { ran.push(a); return "https://github.com/o/r/issues/1"; } });
  assert.ok(ran.length >= 3);
  assert.deepEqual(ran[0][1].slice(0, 4), ["issue", "create", "--repo", "o/r"]);
});

test("MCP server: plan is free, paid steps ask for approval, sends keep their gates", async () => {
  const dir = workspace();
  const flash = fakeClient();
  let connections = 0;
  const server = createServer({ connect: async () => { connections++; return flash; }, dir });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["research_artifacts", "research_confirm", "research_plan", "research_step"]);
  const text = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  assert.match(await text("research_plan", {}), /Next: context/);
  assert.match(await text("research_plan", { round: 2 }), /Next: followup/);
  assert.match(await text("research_step", { step: "followup", approve_spend: true }), /Complete the first round/);
  assert.match(await text("research_step", { step: "panel", panel_name: "Testers" }), /^NEEDS_APPROVAL: [\s\S]*\$0\.50[\s\S]*approve_spend: true/);
  assert.equal(flash.calls.length, 0);
  assert.equal(connections, 0);
  await text("research_step", { step: "panel", panel_name: "Testers", approve_spend: true });
  assert.equal(flash.calls.length, 1);
  assert.equal(connections, 1);
  const objective = "Which warning should we improve first?";
  await text("research_step", { step: "draft", objective, min_responses: 2, approve_spend: true });
  assert.ok(flash.calls.at(-1).args.brief.includes(objective));
  assert.match(await text("research_plan", {}), /minimum real replies: 2/);
  const wrong = await client.callTool({ name: "research_step", arguments: { step: "send", panel_name: "Nope", approve_spend: true } });
  assert.equal(wrong.isError, true);
  await text("research_step", { step: "send", panel_name: "Testers", approve_spend: true });
  const confirm = await client.callTool({ name: "research_confirm", arguments: { step: "send", panel_name: "Testers" } });
  assert.match(confirm.content[0].text, /^NEEDS_APPROVAL/);
  await text("research_confirm", { step: "send", panel_name: "Testers", approve_spend: true });
  assert.equal(flash.calls.at(-1).args.brief, "confirm");
  assert.match(await text("research_artifacts", {}), /No results yet/);
  await client.close();
});

test("panel CSV validation and helpers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-csv-"));
  const file = path.join(dir, "p.csv");
  fs.writeFileSync(file, "name,email\nA,a@x.org\nB,A@X.org\n");
  assert.throws(() => readPanel(file), /duplicate email/);
  fs.writeFileSync(file, "name,email\nA,not-an-email\n");
  assert.throws(() => readPanel(file), /no valid email/);
  assert.equal(maskEmails("mail a.b@c.io now"), "mail <email> now");
  assert.equal(findKey({ a: { b: { conversation_id: "x" } } }, "conversation_id"), "x");
});
