require("dotenv").config();
const neo4j = require("neo4j-driver");

async function main() {
  const uri = process.env.NEO4J_URI;
  const user = process.env.NEO4J_USER;
  const pass = process.env.NEO4J_PASSWORD;

  console.log(JSON.stringify({
    uri,
    user,
    passLen: (pass || "").length
  }));

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
  try {
    const info = await driver.getServerInfo();
    console.log("CONNECT_OK");
    console.log(info);

    const session = driver.session();
    const res = await session.run("RETURN 1 AS ok");
    console.log("QUERY_OK", res.records[0].get("ok"));
    await session.close();
  } catch (e) {
    console.log("FAIL");
    console.log(e.message);
    process.exit(2);
  } finally {
    await driver.close();
  }
}

main();
