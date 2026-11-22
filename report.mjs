// Local, free post-processing: structured JSON from the Flashpoint agent's reply, a prioritised roadmap,
// and a self-contained, accessible results dashboard (large type, high contrast, screen-reader labels).

export function extractJson(text, tag) {
  const match = String(text).match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`));
  const raw = match?.[1] ?? String(text).match(/```json\s*([\s\S]*?)```/)?.[1];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const SEVERITY = { high: 3, medium: 2, low: 1 };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (part, whole) => (whole ? Math.round((100 * part) / whole) : 0);

// Rank what to fix next. Explicit fixes weigh severity × mentions; weak ratings, late alerts and
// real-vs-synthetic gaps add evidence-backed items of their own.
export function buildRoadmap({ results, compare, summary }) {
  const items = [];
  for (const f of results?.fixes ?? []) {
    items.push({ title: f.fix, evidence: `${f.mentions} tester(s) asked for it`, severity: f.severity ?? "medium",
      score: (SEVERITY[f.severity] ?? 2) * (f.mentions || 1) });
  }
  for (const [question, r] of Object.entries(results?.ratings ?? {})) {
    if (typeof r?.overall === "number" && r.overall < 3.5) {
      items.push({ title: `Raise "${question}"`, evidence: `average ${r.overall.toFixed(1)} / 5`, severity: r.overall < 3 ? "high" : "medium",
        score: (5 - r.overall) * 3 });
    }
  }
  const timing = results?.timing ?? {};
  const total = Object.values(timing).reduce((a, b) => a + b, 0);
  const late = Object.entries(timing).find(([k]) => /late/i.test(k))?.[1] ?? 0;
  if (total && late / total >= 0.25) {
    items.push({ title: "Speak alerts earlier (time-to-collision instead of a fixed distance)", evidence: `${pct(late, total)}% said alerts came too late`,
      severity: "high", score: 10 * (late / total) + 3 });
  }
  for (const d of compare?.differences ?? []) {
    items.push({ title: `Validate with low-vision users: ${d.topic}`, evidence: `testers: ${d.real}; synthetic low-vision users: ${d.synthetic}`,
      severity: "medium", score: 2.5 });
  }
  if (!items.length && summary) items.push({ title: "Review the written summary and pick the top fix", evidence: "no structured results", severity: "medium", score: 1 });
  items.sort((a, b) => b.score - a.score);

  const markdown = [
    "# VisionAssist roadmap from user research",
    "",
    "Ranked by severity × how many people raised it, plus weak ratings, late alerts and gaps between real testers and synthetic low-vision users.",
    "",
    "| # | Fix | Severity | Evidence |",
    "| --- | --- | --- | --- |",
    ...items.map((it, i) => `| ${i + 1} | ${it.title} | ${it.severity} | ${it.evidence} |`),
    "",
    ...items.map((it) => `- [ ] ${it.title}`),
    "",
  ].join("\n");
  return { items, markdown };
}

function bars(entries, { max, unit = "", label }) {
  const top = max ?? Math.max(1, ...entries.map(([, v]) => v));
  return `<ul class="bars" aria-label="${esc(label)}">${entries.map(([k, v]) =>
    `<li><span class="bar-label">${esc(k)}</span><span class="bar" role="img" aria-label="${esc(k)}: ${esc(v)}${esc(unit)}"><span style="width:${Math.max(2, (100 * v) / top)}%"></span></span><span class="bar-value">${esc(typeof v === "number" ? +v.toFixed(1) : v)}${esc(unit)}</span></li>`).join("")}</ul>`;
}

export function buildDashboard({ results, compare, context, interviews, roadmap = [], panel, sample = false }) {
  const ratings = Object.entries(results?.ratings ?? {});
  const roles = [...new Set(ratings.flatMap(([, r]) => Object.keys(r.by_role ?? {})))];
  const trust = ratings.find(([q]) => /trust/i.test(q))?.[1]?.overall;
  const clarity = ratings.find(([q]) => /clear|clarity/i.test(q))?.[1]?.overall;
  const timing = Object.entries(results?.timing ?? {});
  const features = Object.entries(results?.features ?? {}).sort((a, b) => b[1] - a[1]);
  const kpi = (value, label) => `<div class="kpi"><strong${typeof value === "string" && !/^[\d.]+$/.test(value) ? ' class="word"' : ""}>${esc(value ?? "—")}</strong><span>${esc(label)}</span></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>VisionAssist research results</title>
<style>
:root{--bg:#fff;--ink:#0b0b0b;--muted:#333;--line:#0b0b0b;--accent:#0040c1;--bar:#0040c1;--high:#a50000;--card:#f4f6fb}
@media (prefers-color-scheme:dark){:root{--bg:#000;--ink:#fff;--muted:#e6e6e6;--line:#fff;--accent:#ffd84d;--bar:#ffd84d;--high:#ff8a80;--card:#111}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:20px/1.5 "Atkinson Hyperlegible","Segoe UI",system-ui,sans-serif}
main{max-width:64rem;margin:auto;padding:1.5rem 1rem 4rem}
h1{font-size:2.2rem;line-height:1.15;margin:.2rem 0 .4rem}h2{font-size:1.45rem;margin:2.2rem 0 .8rem;border-bottom:3px solid var(--line);padding-bottom:.3rem}
p.lead{font-size:1.15rem;color:var(--muted);margin:0 0 1rem}
.sample{border:3px solid var(--high);color:var(--high);padding:.6rem 1rem;font-weight:700;margin:1rem 0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:1rem}
.kpi{background:var(--card);border:2px solid var(--line);border-radius:.6rem;padding:1rem}
.kpi strong{display:block;font-size:2.4rem;line-height:1.1;color:var(--accent)}
.kpi strong.word{font-size:1.35rem;line-height:1.25;padding:.35rem 0 .25rem}
.bars{list-style:none;margin:0;padding:0;display:grid;gap:.55rem}
.bars li{display:grid;grid-template-columns:minmax(8rem,16rem) 1fr 4rem;gap:.8rem;align-items:center}
.bar{display:block;height:1.4rem;border:2px solid var(--line);border-radius:.3rem;overflow:hidden}
.bar span{display:block;height:100%;background:var(--bar)}
.bar-value{font-weight:700;text-align:right;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:1rem;margin-top:1.2rem}th,td{border:2px solid var(--line);padding:.5rem .6rem;text-align:left;vertical-align:top}
th{background:var(--card)}
blockquote{margin:.3rem 0 0;padding-left:.9rem;border-left:5px solid var(--accent);font-style:italic}
.theme{margin:0 0 1rem}
ol.roadmap li{margin:.5rem 0}.sev-high{color:var(--high);font-weight:700}
pre{white-space:pre-wrap;background:var(--card);border:2px solid var(--line);padding:1rem;border-radius:.6rem;font:1rem/1.5 inherit}
@media (max-width:40rem){.bars li{grid-template-columns:1fr 3.5rem}.bar-label{grid-column:1/-1}}
</style>
</head>
<body><main>
<h1>VisionAssist: what our testers told us</h1>
<p class="lead">First-party panel${panel ? ` “${esc(panel)}”` : ""} on the Flashpoint MCP, compared with synthetic low-vision personas.</p>
${sample ? '<p class="sample">Sample data for layout only. Not real responses.</p>' : ""}
<section aria-labelledby="h-kpi"><h2 id="h-kpi">At a glance</h2><div class="kpis">
${kpi(results?.respondents, "respondents")}${kpi(clarity?.toFixed?.(1), "alert clarity / 5")}${kpi(trust?.toFixed?.(1), "trust / 5")}${kpi(features[0]?.[0], "most valued feature")}
</div></section>
${ratings.length ? `<section aria-labelledby="h-r"><h2 id="h-r">Ratings (1–5)</h2>${bars(ratings.map(([q, r]) => [q, r.overall]), { max: 5, label: "Average rating per question" })}
${roles.length ? `<table><caption class="sr">Average rating by role</caption><thead><tr><th scope="col">Question</th>${roles.map((r) => `<th scope="col">${esc(r)}</th>`).join("")}</tr></thead><tbody>${ratings.map(([q, r]) => `<tr><th scope="row">${esc(q)}</th>${roles.map((role) => `<td>${esc(r.by_role?.[role]?.toFixed?.(1) ?? "—")}</td>`).join("")}</tr>`).join("")}</tbody></table>` : ""}</section>` : ""}
${timing.length ? `<section aria-labelledby="h-t"><h2 id="h-t">Did alerts come early enough?</h2>${bars(timing, { label: "Alert timing answers", unit: "" })}</section>` : ""}
${features.length ? `<section aria-labelledby="h-f"><h2 id="h-f">Most valued feature</h2>${bars(features, { label: "Votes per feature" })}</section>` : ""}
${results?.themes?.length ? `<section aria-labelledby="h-th"><h2 id="h-th">What testers said</h2>${results.themes.map((t) => `<div class="theme"><strong>${esc(t.theme)}</strong> · ${esc(t.mentions)} mention(s)<blockquote>${esc(t.quote)}</blockquote></div>`).join("")}</section>` : ""}
${compare?.differences?.length ? `<section aria-labelledby="h-c"><h2 id="h-c">Real testers vs. synthetic low-vision users</h2><table><thead><tr><th scope="col">Topic</th><th scope="col">Real testers</th><th scope="col">Synthetic low-vision users</th></tr></thead><tbody>${compare.differences.map((d) => `<tr><th scope="row">${esc(d.topic)}</th><td>${esc(d.real)}</td><td>${esc(d.synthetic)}</td></tr>`).join("")}</tbody></table>${compare.agreements?.length ? `<p><strong>They agree:</strong> ${compare.agreements.map(esc).join("; ")}</p>` : ""}</section>` : ""}
${roadmap.length ? `<section aria-labelledby="h-rm"><h2 id="h-rm">What we will fix next</h2><ol class="roadmap">${roadmap.map((it) => `<li><strong>${esc(it.title)}</strong> <span class="sev-${esc(it.severity)}">(${esc(it.severity)})</span><br>${esc(it.evidence)}</li>`).join("")}</ol></section>` : ""}
${context ? `<section aria-labelledby="h-ctx"><h2 id="h-ctx">Who VisionAssist serves</h2><pre>${esc(context)}</pre></section>` : ""}
${interviews ? `<section aria-labelledby="h-i"><h2 id="h-i">AI-moderated interviews</h2><pre>${esc(interviews)}</pre></section>` : ""}
</main><style>.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}</style></body></html>
`;
}
