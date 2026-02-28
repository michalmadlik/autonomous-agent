const OpenAI = require("openai");
require("dotenv").config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function generateAutonomousPlan(query, searchResults) {
  const prompt = `
    You are an autonomous study agent. 
    Topic: ${query}
    Search Results: ${JSON.stringify(searchResults)}

    Based on these results, create a 3-phase study plan. 
    Each phase must have a 'goal', a 'title' for the resource, and the 'resource' URL itself.
    Return ONLY a JSON object in this format:
    {
      "phases": [
        { "phase": 1, "goal": "description", "title": "title", "resource": "url" },
        ...
      ]
    }
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    console.error("LLM Generation Error:", error);
    // Fallback to basic plan if LLM fails
    return {
      phases: searchResults.slice(0, 3).map((r, i) => ({
        phase: i + 1,
        goal: "Study this resource",
        title: r.title,
        resource: r.url
      }))
    };
  }
}

module.exports = { generateAutonomousPlan };
