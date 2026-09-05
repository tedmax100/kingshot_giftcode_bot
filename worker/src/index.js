// Cloudflare Worker: authenticated CSV editor for kingshot_players.csv,
// plus the KvK prep sign-up API (see web/kvk_prep_design.md).
//
// Auth:
//   - Google ID Token (verified via Google's tokeninfo endpoint),
//     email must be in env.ALLOWED_EMAILS. Used for admin-only routes.
//   - Service token (env.KVK_CLOSE_TOKEN) via `Authorization: Bearer <token>`.
//     Used only by the scheduled GitHub Action that closes finished rounds.
//   - Some KvK routes are public (no auth) by design — see the table below.
//
// Endpoints:
//   GET  /api/csv  -> { content: string, sha: string }                          [google]
//   PUT  /api/csv  body { content, sha } -> { commit, sha }                     [google]
//   POST /api/redeem  body { codes }                                           [google]
//   POST /api/kvk/rounds  body { round, startDate } -> { round, issue, ... }    [google]
//   GET  /api/kvk/rounds/:round -> { round, issue, startDate, status, url }     [public]
//   POST /api/kvk/rounds/:round/submissions  body { playerId, ... }            [public]
//   GET  /api/kvk/rounds/:round/submissions/:playerId -> { playerId, ... }     [public]
//   GET  /api/kvk/rounds/:round/submissions -> [ { playerId, ... }, ... ]       [google]
//   POST /api/kvk/rounds/:round/close                                          [google]
//   POST /api/kvk/rounds/close-due                                             [service token]

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

function ghHeaders(env, extra) {
  return {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "kingshot-csv-worker",
    "Accept": "application/vnd.github+json",
    ...extra,
  };
}

const KVK_LABEL = "kvk-prep";
const KVK_CLOSED_LABEL = "kvk-prep-closed";

// --- kvk_rounds.json (GitHub Contents API) ---------------------------------

async function ghGetRoundsFile(env) {
  const path = env.KVK_ROUNDS_PATH || "kvk_rounds.json";
  const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${encodeURIComponent(path)}?ref=${env.GH_BRANCH || "main"}`;
  const r = await fetch(url, { headers: ghHeaders(env) });
  if (r.status === 404) return { rounds: {}, sha: null };
  if (!r.ok) throw new Error(`GH GET rounds ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const rounds = JSON.parse(b64decodeUtf8(j.content) || "{}");
  return { rounds, sha: j.sha };
}

async function ghPutRoundsFile(env, rounds, sha, message) {
  const path = env.KVK_ROUNDS_PATH || "kvk_rounds.json";
  const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: b64encodeUtf8(JSON.stringify(rounds, null, 2) + "\n"),
    branch: env.GH_BRANCH || "main",
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: "PUT",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GH PUT rounds ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.content.sha;
}

// --- Issues / comments -------------------------------------------------

async function ghCreateIssue(env, { title, body, labels }) {
  const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/issues`;
  const r = await fetch(url, {
    method: "POST",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ title, body, labels }),
  });
  if (!r.ok) throw new Error(`GH create issue ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ghAddLabels(env, issueNumber, labels) {
  const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/issues/${issueNumber}/labels`;
  const r = await fetch(url, {
    method: "POST",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ labels }),
  });
  if (!r.ok) throw new Error(`GH add labels ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ghCloseIssue(env, issueNumber) {
  const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/issues/${issueNumber}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ state: "closed" }),
  });
  if (!r.ok) throw new Error(`GH close issue ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ghListAllComments(env, issueNumber) {
  const out = [];
  let page = 1;
  for (;;) {
    const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/issues/${issueNumber}/comments?per_page=100&page=${page}`;
    const r = await fetch(url, { headers: ghHeaders(env) });
    if (!r.ok) throw new Error(`GH list comments ${r.status}: ${await r.text()}`);
    const batch = await r.json();
    out.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return out;
}

async function ghCreateComment(env, issueNumber, body) {
  const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/issues/${issueNumber}/comments`;
  const r = await fetch(url, {
    method: "POST",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ body }),
  });
  if (!r.ok) throw new Error(`GH create comment ${r.status}: ${await r.text()}`);
  return r.json();
}

async function ghUpdateComment(env, commentId, body) {
  const url = `${GH_API}/repos/${env.GH_OWNER}/${env.GH_REPO}/issues/comments/${commentId}`;
  const r = await fetch(url, {
    method: "PATCH",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ body }),
  });
  if (!r.ok) throw new Error(`GH update comment ${r.status}: ${await r.text()}`);
  return r.json();
}

// --- KvK submission formatting -------------------------------------------

// Matches the day tabs actually defined in kvk_calculator.html's DAYS array
// (only Day 1/2/4 currently have scoring rules — not every calendar day of
// the event has its own availability tab).
const DAY_KEYS = ["day1", "day2", "day4"];

// Mirrors the 48-slot grid in kvk_calculator.html: slot 0 = 08:00 same day,
// each slot is 30 minutes, wrapping past midnight into the next day (+1).
function slotIndexToLabel(idx) {
  const totalMin = 8 * 60 + idx * 30;
  const dayOffset = totalMin >= 24 * 60 ? 1 : 0;
  const mins = totalMin % (24 * 60);
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}${dayOffset ? "+1" : ""}`;
}

function slotsToRanges(slotIndexes) {
  // slotIndexes: array of 30-min slot indices (0-47, see slotIndexToLabel) -> merged into ranges.
  if (!Array.isArray(slotIndexes) || slotIndexes.length === 0) return "（未登記）";
  const sorted = [...new Set(slotIndexes.map(Number))].filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return "（未登記）";
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - prev > 1) {
      ranges.push([start, prev]);
      start = sorted[i];
    }
    prev = sorted[i];
  }
  ranges.push([start, prev]);
  return ranges.map(([s, e]) => `${slotIndexToLabel(s)}–${slotIndexToLabel(e + 1)}`).join(", ");
}

function buildSubmissionComment(sub) {
  const lines = [];
  lines.push(`### 🧑‍🚀 ${sub.playerName}（ID: ${sub.playerId}，聯盟: ${sub.guild || "未填"}）`);
  lines.push("");
  DAY_KEYS.forEach((key) => {
    const dayNum = key.replace("day", "");
    const slots = sub.availability ? sub.availability[key] : undefined;
    lines.push(`**Day ${dayNum}**：${slotsToRanges(slots)}`);
    const itemLines = sub.itemsText && Array.isArray(sub.itemsText[key]) ? sub.itemsText[key] : [];
    itemLines.forEach((line) => lines.push(`　- ${line}`));
  });
  lines.push("");
  lines.push("<details>");
  lines.push("<summary>raw</summary>");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(sub, null, 2));
  lines.push("```");
  lines.push("</details>");
  return lines.join("\n");
}

function parseSubmissionComment(commentBody) {
  const m = commentBody.match(/```json\n([\s\S]*?)\n```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// --- Validation ------------------------------------------------------------

function isValidDateStr(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidRound(round) {
  return Number.isInteger(round) && round > 0;
}

function taipeiTodayStr() {
  // en-CA locale formats as YYYY-MM-DD.
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}

function isRoundDue(entry, todayStr) {
  const start = new Date(entry.startDate + "T00:00:00+08:00");
  const due = new Date(start.getTime() + 5 * 24 * 60 * 60 * 1000);
  const today = new Date(todayStr + "T00:00:00+08:00");
  return today.getTime() >= due.getTime();
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // The close-due endpoint is called server-to-server by a GitHub Actions
    // schedule (see .github/workflows/kvk_prep_close.yml) — no browser
    // Origin header, and auth is a static service token, not Google OAuth.
    if (url.pathname === "/api/kvk/rounds/close-due" && req.method === "POST") {
      const auth = req.headers.get("Authorization") || "";
      const m = auth.match(/^Bearer (.+)$/);
      if (!m || !env.KVK_CLOSE_TOKEN || m[1] !== env.KVK_CLOSE_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      try {
        const { rounds, sha } = await ghGetRoundsFile(env);
        const today = taipeiTodayStr();
        const closed = [];
        for (const [round, entry] of Object.entries(rounds)) {
          if (entry.status === "open" && isRoundDue(entry, today)) {
            await ghAddLabels(env, entry.issue, [KVK_CLOSED_LABEL]);
            await ghCloseIssue(env, entry.issue);
            entry.status = "closed";
            closed.push(Number(round));
          }
        }
        if (closed.length > 0) {
          await ghPutRoundsFile(env, rounds, sha, `Close due KvK prep rounds: ${closed.join(", ")}`);
        }
        return new Response(JSON.stringify({ ok: true, closed }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return new Response(e.message || String(e), { status: 500 });
      }
    }

    const origin = req.headers.get("Origin");
    const okOrigin = pickOrigin(env, origin);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(okOrigin || "null") });
    }
    if (!okOrigin) {
      return new Response("Forbidden origin", { status: 403 });
    }

    // Routes that don't require Google login (public, but still same-origin
    // enforced above): looking up a round's info, submitting availability,
    // and a player looking up their own past submission by playerId.
    const publicRoutes =
      (url.pathname.match(/^\/api\/kvk\/rounds\/([^/]+)$/) && req.method === "GET") ||
      (url.pathname.match(/^\/api\/kvk\/rounds\/([^/]+)\/submissions$/) && req.method === "POST") ||
      (url.pathname.match(/^\/api\/kvk\/rounds\/([^/]+)\/submissions\/([^/]+)$/) && req.method === "GET");

    let v = null;
    if (!publicRoutes) {
      const auth = req.headers.get("Authorization") || "";
      const m = auth.match(/^Bearer (.+)$/);
      if (!m) {
        return withCors(new Response("missing Authorization", { status: 401 }), okOrigin);
      }
      v = await verifyIdToken(m[1], env);
      if (!v.ok) {
        return withCors(new Response(v.reason, { status: v.status }), okOrigin);
      }
    }

    try {
      // --- KvK prep sign-up routes ---------------------------------------

      if (url.pathname === "/api/kvk/rounds" && req.method === "POST") {
        const body = await req.json();
        const round = Number(body.round);
        if (!isValidRound(round) || !isValidDateStr(body.startDate)) {
          return withCors(new Response("round (positive int) and startDate (YYYY-MM-DD) required", { status: 400 }), okOrigin);
        }
        const { rounds, sha } = await ghGetRoundsFile(env);
        if (rounds[round]) {
          return withCors(new Response(`round ${round} already exists`, { status: 409 }), okOrigin);
        }
        const signupUrl = `https://${env.GH_OWNER}.github.io/${env.GH_REPO}/kvk_calculator.html#${round}`;
        const issue = await ghCreateIssue(env, {
          title: `KvK #${round}`,
          body: `## KvK #${round} 前哨戰報名\n\n報名頁：${signupUrl}\n\n幹部請在下方留言中查看玩家登記資料。`,
          labels: [KVK_LABEL],
        });
        // GitHub's create-issue endpoint doesn't reliably attach `labels`
        // passed inline — apply it explicitly to be sure.
        await ghAddLabels(env, issue.number, [KVK_LABEL]);
        rounds[round] = { issue: issue.number, startDate: body.startDate, status: "open" };
        await ghPutRoundsFile(env, rounds, sha, `Open KvK #${round} prep sign-up (by ${v.email})`);
        return withCors(
          new Response(JSON.stringify({ round, issue: issue.number, startDate: body.startDate, status: "open", url: signupUrl }), {
            headers: { "Content-Type": "application/json" },
          }),
          okOrigin,
        );
      }

      const roundMatch = url.pathname.match(/^\/api\/kvk\/rounds\/([^/]+)$/);
      if (roundMatch && req.method === "GET") {
        const round = Number(roundMatch[1]);
        const { rounds } = await ghGetRoundsFile(env);
        const entry = rounds[round];
        if (!entry) {
          return withCors(new Response("round not found", { status: 404 }), okOrigin);
        }
        const signupUrl = `https://${env.GH_OWNER}.github.io/${env.GH_REPO}/kvk_calculator.html#${round}`;
        return withCors(
          new Response(JSON.stringify({ round, issue: entry.issue, startDate: entry.startDate, status: entry.status, url: signupUrl }), {
            headers: { "Content-Type": "application/json" },
          }),
          okOrigin,
        );
      }

      const submissionsMatch = url.pathname.match(/^\/api\/kvk\/rounds\/([^/]+)\/submissions$/);
      if (submissionsMatch && req.method === "POST") {
        const round = Number(submissionsMatch[1]);
        const { rounds } = await ghGetRoundsFile(env);
        const entry = rounds[round];
        if (!entry) {
          return withCors(new Response("round not found", { status: 404 }), okOrigin);
        }
        if (entry.status !== "open") {
          return withCors(new Response("round is closed", { status: 409 }), okOrigin);
        }
        const body = await req.json();
        const playerId = String(body.playerId || "").trim();
        const playerName = String(body.playerName || "").trim();
        if (!playerId || !playerName) {
          return withCors(new Response("playerId and playerName required", { status: 400 }), okOrigin);
        }
        const sub = {
          round,
          playerId,
          playerName,
          guild: String(body.guild || "").trim(),
          submittedAt: new Date().toISOString(),
          availability: body.availability && typeof body.availability === "object" ? body.availability : {},
          items: body.items && typeof body.items === "object" ? body.items : {},
          itemsText: body.itemsText && typeof body.itemsText === "object" ? body.itemsText : {},
        };
        const commentBody = buildSubmissionComment(sub);
        const comments = await ghListAllComments(env, entry.issue);
        const existing = comments.find((c) => {
          const parsed = parseSubmissionComment(c.body || "");
          return parsed && String(parsed.playerId) === playerId && Number(parsed.round) === round;
        });
        if (existing) {
          await ghUpdateComment(env, existing.id, commentBody);
        } else {
          await ghCreateComment(env, entry.issue, commentBody);
        }
        return withCors(
          new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }),
          okOrigin,
        );
      }

      const submissionByPlayerMatch = url.pathname.match(/^\/api\/kvk\/rounds\/([^/]+)\/submissions\/([^/]+)$/);
      if (submissionByPlayerMatch && req.method === "GET") {
        const round = Number(submissionByPlayerMatch[1]);
        const playerId = decodeURIComponent(submissionByPlayerMatch[2]);
        const { rounds } = await ghGetRoundsFile(env);
        const entry = rounds[round];
        if (!entry) {
          return withCors(new Response("round not found", { status: 404 }), okOrigin);
        }
        const comments = await ghListAllComments(env, entry.issue);
        const found = comments
          .map((c) => parseSubmissionComment(c.body || ""))
          .find((s) => s && Number(s.round) === round && String(s.playerId) === playerId);
        if (!found) {
          return withCors(new Response("no submission for this playerId", { status: 404 }), okOrigin);
        }
        return withCors(
          new Response(JSON.stringify(found), { headers: { "Content-Type": "application/json" } }),
          okOrigin,
        );
      }

      const submissionsGetMatch = url.pathname.match(/^\/api\/kvk\/rounds\/([^/]+)\/submissions$/);
      if (submissionsGetMatch && req.method === "GET") {
        const round = Number(submissionsGetMatch[1]);
        const { rounds } = await ghGetRoundsFile(env);
        const entry = rounds[round];
        if (!entry) {
          return withCors(new Response("round not found", { status: 404 }), okOrigin);
        }
        const comments = await ghListAllComments(env, entry.issue);
        const submissions = comments
          .map((c) => parseSubmissionComment(c.body || ""))
          .filter((s) => s && Number(s.round) === round);
        return withCors(
          new Response(JSON.stringify(submissions), { headers: { "Content-Type": "application/json" } }),
          okOrigin,
        );
      }

      const closeMatch = url.pathname.match(/^\/api\/kvk\/rounds\/([^/]+)\/close$/);
      if (closeMatch && req.method === "POST") {
        const round = Number(closeMatch[1]);
        const { rounds, sha } = await ghGetRoundsFile(env);
        const entry = rounds[round];
        if (!entry) {
          return withCors(new Response("round not found", { status: 404 }), okOrigin);
        }
        if (entry.status !== "closed") {
          await ghAddLabels(env, entry.issue, [KVK_CLOSED_LABEL]);
          await ghCloseIssue(env, entry.issue);
          entry.status = "closed";
          await ghPutRoundsFile(env, rounds, sha, `Close KvK #${round} prep sign-up (by ${v.email})`);
        }
        return withCors(
          new Response(JSON.stringify({ round, status: "closed" }), { headers: { "Content-Type": "application/json" } }),
          okOrigin,
        );
      }

      // --- Existing routes -------------------------------------------------

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
