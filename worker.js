/**
 * AppZed cost-optimizer (managed=true). Inventories billable resources by tag,
 * produces AI cost recommendations, stores weekly reports.
 * Bindings: AI, GOV (kv). Vars: CF_ACCOUNT_ID. Secrets: CF_API_TOKEN.
 */
const API = "https://api.cloudflare.com/client/v4";

async function cf(env, path) {
  const res = await fetch(API + path, { headers: { authorization: "Bearer " + env.CF_API_TOKEN } });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.success !== true) {
    throw new Error("Cloudflare API " + path + " failed: HTTP " + res.status);
  }
  return json.result;
}

async function inventory(env) {
  const acct = env.CF_ACCOUNT_ID;
  const results = await Promise.all([
    cf(env, "/accounts/" + acct + "/tags/resources?per_page=100").catch(() => []),
    cf(env, "/accounts/" + acct + "/workers/scripts?per_page=100").catch(() => []),
    cf(env, "/accounts/" + acct + "/queues?per_page=100").catch(() => []),
    cf(env, "/accounts/" + acct + "/d1/database?per_page=100").catch(() => []),
    cf(env, "/accounts/" + acct + "/storage/kv/namespaces?per_page=100").catch(() => []),
    cf(env, "/accounts/" + acct + "/r2/buckets?per_page=100").catch(() => []),
  ]);
  const names = (rows) => (Array.isArray(rows) ? rows : []).map((r) => r.name || r.title || r.queue_name || "?");
  const tagList = Array.isArray(results[0]) ? results[0] : [];
  const byCustomer = {};
  for (const t of tagList) {
    const c = (t.tags && t.tags["appzed:customer"]) || "untagged";
    byCustomer[c] = (byCustomer[c] || 0) + 1;
  }
  return {
    at: new Date().toISOString(),
    counts: {
      workers: names(results[1]).length, queues: names(results[2]).length, d1: names(results[3]).length,
      kv: names(results[4]).length, r2: names(results[5]).length, tagged: tagList.length,
    },
    by_customer: byCustomer,
    managed_workers: names(results[1]).filter((n) => n.startsWith("appzed-")),
  };
}

async function recommend(env, inv) {
  const out = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
    messages: [
      { role: "system", content: "You are a FinOps analyst for Cloudflare. Given this resource inventory, list the top 5 cost optimizations with expected impact (high/medium/low). Concrete and specific." },
      { role: "user", content: JSON.stringify(inv).slice(0, 8000) },
    ],
    max_tokens: 600,
  });
  return out.response || "";
}

async function runReport(env) {
  const inv = await inventory(env);
  let recommendations = "";
  try { recommendations = await recommend(env, inv); } catch { recommendations = "AI analysis unavailable."; }
  const report = { at: inv.at, counts: inv.counts, by_customer: inv.by_customer, recommendations };
  await env.GOV.put("cost:latest", JSON.stringify(report));
  await env.GOV.put("cost:" + inv.at.slice(0, 10), JSON.stringify(report));
  return report;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) {
      return Response.json({ error: "Missing CF_API_TOKEN secret or CF_ACCOUNT_ID var." }, { status: 500 });
    }
    try {
      if (url.pathname === "/health") return Response.json({ ok: true, solution: "cost-optimizer" });
      if (url.pathname === "/inventory") return Response.json(await inventory(env));
      if (url.pathname === "/recommend") {
        const inv = await inventory(env);
        return Response.json({ at: inv.at, recommendations: await recommend(env, inv) });
      }
      if (url.pathname === "/report") {
        const latest = await env.GOV.get("cost:latest", "json");
        if (!latest) return Response.json({ error: "No report yet. GET /recommend to run one." }, { status: 404 });
        return Response.json(latest);
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return Response.json({ error: String((err && err.message) || err) }, { status: 502 });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReport(env).catch(() => null));
  },
};
