// Cloudflare Worker: authenticated CSV editor for kingshot_players.csv
//
// Auth: Google ID Token (verified via Google's tokeninfo endpoint),
// email must be in env.ALLOWED_EMAILS.
//
// Endpoints:
//   GET  /api/csv  -> { content: string, sha: string }
//   PUT  /api/csv  body { content, sha } -> { commit, sha }

const GH_API = "https://api.github.com";
const TOKENINFO = "https://oauth2.googleapis.com/tokeninfo?id_token=";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function withCors(resp, origin) {
  const h = corsHeaders(origin);
  for (const [k, v] of Object.entries(h)) resp.headers.set(k, v);
  return resp;
}

function pickOrigin(env, origin) {
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

async function verifyIdToken(idToken, env) {
  const r = await fetch(TOKENINFO + encodeURIComponent(idToken));
  if (!r.ok) return { ok: false, status: 401, reason: "tokeninfo http " + r.status };
  const p = await r.json();
  if (p.aud !== env.GOOGLE_CLIENT_ID) return { ok: false, status: 401, reason: "aud mismatch" };
  if (String(p.email_verified) !== "true") return { ok: false, status: 401, reason: "email not verified" };
  const allow = (env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!allow.includes((p.email || "").toLowerCase())) {
    return { ok: false, status: 403, reason: "email not allowlisted" };
  }
  return { ok: true, email: p.email };
}

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

async function ghGetCsv(env) {
  const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${encodeURIComponent(env.CSV_PATH)}?ref=${env.GH_BRANCH || "main"}`;
  const r = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "kingshot-csv-worker",
      "Accept": "application/vnd.github+json",
    },
  });
  if (!r.ok) throw new Error(`GH GET ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return { content: b64decodeUtf8(j.content), sha: j.sha };
}

async function ghPutCsv(env, content, sha, email) {
  const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${encodeURIComponent(env.CSV_PATH)}`;
  const body = {
    message: `Update player list via web UI (by ${email})`,
    content: b64encodeUtf8(content),
    sha,
    branch: env.GH_BRANCH || "main",
  };
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "kingshot-csv-worker",
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GH PUT ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return { commit: j.commit.sha, sha: j.content.sha };
}

async function ghDispatchRedeem(env, codes, email) {
  const wf = env.REDEEM_WORKFLOW || "bulk_redeem.yml";
  const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${wf}/dispatches`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "kingshot-csv-worker",
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.GH_BRANCH || "main", inputs: { codes } }),
  });
  // GitHub returns 204 No Content on a successful dispatch.
  if (!r.ok) throw new Error(`GH dispatch ${r.status}: ${await r.text()}`);
  return { ok: true };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    const okOrigin = pickOrigin(env, origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(okOrigin || "null") });
    }
    if (!okOrigin) {
      return new Response("Forbidden origin", { status: 403 });
    }

    const auth = req.headers.get("Authorization") || "";
    const m = auth.match(/^Bearer (.+)$/);
    if (!m) {
      return withCors(new Response("missing Authorization", { status: 401 }), okOrigin);
    }
    const v = await verifyIdToken(m[1], env);
    if (!v.ok) {
      return withCors(new Response(v.reason, { status: v.status }), okOrigin);
    }

    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/csv" && req.method === "GET") {
        const data = await ghGetCsv(env);
        return withCors(
          new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } }),
          okOrigin,
        );
      }
      if (url.pathname === "/api/csv" && req.method === "PUT") {
        const body = await req.json();
        if (typeof body.content !== "string" || typeof body.sha !== "string") {
          return withCors(new Response("bad payload", { status: 400 }), okOrigin);
        }
        const headOk = /^﻿?ID,角色名稱/.test(body.content);
        if (!headOk) {
          return withCors(new Response("CSV must start with 'ID,角色名稱' header", { status: 400 }), okOrigin);
        }
        const out = await ghPutCsv(env, body.content, body.sha, v.email);
        return withCors(
          new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } }),
          okOrigin,
        );
      }
      if (url.pathname === "/api/redeem" && req.method === "POST") {
        const body = await req.json();
        const codes = (typeof body.codes === "string" ? body.codes : "").trim();
        if (!codes) {
          return withCors(new Response("codes required", { status: 400 }), okOrigin);
        }
        // Gift codes are alphanumeric; allow comma/space separators only.
        if (!/^[A-Za-z0-9]+([,\s]+[A-Za-z0-9]+)*$/.test(codes)) {
          return withCors(new Response("invalid code format", { status: 400 }), okOrigin);
        }
        await ghDispatchRedeem(env, codes, v.email);
        return withCors(
          new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }),
          okOrigin,
        );
      }
      return withCors(new Response("not found", { status: 404 }), okOrigin);
    } catch (e) {
      return withCors(new Response(e.message || String(e), { status: 500 }), okOrigin);
    }
  },
};
