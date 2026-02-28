require("dotenv").config();
const express = require("express");
const path = require("path");
const db = require("./database");
const { runAgentPipeline, runClarifyStep, getScoreboard } = require("./agent_pipeline");

const PORT = Number(process.env.PORT || 3000);

if (!process.env.TAVILY_API_KEY) {
  console.error("Missing TAVILY_API_KEY"); process.exit(1);
}
if (!process.env.REKA_API_KEY) {
  console.error("Missing REKA_API_KEY"); process.exit(1);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// Serve public.html as index
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public.html")));

// ── Health ────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ ok: true, database: "sqlite", sponsor_tools: ["Tavily", "Senso AI", "Neo4j", "Fastino/GLiNER", "Pioneer", "Reka"] });
});

// ── Scoreboard ────────────────────────────────────────────────────────────
app.get("/api/agent/scoreboard", (req, res) => {
  const userId = Number(req.query.user_id) || 1;
  try {
    const scoreboard = getScoreboard(userId);
    res.json({ ok: true, scoreboard });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Clarify (fast: search + generate questions) ───────────────────────────
app.post("/api/agent/clarify", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });
  try {
    const result = await runClarifyStep(query);
    res.json(result);
  } catch (err) {
    console.error("Clarify error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Streaming plan (SSE over POST) ────────────────────────────────────────
app.post("/api/agent/plan-stream", async (req, res) => {
  const { query, user_id = 1, answers = {}, extraction = null } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const emit = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await runAgentPipeline(query, user_id, answers, emit, extraction);
    emit({ type: "done", plan: result.planJson, plan_id: result.planId });
  } catch (err) {
    console.error("Pipeline stream error:", err);
    emit({ type: "error", message: err.message });
  }

  res.end();
});

// ── Main pipeline (legacy REST) ────────────────────────────────────────────
app.post("/api/agent/plan", async (req, res) => {
  const { query, user_id = 1 } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });

  try {
    const result = await runAgentPipeline(query, user_id, {}, () => {});
    res.json({ success: true, study_plan_id: result.planId, plan: result.planJson });
  } catch (err) {
    console.error("Pipeline error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ── Get active plan (merged with overrides) ───────────────────────────────
app.get("/api/study-plans/active", (req, res) => {
  const userId = Number(req.query.user_id) || 1;

  const plan = db.prepare(
    "SELECT * FROM study_plans_full WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(userId);

  if (!plan) return res.status(404).json({ error: "No active plan" });

  const clusterOvs = db.prepare(
    "SELECT * FROM study_plan_cluster_overrides WHERE study_plan_id = ?"
  ).all(plan.id);

  const dayOvs = db.prepare(
    "SELECT * FROM study_plan_day_overrides WHERE study_plan_id = ?"
  ).all(plan.id);

  const sources = db.prepare(
    "SELECT * FROM plan_sources WHERE study_plan_id = ?"
  ).all(plan.id);

  const planJson = JSON.parse(plan.plan_json);

  // Merge cluster overrides
  const byCluster = new Map(clusterOvs.map(o => [o.cluster_id, o]));
  planJson.clusters = planJson.clusters.map(c => {
    const ov = byCluster.get(c.cluster_id);
    if (!ov) return c;
    return { ...c, custom_title: ov.custom_title, disabled: ov.disabled === 1 };
  });

  // Merge day overrides
  const byDay = new Map(dayOvs.map(o => [o.day_index, o]));
  planJson.daily = planJson.daily
    .map(d => {
      const ov = byDay.get(d.day_index);
      if (!ov) return d;
      return { ...d, questions_target_override: ov.questions_target, day_order_index: ov.day_order_index, custom_notes: ov.custom_notes };
    })
    .sort((a, b) => (a.day_order_index ?? a.day_index) - (b.day_order_index ?? b.day_index));

  res.json({
    study_plan_id: plan.id,
    plan: planJson,
    db_sources: sources,
    overrides: { clusters: clusterOvs, days: dayOvs }
  });
});

// ── Override: cluster rename / disable ────────────────────────────────────
app.post("/api/study-plans/overrides/cluster", (req, res) => {
  const { study_plan_id, cluster_id, custom_title, disabled = 0 } = req.body;
  if (!study_plan_id || cluster_id == null) return res.status(400).json({ error: "Missing fields" });

  db.prepare(`
    INSERT INTO study_plan_cluster_overrides (study_plan_id, cluster_id, custom_title, disabled, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(study_plan_id, cluster_id)
    DO UPDATE SET custom_title=excluded.custom_title, disabled=excluded.disabled
  `).run(study_plan_id, cluster_id, custom_title || null, disabled ? 1 : 0, new Date().toISOString());

  res.json({ ok: true });
});

// ── Override: day reorder / resize ───────────────────────────────────────
app.post("/api/study-plans/overrides/day", (req, res) => {
  const { study_plan_id, day_index, questions_target, day_order_index, custom_notes } = req.body;
  if (!study_plan_id || day_index == null) return res.status(400).json({ error: "Missing fields" });

  db.prepare(`
    INSERT INTO study_plan_day_overrides (study_plan_id, day_index, questions_target, day_order_index, custom_notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(study_plan_id, day_index)
    DO UPDATE SET questions_target=excluded.questions_target, day_order_index=excluded.day_order_index, custom_notes=excluded.custom_notes
  `).run(study_plan_id, day_index, questions_target || null, day_order_index ?? null, custom_notes || null, new Date().toISOString());

  res.json({ ok: true });
});

// ── Logs ──────────────────────────────────────────────────────────────────
app.get("/api/logs", (req, res) => {
  const rows = db.prepare("SELECT * FROM logs ORDER BY id DESC LIMIT 50").all();
  res.json({ logs: rows.reverse() });
});

app.listen(PORT, () => {
  console.log(`Medstart Agent running on http://localhost:${PORT}`);
});
