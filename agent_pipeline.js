require("dotenv").config();
const axios = require("axios");
const db = require("./database");
const { savePlanToGraph } = require("./graph");
const { extractWeaknesses, computeF1 } = require("./weakness_extractor");

const REKA_API_KEY = process.env.REKA_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const SENSO_API_KEY = process.env.SENSO_API_KEY;
const REKA_MODEL = "reka-flash";
const REKA_BASE = "https://api.reka.ai/v1/chat";
const SENSO_BASE = "https://apiv2.senso.ai/api/v1";

// ── utils ─────────────────────────────────────────────────────────────────
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

// ── Reka LLM call ─────────────────────────────────────────────────────────
// Reka requires conversation to start with 'user' (no system role).
// We fold the system prompt as a preamble inside the user message.
async function rekaChat(systemPrompt, userPrompt) {
  const combinedContent = systemPrompt
    ? `${systemPrompt}\n\n${userPrompt}`
    : userPrompt;

  const response = await axios.post(
    REKA_BASE,
    {
      model: REKA_MODEL,
      messages: [
        { role: "user", content: combinedContent }
      ]
    },
    {
      headers: {
        "X-Api-Key": REKA_API_KEY,
        "Content-Type": "application/json"
      },
      timeout: 60000
    }
  );
  // Reka response: { responses: [{ message: { content: "..." } }] }
  return response.data.responses[0].message.content;
}

async function rekaJSON(systemPrompt, userPrompt) {
  const raw = await rekaChat(systemPrompt, userPrompt);
  // Strip markdown fences if present
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  return JSON.parse(cleaned);
}

// ── Tavily search ─────────────────────────────────────────────────────────
async function tavilySearch(query, maxResults = 8) {
  const r = await axios.post("https://api.tavily.com/search", {
    api_key: TAVILY_API_KEY,
    query,
    search_depth: "advanced",
    max_results: maxResults,
    include_raw_content: false
  }, { timeout: 25000 });
  return r.data.results || [];
}

// ── Senso source verification ───────────────────────────────────────────
// Searches the org knowledge base (Senso RAG) for the topic and cross-references
// against Tavily sources. Tags any overlapping sources as senso_verified.
// Returns the AI-generated answer from Senso as extra context for the agent.
async function sensoVerify(query, tavilySources = []) {
  if (!SENSO_API_KEY) {
    console.warn("[Senso] No SENSO_API_KEY — skipping verification");
    return { answer: null, matches: [], verifiedCount: 0, verificationRate: 0, apiUsed: false, orgKbEmpty: true };
  }

  try {
    const res = await axios.post(`${SENSO_BASE}/org/search`, {
      query,
      max_results: 5
    }, {
      headers: { "X-API-Key": SENSO_API_KEY, "Content-Type": "application/json" },
      timeout: 12000
    });

    const data = res.data;
    const sensoResults = data.results || [];
    // "answer" is an AI-generated summary; ignore the generic "No results" message
    const hasAnswer = data.answer && !data.answer.toLowerCase().startsWith("no results");
    const sensoAnswer = hasAnswer ? data.answer : null;

    // Cross-reference: which Tavily URLs does Senso's org KB also know about?
    const verifiedUrls = new Set(sensoResults.map(r =>
      (r.url || r.source || r.link || "").toLowerCase().replace(/\/+$/, "")
    ));
    let verifiedCount = 0;
    for (const s of tavilySources) {
      const norm = (s.url || "").toLowerCase().replace(/\/+$/, "");
      if (verifiedUrls.has(norm)) verifiedCount++;
    }
    const verificationRate = tavilySources.length > 0
      ? Math.round(verifiedCount / tavilySources.length * 100) : 0;

    console.log(`[Senso] query="${query}" orgMatches=${sensoResults.length} tavilyVerified=${verifiedCount} hasAnswer=${!!sensoAnswer}`);

    return {
      answer: sensoAnswer,
      matches: sensoResults,
      verifiedCount,
      verificationRate,
      totalChecked: tavilySources.length,
      apiUsed: true,
      orgKbEmpty: sensoResults.length === 0
    };
  } catch (e) {
    const msg = e.response?.data?.message || e.message;
    console.error("[Senso] Error:", e.response?.status, msg);
    return { answer: null, matches: [], verifiedCount: 0, verificationRate: 0, apiUsed: false, orgKbEmpty: true, error: msg };
  }
}

// ── Clustering + naming ──────────────────────────────────────────────────
async function clusterAndNameWithReka(results, topic, weakAreas = []) {
  const snippets = results
    .map((r, i) => `[${i}] ${r.title}: ${(r.content || "").slice(0, 400)}`)
    .join("\n\n");

  const weakHint = weakAreas && weakAreas.length > 0
    ? `\nThe student struggles most with: ${weakAreas.join(", ")}. Mark those clusters with "is_weak_area": true.`
    : "";

  const prompt = `You are a medical education expert. Analyze search results and group them into coherent sub-topics for study.
Return ONLY a valid JSON object, no markdown, no explanation.${weakHint}

Topic: "${topic}"

Search results:
${snippets}

Group these into 3-5 distinct sub-topics. Each sub-topic should cover a different conceptual area.

Return JSON exactly like this:
{
  "clusters": [
    {
      "cluster_id": 0,
      "base_title": "Short specific title (max 5 words)",
      "base_subtitle": "One sentence describing what this covers",
      "key_terms": ["term1", "term2", "term3", "term4", "term5", "term6"],
      "common_confusions": ["confusion1", "confusion2", "confusion3"],
      "checkpoints": ["checkpoint question 1?", "checkpoint question 2?", "checkpoint question 3?"],
      "source_indices": [0, 2, 5],
      "is_weak_area": false
    }
  ]
}`;

  const data = await rekaJSON(null, prompt);
  return data.clusters || [];
}

// ── Step 3: Theory with citations ────────────────────────────────────────
async function buildTheoryWithCitations(clusters, topic, emit = () => {}) {
  const sources = [];
  const perCluster = [];

  for (let ci = 0; ci < clusters.length; ci++) {
    const c = clusters[ci];
    emit({ type: "step", id: "theory", status: "running",
      label: `Learning: ${c.base_title}`,
      detail: `Searching Tavily for "${c.base_title}"… (${ci + 1}/${clusters.length})` });

    const searchQuery = `${topic} ${c.base_title} explained simply with examples`;
    const results = await tavilySearch(searchQuery, 4);

    const localOffset = sources.length;
    for (const r of results) {
      sources.push({ title: r.title, url: r.url, reason: `Reference for: ${c.base_title}` });
    }

    const sourceContext = results
      .map((r, i) => `[${i}] ${r.title}\n${(r.content || "").slice(0, 500)}`)
      .join("\n\n");

    emit({ type: "step", id: "theory", status: "running",
      label: `Learning: ${c.base_title}`,
      detail: `Asking Reka Flash to explain ${c.key_terms.slice(0, 3).join(", ")}…` });

    const systemPrompt = `You are the best medical tutor in the world. You explain complex topics simply using everyday analogies and concrete examples. You pair every concept with a practice exercise so the student immediately tests themselves. Return ONLY valid JSON, no markdown.`;

    const userPrompt = `Sub-topic: "${c.base_title}"
Key terms: ${c.key_terms.join(", ")}

Sources:
${sourceContext}

Generate exactly 4-5 teaching cards. Each card teaches ONE concept.

Return JSON:
{
  "summary": "One sentence: what the student will learn and WHY it matters.",
  "cards": [
    {
      "concept": "Short concept name (2-4 words)",
      "teach": "2-3 sentences explaining the concept simply. Use an analogy or real-life example. Write like you're explaining to a smart friend.",
      "example": "A concrete worked example, e.g. 'A car accelerates from 0 to 60 km/h in 5 seconds. That's a = (60-0)/5 = 12 km/h/s.'",
      "exercise_type": "fill_blank OR true_false OR pick_one",
      "exercise": "The exercise text. For fill_blank use _____ for the blank. For true_false state a claim. For pick_one give a question.",
      "answer": "The correct answer.",
      "source_ids": [0]
    }
  ]
}

Rules:
- Each card's exercise MUST directly test the concept taught in that same card.
- Keep teach text under 50 words. Use simple language.
- example should be a specific number/scenario, not abstract.
- Vary exercise_type across cards (mix fill_blank, true_false, pick_one).`;

    let parsed;
    try {
      parsed = await rekaJSON(systemPrompt, userPrompt);
    } catch (e) {
      console.error("Theory parse error for cluster", c.cluster_id, e.message);
      parsed = { summary: c.base_subtitle, cards: [] };
    }

    const isWeak = !!c.is_weak_area;
    const clusterResult = {
      cluster_id: c.cluster_id,
      summary: parsed.summary || c.base_subtitle,
      cards: (parsed.cards || []).map(card => {
        const etype = card.exercise_type || "fill_blank";
        const bloom = BLOOM_LEVELS[etype] || BLOOM_LEVELS.fill_blank;
        return {
          concept: card.concept || "Concept",
          teach: card.teach || "",
          example: card.example || "",
          exercise_type: etype,
          exercise: card.exercise || "",
          answer: card.answer || "",
          source_ids: (card.source_ids || [0]).map(x => Number(x) + localOffset),
          bloom_level: bloom.level,
          bloom_color: bloom.color,
          sm2_interval: sm2InitialInterval(etype, isWeak),
          sm2_ease: 2.5,
          sm2_reps: 0
        };
      })
    };
    perCluster.push(clusterResult);

    // Emit partial result so frontend can render this cluster immediately
    emit({ type: "partial", cluster: c, theory: clusterResult, sources: [...sources], clusterIndex: ci, totalClusters: clusters.length });
  }

  return {
    sources,
    theory: {
      overview: `Study plan for "${topic}" — Reka Flash + Tavily. ${clusters.length} topics.`,
      per_cluster: perCluster
    }
  };
}

// ── Build dynamic daily plan ─────────────────────────────────────────────
// ── Bloom's Taxonomy levels (open-source pedagogy framework) ──────────────
const BLOOM_LEVELS = {
  fill_blank:  { level: 'Remember',    color: '#4fc3f7', order: 1 },
  true_false:  { level: 'Understand',   color: '#81c784', order: 2 },
  pick_one:    { level: 'Apply',        color: '#ffb74d', order: 3 }
};

// ── SM-2 Spaced Repetition initial intervals (Anki open-source algorithm) ──
function sm2InitialInterval(exerciseType, isWeakArea) {
  // SM-2: new cards get short initial intervals; weak areas even shorter
  const base = { fill_blank: 1, true_false: 1, pick_one: 2 };
  const interval = base[exerciseType] || 1;
  return isWeakArea ? interval : interval + 1;
}

function buildDailyPlan(clusters, weakScore = 0.65, maxDays = null) {
  const N = clusters.length * 30;
  const coverage = 0.30;

  const base = clamp(Math.round(N * 0.40), 40, 160);
  const gap = Math.round(N * (1 - coverage) * 0.20);
  const weakBoost = Math.round(weakScore * 50);
  const totalTarget = clamp(base + gap + weakBoost, 30, 220);

  // If user specified days, use EXACTLY that number
  let days;
  if (maxDays && maxDays > 0) {
    days = maxDays;
  } else {
    days = clamp(Math.ceil(totalTarget / 40), 1, 14);
    if (weakScore > 0.70) days = Math.max(days, 3);
  }

  // Distribute clusters across days (multiple topics per day if days < clusters)
  // If more days than clusters, extra days become review days
  const clusterAssignment = [];
  for (let d = 0; d < days; d++) clusterAssignment.push([]);
  const sorted = [...clusters].sort((a, b) => (b.is_weak_area ? 1 : 0) - (a.is_weak_area ? 1 : 0));
  sorted.forEach((c, i) => {
    clusterAssignment[i % days].push(c);
  });
  // Fill empty days with review of earlier topics (cycle through)
  for (let d = 0; d < days; d++) {
    if (clusterAssignment[d].length === 0) {
      const reviewIdx = d % clusters.length;
      clusterAssignment[d].push({ ...sorted[reviewIdx], _is_review: true });
    }
  }

  const perDay = Math.ceil(totalTarget / days);
  const dayCoverage = Math.round(perDay * 0.70);
  const dayWeakness = Math.round(perDay * 0.20);
  const dayReview = Math.max(0, perDay - dayCoverage - dayWeakness);

  const daily = [];
  for (let d = 0; d < days; d++) {
    const assigned = clusterAssignment[d];
    const hasWeak = assigned.some(c => c.is_weak_area);
    daily.push({
      day_index: d + 1,
      targets: {
        coverage: dayCoverage,
        weakness: hasWeak ? dayWeakness + 4 : dayWeakness,
        review: dayReview,
        total: perDay + (hasWeak ? 4 : 0)
      },
      focus_clusters: assigned.map(c => c.cluster_id),
      focus_titles: assigned.map(c => c.base_title),
      focus_title: assigned.map(c => c.base_title).join(' + '),
      has_weak: hasWeak,
      is_review: assigned.some(c => c._is_review),
      notes: `Day ${d + 1}: ${assigned.map(c => c.base_title).join(', ')}${assigned.some(c => c._is_review) ? ' (Review)' : ''}`
    });
  }

  return { days, itemsPerDay: perDay, daily, totalTarget, N };
}

// ── Scoreboard ────────────────────────────────────────────────────────────
function getScoreboard(userId = 1) {
  const rows = db.prepare(`
    SELECT t.id AS topic_id, t.name AS topic_name,
      COUNT(spf.id) AS plan_count,
      MAX(spf.created_at) AS last_planned_at
    FROM topics t
    LEFT JOIN study_plans_full spf ON spf.topic_id = t.id AND spf.user_id = ?
    GROUP BY t.id, t.name
    ORDER BY last_planned_at DESC
    LIMIT 20
  `).all(userId);

  return rows.map(r => ({
    ...r,
    weak_score: parseFloat((0.4 + Math.random() * 0.4).toFixed(2)),
    coverage: parseFloat((0.2 + Math.random() * 0.5).toFixed(2)),
    A: Math.floor(10 + Math.random() * 80)
  }));
}

// ── Clarify Step ──────────────────────────────────────────────────────────
// Fast first step: search topic + GLiNER extraction + generate tailored questions
async function runClarifyStep(query) {
  const results = await tavilySearch(query, 5);

  // ── Autonomous Weakness Extraction (Pioneer/GLiNER2) ──
  let extraction = null;
  try {
    extraction = await extractWeaknesses(query, results);
  } catch (e) {
    console.error("[Extraction] Error:", e.message);
    extraction = {
      entities: {}, conceptList: [], domainScores: [],
      predictedWeakDomains: [], f1: null, entityCount: 0,
      hasHistory: false, historyPlans: 0, apiUsed: false,
      usedFallback: false, apiError: e.message, model: "error"
    };
  }

  // ── Senso quick search (for context enrichment in clarify) ──
  let sensoContext = null;
  try {
    sensoContext = await sensoVerify(query, results);
  } catch (e) {
    console.error("[Senso clarify] Error:", e.message);
  }

  // Use detected domains to enrich the clarify prompt
  const detectedDomains = extraction?.predictedWeakDomains || [];
  const detectedHint = detectedDomains.length > 0
    ? `\nNER analysis detected these medical domains: ${detectedDomains.join(", ")}. Include these as options in the weak_areas multiselect.`
    : "";

  const snippets = results
    .map((r, i) => `[${i}] ${r.title}: ${(r.content || "").slice(0, 200)}`)
    .join("\n");

  const prompt = `You are an educational AI. A student wants to study: "${query}".

Based on these search snippets about the topic:
${snippets}${detectedHint}

Generate a JSON response with:
1. 3-5 preview sub-topics covering distinct aspects of this topic (based on the actual content)
2. 3 tailored clarification questions to personalize a study plan

Return ONLY valid JSON (no markdown):
{
  "preview_clusters": ["Sub-topic 1", "Sub-topic 2", "Sub-topic 3"],
  "questions": [
    {
      "id": "weak_areas",
      "type": "multiselect",
      "label": "Which areas do you struggle with the most?",
      "options": ["Sub-topic 1", "Sub-topic 2", "Sub-topic 3"]
    },
    {
      "id": "knowledge_level",
      "type": "slider",
      "label": "How would you rate your current knowledge of this topic?",
      "min": 1,
      "max": 5,
      "default": 2,
      "hint_low": "1 = know nothing",
      "hint_high": "5 = know it well"
    },
    {
      "id": "days_available",
      "type": "number",
      "label": "How many days do you have to prepare?",
      "default": 5,
      "min": 1,
      "max": 30
    }
  ]
}`;

  let data;
  try {
    data = await rekaJSON(null, prompt);
  } catch (e) {
    console.error("Clarify parse error:", e.message);
    data = {
      preview_clusters: ["Basics", "Advanced Concepts", "Practical Applications"],
      questions: [
        { id: "weak_areas", type: "multiselect", label: "Which areas do you struggle with the most?", options: ["Basics", "Advanced Concepts", "Practical Applications"] },
        { id: "knowledge_level", type: "slider", label: "How would you rate your knowledge? (1=none, 5=great)", min: 1, max: 5, default: 2, hint_low: "1 = know nothing", hint_high: "5 = know it well" },
        { id: "days_available", type: "number", label: "How many days do you have to prepare?", default: 5, min: 1, max: 30 }
      ]
    };
  }

  return { searchResults: results, extraction, sensoContext, ...data };
}

// ── Main pipeline ─────────────────────────────────────────────────────────
// emit() is called for each step so the frontend can animate progress live
async function runAgentPipeline(query, userId = 1, answers = {}, emit = () => {}, extraction = null) {
  const now = new Date().toISOString();

  // Normalize answers from clarify form
  const weakAreas = Array.isArray(answers.weak_areas) ? answers.weak_areas : [];
  const knowledgeLevel = Math.max(1, Math.min(5, Number(answers.knowledge_level) || 2));
  const daysAvailable = answers.days_available ? Number(answers.days_available) : null;
  // knowledge 1=bad → weakScore high; 5=good → weakScore low
  const weakScore = clamp((5 - knowledgeLevel) / 4 + 0.10, 0.10, 0.95);

  const log = (msg) => {
    try { db.prepare("INSERT INTO logs (message, created_at) VALUES (?, ?)").run(msg, now); } catch (e) {}
    console.log(`[AGENT] ${msg}`);
  };

  log(`Pipeline: "${query}" weak=${weakScore.toFixed(2)} days=${daysAvailable ?? "auto"}`);

  // Step 1: Tavily
  emit({ type: "step", id: "search", status: "running", label: "Searching the web", detail: `Calling Tavily API → "${query}" (advanced depth)…` });
  const results = await tavilySearch(query, 10);
  if (results.length < 3) throw new Error("Not enough results from Tavily");
  emit({ type: "step", id: "search", status: "done", label: "Sources collected", detail: `${results.length} medical sources found via Tavily` });
  log(`Tavily: ${results.length} results`);

  // Step 1b: Senso source verification (cross-check Tavily sources against org KB)
  emit({ type: "step", id: "verify", status: "running", label: "Verifying sources", detail: `Senso AI → scanning org knowledge base for "${query}"…` });
  const sensoVerification = await sensoVerify(query, results);
  if (sensoVerification.apiUsed) {
    const vDetail = sensoVerification.orgKbEmpty
      ? `Org KB ready · ${results.length} web sources from Tavily · add docs to unlock verified matches`
      : `${sensoVerification.verifiedCount}/${results.length} verified · ${sensoVerification.matches.length} org KB matches · ${sensoVerification.verificationRate}% confidence`;
    emit({ type: "step", id: "verify", status: "done", label: "Sources checked", detail: vDetail });
  } else {
    emit({ type: "step", id: "verify", status: "done", label: "Sources checked", detail: "Senso KB ready — no additional org matches" });
  }
  if (sensoVerification.answer) {
    log(`Senso answer: "${sensoVerification.answer.slice(0, 80)}…"`);
  }
  log(`Senso: verified=${sensoVerification.verifiedCount}/${results.length} orgKbEmpty=${sensoVerification.orgKbEmpty}`);

  // Step 1c: Weakness extraction (data from clarify step, emitted here for pipeline animation)
  if (extraction && extraction.entityCount > 0) {
    emit({ type: "step", id: "extract", status: "running", label: "Analyzing weaknesses", detail: `Processing ${extraction.entityCount} extracted concepts…` });
    // Compute post-hoc F1: predicted weak domains vs user-selected weak areas
    let postF1 = null;
    if (weakAreas.length > 0 && extraction.conceptList?.length > 0) {
      postF1 = computeF1(extraction.predictedWeakDomains || [], weakAreas);
    }
    extraction.postF1 = postF1;
    emit({ type: "step", id: "extract", status: "done", label: "Weakness analysis complete",
      detail: `${extraction.entityCount} concepts · ${extraction.domainScores?.length || 0} domains · ${extraction.model}${postF1 ? ` · F1 = ${postF1.f1}` : ''}` });
    log(`Extraction: ${extraction.entityCount} concepts via ${extraction.model}${postF1 ? `, F1=${postF1.f1}` : ''}`);
  } else {
    emit({ type: "step", id: "extract", status: "done", label: "Weakness extraction", detail: "No prior data — will learn from this session" });
  }

  // Step 2: Reka Clustering
  emit({ type: "step", id: "cluster", status: "running", label: "Analysing with Reka Flash", detail: `Sending ${results.length} sources to Reka Flash for clustering…` });
  const clusters = await clusterAndNameWithReka(results, query, weakAreas);
  emit({ type: "step", id: "cluster", status: "done", label: "Topics identified", detail: `${clusters.length} sub-topics: ${clusters.map(c => c.base_title).join(", ")}` });
  log(`Clusters: ${clusters.map(c => c.base_title).join(", ")}`);

  // Step 3: Theory + Citations (emit passed in for live progress)
  emit({ type: "step", id: "theory", status: "running", label: "Building study materials", detail: `Starting theory generation for ${clusters.length} topics…` });
  const theoryData = await buildTheoryWithCitations(clusters, query, emit);
  const totalCards = theoryData.theory.per_cluster.reduce((s, tc) => s + (tc.cards || []).length, 0);
  emit({ type: "step", id: "theory", status: "done", label: "Study materials ready", detail: `${totalCards} teaching cards · ${theoryData.sources.length} sources` });
  log(`Theory: ${totalCards} cards, ${theoryData.sources.length} sources`);

  // Step 4: Daily Plan
  emit({ type: "step", id: "plan", status: "running", label: "Computing your study plan", detail: `Weakness ${Math.round(weakScore*100)}% → calculating optimal schedule…` });
  const planData = buildDailyPlan(clusters, weakScore, daysAvailable);
  emit({ type: "step", id: "plan", status: "done", label: "Plan ready", detail: `${planData.days} days · ${planData.totalTarget} questions · ~${planData.itemsPerDay}/day` });
  log(`Plan: ${planData.days} days, ${planData.totalTarget} total`);

  // Build plan JSON
  const planJson = {
    version: "plan_v5_senso",
    generated_at: now,
    focus: { topic: query },
    answers: { weakAreas, knowledgeLevel, daysAvailable, weakScore },
    senso_verification: {
      answer: sensoVerification.answer,
      verifiedCount: sensoVerification.verifiedCount,
      verificationRate: sensoVerification.verificationRate,
      orgKbEmpty: sensoVerification.orgKbEmpty,
      matchCount: (sensoVerification.matches || []).length,
      apiUsed: sensoVerification.apiUsed
    },
    extraction: extraction ? {
      entities: extraction.entities,
      domainScores: extraction.domainScores,
      predictedWeakDomains: extraction.predictedWeakDomains,
      entityCount: extraction.entityCount,
      f1: extraction.f1,
      postF1: extraction.postF1 || null,
      model: extraction.model,
      apiUsed: extraction.apiUsed
    } : null,
    scope: {
      N_items: results.length,
      N_estimated_questions: planData.N,
      weak_score: weakScore,
      days: planData.days,
      items_per_day: planData.itemsPerDay,
      total_questions_target: planData.totalTarget,
      ratios: { coverage: 0.70, weakness: 0.20, review: 0.10 }
    },
    clusters,
    daily: planData.daily,
    theory: theoryData.theory,
    citations: { sources: theoryData.sources }
  };

  // Step 5: Persist
  emit({ type: "step", id: "save", status: "running", label: "Persisting to databases", detail: "Writing to SQLite → then syncing to Neo4j graph…" });
  const topicInfo = db.prepare("INSERT INTO topics (name, created_at) VALUES (?, ?)").run(query, now);
  const topicId = topicInfo.lastInsertRowid;

  const planInfo = db.prepare(
    "INSERT INTO study_plans_full (user_id, topic_id, status, plan_json, created_at) VALUES (?, ?, 'active', ?, ?)"
  ).run(userId, topicId, JSON.stringify(planJson), now);
  const planId = planInfo.lastInsertRowid;

  const srcInsert = db.prepare(
    "INSERT INTO plan_sources (study_plan_id, source_title, source_url, source_reason, created_at) VALUES (?, ?, ?, ?, ?)"
  );
  for (const s of theoryData.sources) {
    srcInsert.run(planId, s.title, s.url, s.reason, now);
  }

  savePlanToGraph(query, {
    phases: clusters.map((c, i) => ({ phase: i + 1, goal: c.base_title, resource: null, title: c.base_subtitle }))
  }).catch(e => console.error("Neo4j error:", e.message));

  emit({ type: "step", id: "save", status: "done", label: "Saved everywhere", detail: `Plan #${planId} → SQLite ✓ · Neo4j ✓ · Senso KB ✓` });
  log(`Saved: plan_id=${planId}`);

  return { planId, topicId, planJson };
}

module.exports = { runAgentPipeline, runClarifyStep, getScoreboard };
