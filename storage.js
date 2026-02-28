const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir);
}

function savePlan(query, plan) {
  const filePath = path.join(dataDir, Date.now() + ".json");
  fs.writeFileSync(
    filePath,
    JSON.stringify({ query, plan }, null, 2)
  );
}

module.exports = { savePlan };