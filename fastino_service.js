const axios = require("axios");
require("dotenv").config();

async function extractEntities(text) {
    if (!process.env.FASTINO_API_KEY) {
        console.warn("FASTINO_API_KEY missing.");
        return [];
    }
    
    try {
        const response = await axios.post("https://api.fastino.ai/extract", {
            text: text,
            schema: {
                entities: ["concept", "acronym", "field_of_study"]
            }
        }, {
            headers: { "Authorization": `Bearer ${process.env.FASTINO_API_KEY}` }
        });
        return response.data.entities || [];
    } catch (error) {
        console.error("Fastino error:", error.message);
        return [];
    }
}

module.exports = { extractEntities };
