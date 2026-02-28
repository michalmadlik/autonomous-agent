const neo4j = require("neo4j-driver");
require("dotenv").config();

const uri = process.env.NEO4J_URI;
const user = process.env.NEO4J_USER;
const pass = process.env.NEO4J_PASSWORD;

let driver;

if (uri && user && pass) {
  driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
} else {
  console.warn("Neo4j environmental variables missing. Graph storage disabled.");
}

async function savePlanToGraph(topic, plan) {
  if (!driver) return;
  const session = driver.session();
  try {
    await session.executeWrite(async (tx) => {
      // Create Topic
      await tx.run(
        "MERGE (t:Topic {name: $topic}) ON CREATE SET t.created_at = datetime()",
        { topic }
      );

      // Create Plan steps and link them
      for (const phase of plan.phases) {
        await tx.run(
          `
          MATCH (t:Topic {name: $topic})
          MERGE (p:Phase {goal: $goal})
          SET p.phase_number = $phaseNum, p.resource = $resource
          MERGE (t)-[:HAS_PHASE]->(p)
          `,
          {
            topic,
            goal: phase.goal,
            phaseNum: phase.phase,
            resource: phase.resource
          }
        );
      }
    });
  } catch (error) {
    console.error("Neo4j write error:", error);
  } finally {
    await session.close();
  }
}

module.exports = { savePlanToGraph };
