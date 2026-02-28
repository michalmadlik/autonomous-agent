// ═══════════════════════════════════════════════════════════════════════════
// Autonomous Weakness Extractor — Pioneer/GLiNER2 + Reka Flash NER
// Uses Fastino's GLiNER2 model via Pioneer inference API to extract
// medical concepts from student history / search results, then predicts
// weak domains and computes F1 against known weak areas.
// ═══════════════════════════════════════════════════════════════════════════
require("dotenv").config();
const axios = require("axios");
const db = require("./database");

const PIONEER_API_KEY = process.env.PIONEER_API_KEY;
const PIONEER_BASE = "https://api.pioneer.ai";
const REKA_API_KEY = process.env.REKA_API_KEY;
const REKA_BASE = "https://api.reka.ai/v1/chat";

// Medical entity labels for GLiNER zero-shot NER
const MEDICAL_LABELS = [
  "disease", "symptom", "anatomy", "physiology",
  "biochemistry", "pharmacology", "clinical procedure",
  "cell biology", "genetics", "medical concept"
];

// ── Pioneer/GLiNER2 inference call ────────────────────────────────────────
// Calls Fastino's GLiNER2 model via Pioneer API for Named Entity Recognition.
// Zero-shot: just provide schema labels, no fine-tuning needed.
async function glinerExtract(text, labels = MEDICAL_LABELS) {
  if (!PIONEER_API_KEY) {
    console.warn("[GLiNER] No PIONEER_API_KEY set — skipping Pioneer call");
    return { entities: [], error: "no_api_key", apiCalled: false };
  }

  try {
    const res = await axios.post(
      `${PIONEER_BASE}/inference`,
      {
        model_id: "gliner2-large-v1",
        task: "extract_entities",
        text: text.slice(0, 4000),
        schema: labels
      },
      {
        headers: {
          "X-API-Key": PIONEER_API_KEY,
          "Content-Type": "application/json"
        },
        timeout: 15000
      }
    );

    console.log("[GLiNER] Pioneer response:", JSON.stringify(res.data).slice(0, 400));

    // Normalize — Pioneer may return different shapes
    const d = res.data;
    let entities = [];
    if (Array.isArray(d.entities))           entities = d.entities;
    else if (d.output?.entities)             entities = d.output.entities;
    else if (Array.isArray(d.output))        entities = d.output;
    else if (Array.isArray(d.predictions))   entities = d.predictions;
    else if (Array.isArray(d))               entities = d;

    return { entities, error: null, apiCalled: true };
  } catch (e) {
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    console.error("[GLiNER] Pioneer error:", e.response?.status, msg);
    return { entities: [], error: msg, apiCalled: true };
  }
}

// ── Reka Flash fallback for NER ───────────────────────────────────────────
// If Pioneer API fails, use Reka Flash as a fallback concept extractor.
async function rekaExtractFallback(text, topic) {
  try {
    const prompt = `You are a medical Named Entity Recognition (NER) system. Extract ALL medical and scientific named entities from this text about "${topic}".

Text:
${text.slice(0, 2500)}

Return ONLY valid JSON (no markdown, no explanation):
{
  "entities": [
    { "text": "entity name", "label": "domain_type", "score": 0.85 }
  ]
}

Rules:
- Use these domain labels ONLY: disease, symptom, anatomy, physiology, biochemistry, pharmacology, clinical procedure, cell biology, genetics, medical concept
- Extract 8–15 specific medical/scientific terms (not generic words)
- Score reflects confidence (0.5–1.0)
- Be precise: extract actual terms like "mitochondria", "ATP synthase", "Na+/K+ pump"`;

    const response = await axios.post(REKA_BASE, {
      model: "reka-flash",
      messages: [{ role: "user", content: prompt }]
    }, {
      headers: { "X-Api-Key": REKA_API_KEY, "Content-Type": "application/json" },
      timeout: 25000
    });

    const raw = response.data.responses[0].message.content;
    const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
    const parsed = JSON.parse(cleaned);
    return parsed.entities || [];
  } catch (e) {
    console.error("[Reka NER fallback] Error:", e.message);
    return [];
  }
}

// ── Student history from SQLite ───────────────────────────────────────────
function getStudentHistory(userId = 1) {
  try {
    return db.prepare(`
      SELECT spf.plan_json, t.name AS topic_name
      FROM study_plans_full spf
      JOIN topics t ON t.id = spf.topic_id
      WHERE spf.user_id = ?
      ORDER BY spf.created_at DESC
      LIMIT 5
    `).all(userId);
  } catch (_) {
    return [];
  }
}

// ── F1 Score computation ──────────────────────────────────────────────────
// Fuzzy F1 between predicted concept list and actual weak areas.
function computeF1(predicted, actual) {
  if (!predicted.length || !actual.length) return null;

  const norm = s => s.toLowerCase().trim().replace(/[_\-]/g, " ");
  const preds = [...new Set(predicted.map(norm))];
  const acts  = [...new Set(actual.map(norm))];

  const fuzzy = (a, b) => {
    if (a.includes(b) || b.includes(a)) return true;
    const wa = new Set(a.split(/\s+/).filter(w => w.length > 2));
    const wb = new Set(b.split(/\s+/).filter(w => w.length > 2));
    let overlap = 0;
    for (const w of wa) if (wb.has(w)) overlap++;
    return overlap >= 1;
  };

  let tp = 0;
  for (const p of preds) { if (acts.some(a => fuzzy(p, a))) tp++; }
  const fp = preds.length - tp;

  let matchedAct = 0;
  for (const a of acts) { if (preds.some(p => fuzzy(a, p))) matchedAct++; }
  const fn = acts.length - matchedAct;

  const P = tp + fp > 0 ? tp / (tp + fp) : 0;
  const R = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = P + R > 0 ? 2 * P * R / (P + R) : 0;

  return {
    f1: Math.round(f1 * 100) / 100,
    precision: Math.round(P * 100) / 100,
    recall: Math.round(R * 100) / 100,
    tp, fp, fn
  };
}

// ── Main extraction pipeline ──────────────────────────────────────────────
// 1. Pull student history from SQLite
// 2. Build analysis corpus (history + search results)
// 3. Call Pioneer/GLiNER2 for zero-shot NER
// 4. Fallback to Reka Flash if needed
// 5. Group entities by medical domain
// 6. Predict weak domains (highest concept density)
// 7. Compute F1 against known weak areas from past plans
async function extractWeaknesses(topic, searchResults = [], userId = 1) {
  const history = getStudentHistory(userId);

  // Build corpus
  let corpus = "";
  let knownWeakAreas = [];

  if (history.length > 0) {
    for (const plan of history) {
      try {
        const pd = JSON.parse(plan.plan_json);
        if (pd.answers?.weakAreas) knownWeakAreas.push(...pd.answers.weakAreas);
        for (const tc of (pd.theory?.per_cluster || [])) {
          for (const card of (tc.cards || [])) {
            corpus += (card.teach || "") + " " + (card.exercise || "") + " ";
          }
        }
      } catch (_) {}
    }
  }

  for (const r of searchResults) {
    corpus += (r.content || r.title || "").slice(0, 500) + " ";
  }

  if (!corpus.trim()) {
    corpus = `Medical study topic: ${topic}. This covers terminology, mechanisms, clinical applications, diagnostics, and treatment protocols related to ${topic}.`;
  }
  corpus = corpus.slice(0, 4000);

  // ── Step A: Pioneer/GLiNER2 extraction ──
  let glinerResult = await glinerExtract(corpus, MEDICAL_LABELS);
  let entities = glinerResult.entities;
  let apiUsed = glinerResult.apiCalled && !glinerResult.error;
  let apiError = glinerResult.error;

  // ── Step B: Reka fallback if GLiNER returned nothing ──
  let usedFallback = false;
  if (entities.length === 0) {
    console.log("[Extraction] GLiNER returned 0 entities — using Reka NER fallback");
    entities = await rekaExtractFallback(corpus, topic);
    usedFallback = entities.length > 0;
  }

  // ── Step C: Group by domain ──
  const domainMap = {};
  const conceptList = [];

  for (const ent of entities) {
    const label = (ent.label || ent.type || ent.category || "medical concept")
      .replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const text = (ent.text || ent.span || ent.word || ent.entity || "").trim();
    if (!text || text.length < 2) continue;

    if (!domainMap[label]) domainMap[label] = [];
    if (!domainMap[label].includes(text)) {
      domainMap[label].push(text);
      conceptList.push({ text, label, score: parseFloat(ent.score || ent.confidence || 0.75) });
    }
  }

  // ── Step D: Domain scoring ──
  const domainScores = Object.entries(domainMap)
    .map(([domain, concepts]) => ({
      domain,
      concepts,
      count: concepts.length,
      avgScore: conceptList.filter(c => c.label === domain).length > 0
        ? conceptList.filter(c => c.label === domain).reduce((s, c) => s + c.score, 0) / concepts.length
        : 0.5
    }))
    .sort((a, b) => b.count - a.count);

  const predictedWeakDomains = domainScores.slice(0, 4).map(d => d.domain);

  // ── Step E: F1 against known history ──
  let f1 = null;
  if (knownWeakAreas.length > 0) {
    f1 = computeF1(conceptList.map(c => c.text), knownWeakAreas);
  }

  return {
    entities: domainMap,
    conceptList,
    domainScores,
    predictedWeakDomains,
    knownWeakAreas,
    f1,
    entityCount: conceptList.length,
    hasHistory: history.length > 0,
    historyPlans: history.length,
    apiUsed,
    usedFallback,
    apiError,
    model: apiUsed ? "GLiNER2-Large (Pioneer)" : (usedFallback ? "Reka Flash NER (fallback)" : "none")
  };
}

module.exports = { extractWeaknesses, glinerExtract, computeF1 };
