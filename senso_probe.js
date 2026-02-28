const axios = require("axios");

const KEY = "tgr_jm1vcEwI_ljiBMT_LeMTXIYmv0tvXjkkxII9SrtNG4s";
const BASE = "https://apiv2.senso.ai/api/v1";

async function probe() {
  const tests = [
    // GET endpoints
    { method: "GET", path: "/org/sources" },
    { method: "GET", path: "/org/documents" },
    { method: "GET", path: "/org/data" },
    { method: "GET", path: "/org/agent" },

    // POST with url
    { method: "POST", path: "/org/add-url", body: { url: "https://en.wikipedia.org/wiki/DNA_replication" } },
    { method: "POST", path: "/org/sources/add", body: { url: "https://example.com" } },
    { method: "POST", path: "/org/ingest", body: { url: "https://example.com" } },
    { method: "POST", path: "/org/sources", body: { url: "https://example.com" } },
    { method: "POST", path: "/org/add", body: { url: "https://example.com" } },

    // POST with text/content
    { method: "POST", path: "/org/search", body: { query: "DNA polymerase", source_filter: "web" } },
    { method: "POST", path: "/org/search", body: { query: "DNA", min_score: 0.1 } },
    { method: "POST", path: "/org/verify", body: { text: "DNA polymerase replicates DNA" } },
    { method: "POST", path: "/org/fact-check", body: { text: "DNA polymerase replicates DNA" } },
  ];

  for (const t of tests) {
    try {
      const r = await axios({
        method: t.method,
        url: BASE + t.path,
        data: t.body,
        headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
        timeout: 8000
      });
      console.log(`✓ ${t.method} ${t.path} → ${r.status} : ${JSON.stringify(r.data).slice(0, 120)}`);
    } catch (e) {
      const status = e.response?.status || "ERR";
      const msg = JSON.stringify(e.response?.data || e.message).slice(0, 80);
      console.log(`✗ ${t.method} ${t.path} → ${status} : ${msg}`);
    }
  }
}

probe();
