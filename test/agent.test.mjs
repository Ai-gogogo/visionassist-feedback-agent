// Offline tests with a fake Flashpoint client: no wallet, no network, no credit spent.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgent, ApprovalNeeded, readPanel, maskEmails, findKey } from "../survey-agent.mjs";

function setup({ yes = true, reply = () => ({ conversation_id: "conv-1", survey_id: "srv-1", message: "Done." }) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-agent-"));
  const calls = [];
  const printed = [];
  const client = { call: async (tool, args) => { calls.push({ tool, args }); return reply(tool, args); } };
  const agent = createAgent({
    client, yes, print: (t) => printed.push(t),
    stateFile: path.join(dir, "state.json"), runDir: path.join(dir, "runs"), resultDir: path.join(dir, "results"),
  });
  const csv = path.join(dir, "panel.csv");
  fs.writeFileSync(csv, "name,email,role\nAda Lee,ada@example.org,teammate\nBo Chen,bo@example.org,classmate\n");
  return { dir, calls, printed, agent, csv };
}

test("paid steps stop without --yes and spend nothing", async () => {
  const { agent, calls, csv } = setup({ yes: false });
  await assert.rejects(agent.panel(csv, "Testers"), ApprovalNeeded);
  await assert.rejects(agent.draft("survey-brief.md"), /costs \$0\.50/);
  assert.equal(calls.length, 0);
  assert.equal(agent.state.spent, 0);
});

test("panel sends emails to Flashpoint but never prints or logs them", async () => {
  const { agent, calls, printed, csv, dir } = setup({ reply: () => ({ conversation_id: "conv-1", message: "Panel ready with ada@example.org and bo@example.org" }) });
  await agent.panel(csv, "Testers");
  assert.match(calls[0].args.brief, /Ada Lee ada@example\.org \(role teammate\)/);
  assert.equal(calls[0].args.conversation_id, undefined);
  assert.ok(printed.every((t) => !/@example\.org/.test(t)), "no email in output");
  const logs = fs.readdirSync(path.join(dir, "runs")).map((f) => fs.readFileSync(path.join(dir, "runs", f), "utf8")).join("");
  assert.ok(!/@example\.org/.test(logs), "no email in run logs");
  assert.equal(agent.state.panel, "Testers");
  assert.equal(agent.state.spent, 0.5);
});

test("every step stays on one conversation and keeps the survey id", async () => {
  const { agent, calls, csv } = setup();
  await agent.panel(csv, "Testers");
  await agent.draft("survey-brief.md");
  assert.equal(calls[1].args.conversation_id, "conv-1");
  assert.equal(calls[1].args.survey_id, "srv-1");
  assert.match(calls[1].args.brief, /Do not publish it yet/);
});

test("publishing needs a separate confirm for the publish step", async () => {
  const { agent, calls, csv } = setup();
  await agent.panel(csv, "Testers");
  await agent.publish();
  assert.equal(agent.state.pending, "publish");
  await assert.rejects(agent.confirm("send", "Testers"), /Pending step: publish/);
  await agent.confirm("publish");
  assert.equal(calls.at(-1).args.brief, "confirm");
  assert.equal(agent.state.pending, undefined);
});

test("sending needs the exact panel name twice", async () => {
  const { agent, calls, csv } = setup();
  await agent.panel(csv, "Testers");
  await assert.rejects(agent.send("testers"), /exact panel name/);
  await agent.send("Testers");
  assert.equal(agent.state.pending, "send");
  await assert.rejects(agent.confirm("send", "Other"), /needs --panel "Testers"/);
  const before = calls.length;
  await agent.confirm("send", "Testers");
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).args.brief, "confirm");
});

test("results are saved with links and without emails", async () => {
  const { agent, dir } = setup({ reply: () => ({ message: "Avg clarity 4.2 (x@example.org). CSV: https://files.example/r.csv XLSX: https://files.example/r.xlsx" }) });
  await agent.results();
  const summary = fs.readFileSync(path.join(dir, "results", "summary.md"), "utf8");
  assert.match(summary, /<email>/);
  assert.deepEqual(fs.readFileSync(path.join(dir, "results", "links.txt"), "utf8").trim().split("\n"),
    ["https://files.example/r.csv", "https://files.example/r.xlsx"]);
});

test("synthetic panel needs a published survey and records the job", async () => {
  const { agent, calls } = setup({ reply: (tool) => tool === "panel" ? { job_id: "job-9", panel_id: "pan-9", message: "Started" } : { survey_id: "srv-1", conversation_id: "c" } });
  await assert.rejects(agent.synthetic(), /Publish a survey first/);
  await agent.draft("survey-brief.md");
  await agent.synthetic(12);
  assert.equal(calls.at(-1).args.action, "create_and_run");
  assert.equal(calls.at(-1).args.num_respondents, 12);
  assert.deepEqual(agent.state.synthetic, { job_id: "job-9", panel_id: "pan-9" });
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
