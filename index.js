require("dotenv").config();
const express = require("express");
const axios = require("axios");
const neo4j = require("neo4j-driver");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// --- Neo4j ---
const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

// --- Root ---
app.get("/", (req, res) => {
  res.send("Medstart Autonomous Agent is running.");
});

// --- Run Agent ---
app.post("/run-agent", async (req, res) => {
  try {
    // 1️⃣ Fake user performance data
    const userData = [
      { topic: "Cell Biology", accuracy: 0.45 },
      { topic: "Genetics", accuracy: 0.72 },
      { topic: "Physiology", accuracy: 0.60 }
    ];

    // 2️⃣ Find weakest topic
    const weakest = userData.reduce((min, curr) =>
      curr.accuracy < min.accuracy ? curr : min
    );

    // 3️⃣ Store in Neo4j
    const session = driver.session();
    await session.run(
      `
      MERGE (u:User {id: "demo-user"})
      MERGE (t:Topic {name: $topic})
      MERGE (u)-[:WEAK_IN]->(t)
      `,
      { topic: weakest.topic }
    );
    await session.close();

    // 4️⃣ Tavily Search
    const tavilyResponse = await axios.post(
      "https://api.tavily.com/search",
      {
        api_key: process.env.TAVILY_API_KEY,
        query: `${weakest.topic} overview for medical entrance exam`,
        search_depth: "basic",
        max_results: 3
      }
    );

    const sources = tavilyResponse.data.results || [];

    // 5️⃣ Simple Study Plan
    const plan = {
      weakest_topic: weakest.topic,
      days: [
        { day: 1, task: "Review core theory" },
        { day: 2, task: "Practice 40 questions" },
        { day: 3, task: "Revision + weak areas" }
      ],
      sources: sources.map(s => ({
        title: s.title,
        url: s.url
      }))
    };

    res.json({
      status: "Agent executed successfully",
      graph_updated: true,
      plan
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Agent failed" });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
