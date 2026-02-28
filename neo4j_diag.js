require("dotenv").config();
const neo4j = require("neo4j-driver");

(async () => {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const pass = process.env.NEO4J_PASSWORD;

  if (!uri || !user || !pass) {
    console.log("ENV FAIL", { uri, user, passLen: (pass || "").length });
    process.exit(1);
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));

  try {
    const info = await driver.getServerInfo();
    console.log("CONNECT OK", info);

    const session = driver.session();
    try {
      const r = await session.run("SHOW DATABASES");
      console.log("DATABASES:");
      for (const rec of r.records) {
        const name = rec.get("name");
        const isDefault = rec.keys.includes("default") ? rec.get("default") : null;
        const home = rec.keys.includes("home") ? rec.get("home") : null;
        console.log("-", name, "default:", isDefault, "home:", home);
      }
    } finally {
      await session.close();
    }

    console.log("DONE");
  } catch (e) {
    console.log("FAIL", e.message);
    process.exit(2);
  } finally {
    await driver.close();
  }
})();
