const express = require("express");
const fetch = require("node-fetch");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

// Parse raw binary/stream bodies for proxy forwarding
app.use(express.raw({ type: "*/*", limit: "100mb" }));

// Mock standard Worker Response/Request Web APIs for exact parity
class WorkerResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.statusText = init.statusText || "OK";
    this.headers = new Map();
    if (init.headers) {
      if (init.headers instanceof Headers || init.headers instanceof Map) {
        init.headers.forEach((v, k) => this.headers.set(k.toLowerCase(), v));
      } else if (typeof init.headers === "object") {
        Object.entries(init.headers).forEach(([k, v]) => this.headers.set(k.toLowerCase(), v));
      }
    }
  }
  async text() {
    if (typeof this.body === "string") return this.body;
    if (Buffer.isBuffer(this.body)) return this.body.toString("utf-8");
    return String(this.body || "");
  }
  async json() {
    const txt = await this.text();
    return JSON.parse(txt);
  }
}

global.Response = WorkerResponse;

// Polyfill minimal caches.default for memory caching
const _cachesStorage = new Map();
global.caches = {
  default: {
    async match(req) {
      const url = typeof req === "string" ? req : req.url;
      const hit = _cachesStorage.get(url);
      if (!hit) return null;
      if (Date.now() > hit.expires) {
        _cachesStorage.delete(url);
        return null;
      }
      return new WorkerResponse(hit.data, { headers: hit.headers });
    },
    async put(req, resp) {
      const url = typeof req === "string" ? req : req.url;
      const text = await resp.text();
      const cc = resp.headers.get("cache-control") || "";
      let ttl = 86400000;
      const match = /max-age=(\d+)/.exec(cc);
      if (match) ttl = parseInt(match[1]) * 1000;
      _cachesStorage.set(url, {
        data: text,
        expires: Date.now() + ttl,
        headers: Object.fromEntries(resp.headers.entries()),
      });
    },
  },
};

// ── ORIGINAL WORKER CODE STARTS HERE ──

const ALLOWED_SHA256 = "d3ac0c33c5509ca84c3de7df7f77eb06a6b9a0314633381a87e31df7d0e3dfef";
const APPROVED_IDS_URL = "https://pastebin.com/raw/N7xy2LYx";

let APPROVED_IDS = new Set();
let LAST_IDS_FETCH = 0;

async function loadApprovedIds() {
  if (Date.now() - LAST_IDS_FETCH < 300000) return;
  try {
    const resp = await fetch(APPROVED_IDS_URL, { cf: { cacheTtl: 300 } });
    if (resp.ok) {
      const list = await resp.json();
      APPROVED_IDS = new Set(list.map((e) => e.id));
      LAST_IDS_FETCH = Date.now();
    }
  } catch (e) {}
}

function normalizeSha(header) {
  if (!header) return "";
  return header.replace(/[:-\s]/g, "").toLowerCase();
}

const workerHandler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (request.method === "GET" && path === "/api/time") return jsonResponse({ ts: Date.now() });

    // ── /api/dl/* checks token against Pastebin ──
    const dlMatch = /^\/api\/dl\/(\d+)\/(\d+)/.exec(path);
    if (request.method === "GET" && dlMatch) {
      await loadApprovedIds();
      const token = url.searchParams.get("token") || "";
      if (!APPROVED_IDS.has(token)) {
        return new Response(
          JSON.stringify({ error: "FUCK YOU", reason: "Am @ReverseEngUG" }),
          { status: 403, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
        );
      }
      return handleDownloadRedirect(request, dlMatch[1], dlMatch[2], ctx);
    }

    // ── Signature check (all other endpoints) ──
    const sha256Header = request.headers.get("X-APK-SHA256") || "";
    if (normalizeSha(sha256Header) !== normalizeSha(ALLOWED_SHA256)) {
      return new Response(
        JSON.stringify({ error: "FUCK YOU", reason: "Am @ReverseEngUG" }),
        { status: 403, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }
    // ── END ──

    if (path === "/api/debug-raw") {
      const target = url.searchParams.get("path");
      if (!target) return jsonResponse({ error: "missing ?path=" }, 400);
      const h = {
        "User-Agent": BROWSER_UA,
        Accept: "*/*",
        "Accept-Encoding": "identity",
        Referer: "https://munowatch.org/",
        Origin: "https://munowatch.org",
        "X-Requested-With": "XMLHttpRequest",
        Authorization: "Bearer " + APP_API_KEY,
      };
      try {
        const resp = await fetch(`https://munowatch.org${target}`, { headers: h });
        const text = await resp.text();
        return new Response(text, {
          status: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    const workerBase = "https://" + url.hostname;
    const fullPath = path + url.search;

    const previewMatch = /^\/api\/(?:protected\/)?preview\/v2\/(\d+)\/(\d+)/.exec(path);
    if (request.method === "GET" && previewMatch)
      return handlePreviewEnrich(request, previewMatch[1], previewMatch[2], workerBase);

    if (fullPath.startsWith("/munotek.com"))
      return proxyRequest(request, "https://munotek.com" + fullPath.replace("/munotek.com", ""), "munotek.com", workerBase);
    if (fullPath.startsWith("/munowatch.com"))
      return proxyRequest(request, "https://munowatch.com" + fullPath.replace("/munowatch.com", ""), "munowatch.com", workerBase);
    if (fullPath.startsWith("/munowatch.org"))
      return proxyRequest(request, "https://munowatch.org" + fullPath.replace("/munowatch.org", ""), "munowatch.org", workerBase);

    return proxyRequest(request, "https://munowatch.org" + fullPath, "munowatch.org", workerBase);
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

function encodeVideoUrl(rawUrl) {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl);
    u.pathname = u.pathname.split("/").map((s) => encodeURIComponent(decodeURIComponent(s))).join("/");
    return u.toString();
  } catch {
    return rawUrl.replace(/ /g, "%20");
  }
}

function isStubUrl(url) {
  if (!url || typeof url !== "string") return true;
  if (url.includes("munowatch.co/clips/") || url.includes("munowatch.org/clips/")) return true;
  if (url.trim() === "") return true;
  if (!url.includes("://") && !url.startsWith("//")) return true;
  return false;
}

const APP_API_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VybmFtZSI6IkFuZHJvaWQgVFYiLCJhcHBuYW1lIjoiTXVub3dhdGNoIFRWIiwiaG9zdCI6Im11bm93YXRjaC5jbyIsImFwcHNlY3JldCI6IjAyMjc3OGU0MThhZDY4ZmZkYTlhYTRmYWIxODkyZmZmIiwiYWN0aXZhdGVkIjoiMSIsImV4cCI6MTcwNzM2ODQwMH0.unlPnEzptg6VFHs7WWm213bRHHNxYuAN2eZQvjtPKL0";
const BROWSER_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const PREVIEW_UID_POOL = ["1", "2", "3", "100", "200", "500", "1000", "5000", "10000"];

function findVideoUrl(obj) {
  if (typeof obj === "string" && (obj.startsWith("http://") || obj.startsWith("https://") || obj.startsWith("//")) && !isStubUrl(obj)) {
    const lo = obj.toLowerCase();
    if (lo.includes(".mp4") || lo.includes(".m3u8")) return obj;
    if (lo.includes("b-cdn.net") && !lo.includes("apposters") && !lo.includes(".jpg") && !lo.includes(".png") && !lo.includes(".jpeg") && !lo.includes(".webp"))
      return obj;
  }
  if (typeof obj === "object" && obj !== null) {
    for (const v of Object.values(obj)) {
      const found = findVideoUrl(v);
      if (found) return found;
    }
  }
  return null;
}

const _cdnUrlCache = new Map();
const CDN_CACHE_TTL = 24 * 60 * 60 * 1000;

async function resolveCdnUrl(vid, uid, h, ctx) {
  const key = String(vid);
  const mem = _cdnUrlCache.get(key);
  if (mem && Date.now() - mem.ts < CDN_CACHE_TTL) return mem.url;

  const cacheReq = new Request(`https://muno-cdn-url-cache.internal/${vid}`);
  try {
    const hit = await caches.default.match(cacheReq);
    if (hit) {
      const u = await hit.text();
      if (u) { _cdnUrlCache.set(key, { url: u, ts: Date.now() }); return u; }
    }
  } catch (_) {}

  const uidsToTry = [String(uid), ...PREVIEW_UID_POOL, "1"];
  const seen = new Set();
  let url = null;

  for (const u of uidsToTry) {
    if (seen.has(u)) continue;
    seen.add(u);
    url = await fetchDownloadUrl(vid, u, h);
    if (url) break;
    url = await fetchViewUrl(vid, u, h);
    if (url) break;
    const preview = await fetchPreviewData(vid, u, h);
    if (preview) {
      const found = findVideoUrl(preview);
      if (found && !isStubUrl(found)) { url = found; break; }
    }
  }

  if (url) {
    _cdnUrlCache.set(key, { url, ts: Date.now() });
    try {
      const resp = new Response(url, {
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": `max-age=${Math.floor(CDN_CACHE_TTL / 1000)}`,
        },
      });
      if (ctx?.waitUntil) ctx.waitUntil(caches.default.put(cacheReq, resp));
      else await caches.default.put(cacheReq, resp);
    } catch (_) {}
  }
  return url || null;
}

async function fetchDownloadUrl(vid, uid, headers) {
  try {
    const resp = await fetch("https://munowatch.org/api/download", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: `uid=${uid}&vid=${vid}&state=on`,
    });
    if (!resp.ok) return null;
    const d = await resp.json();
    const url = d && d.playingurl;
    return !url || isStubUrl(url) ? null : url;
  } catch { return null; }
}

async function fetchViewUrl(vid, uid, headers) {
  try {
    const resp = await fetch("https://munowatch.org/api/view", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: `uid=${uid}&vid=${vid}`,
    });
    if (!resp.ok) return null;
    const d = await resp.json();
    const url = d && d.nextUrl;
    return !url || isStubUrl(url) ? null : url;
  } catch { return null; }
}

async function fetchPreviewData(vid, uid, headers) {
  try {
    const resp = await fetch(`https://munowatch.org/api/protected/preview/v2/${vid}/${uid}`, {
      headers: { ...headers, "Content-Type": "application/json" },
    });
    if (!resp.ok) return null;
    const d = await resp.json().catch(() => null);
    if (!d || d.msg === "User forbidden access" || !d.preview || typeof d.preview !== "object" || Object.keys(d.preview).length === 0) return null;
    return d;
  } catch { return null; }
}

async function handleDownloadRedirect(request, vid, uid, ctx) {
  const auth = request.headers.get("Authorization") || "Bearer " + APP_API_KEY;
  const h = {
    "User-Agent": BROWSER_UA,
    Accept: "*/*",
    "Accept-Encoding": "identity",
    Referer: "https://munowatch.org/",
    Origin: "https://munowatch.org",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: auth,
    "X-Api-Key": request.headers.get("X-Api-Key") || APP_API_KEY,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  let realUrl = await resolveCdnUrl(vid, uid, h, ctx);
  if (!realUrl) {
    return new Response(JSON.stringify({ error: "Download URL not found", vid, uid }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
  realUrl = encodeVideoUrl(realUrl);
  return new Response(null, {
    status: 302,
    headers: { Location: realUrl, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" },
  });
}

async function handlePreviewEnrich(request, vid, uid, workerBase) {
  const auth = request.headers.get("Authorization") || "Bearer " + APP_API_KEY;
  const h = {
    "User-Agent": request.headers.get("User-Agent") || BROWSER_UA,
    Accept: "*/*",
    "Accept-Encoding": "identity",
    Referer: "https://munowatch.org/",
    Origin: "https://munowatch.org",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: auth,
    "X-Api-Key": request.headers.get("X-Api-Key") || APP_API_KEY,
  };

  const [downloadUrl, data0] = await Promise.all([
    fetchDownloadUrl(vid, uid, h),
    fetchPreviewData(vid, uid, h)
  ]);

  let data = data0;
  if (!data) {
    for (const fallbackUid of PREVIEW_UID_POOL) {
      data = await fetchPreviewData(vid, fallbackUid, h);
      if (data) break;
    }
  }

  if (!data || typeof data !== "object") data = {};
  if (!data.preview || typeof data.preview !== "object") data.preview = {};

  let realUrl = downloadUrl ? encodeVideoUrl(downloadUrl) : null;
  if (!realUrl) { const v = await fetchViewUrl(vid, uid, h); if (v) realUrl = encodeVideoUrl(v); }
  if (!realUrl && data) { const found = findVideoUrl(data); if (found && !isStubUrl(found)) realUrl = encodeVideoUrl(found); }

  const p = data.preview;
  const finalPlaying = realUrl || `${workerBase}/api/dl/${vid}/${uid}.mp4`;
  const nxtVid = p.nxt_eps_id || vid;
  const finalNext = `${workerBase}/api/dl/${nxtVid}/${uid}.mp4`;

  p.playingUrl = finalPlaying;
  p.playingurl = finalPlaying;
  p.nxt_playing_url = finalNext;
  p.nxtPlayingUrl = finalNext;

  if (p.issubscriber === false || p.issubscriber === "false") p.issubscriber = true;
  if (!p.substatus || p.substatus === "") p.substatus = "ACTIVE";
  if (p.user_access === "deny" || !p.user_access) p.user_access = "allow";
  if (p.mstatus === false || p.mstatus === "false" || p.mstatus === 0 || !p.mstatus) p.mstatus = true;
  if (p.kstatus === undefined || !p.kstatus) p.kstatus = "ACTIVE";
  if (!p.paid_for) p.paid_for = "1";
  if (!p.title) p.title = "Movie";
  if (!p.description) p.description = "";
  if (!p.vj) p.vj = "Original";
  if (!p.image) p.image = "";
  if (!p.type) p.type = "movie";
  if (!p.vid) p.vid = String(vid);
  if (typeof p.id !== "number") p.id = Number(vid) || 0;
  if (typeof p.nxt_eps_id !== "number") p.nxt_eps_id = Number(vid) || 0;
  if (typeof p.category_id !== "number") p.category_id = 1;
  if (typeof p.vj_id !== "number") p.vj_id = 1;
  if (typeof p.ldur !== "number") p.ldur = 0;

  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": "true",
    },
  });
}

async function proxyRequest(originalRequest, targetUrl, upstreamHost, workerBase) {
  const cookieHeader = originalRequest.headers.get("Cookie") || "";
  const rangeHeader = originalRequest.headers.get("Range") || "";
  const xApiKey = originalRequest.headers.get("X-Api-Key") || "";
  const authHeader = originalRequest.headers.get("Authorization") || "";
  const userAgent = originalRequest.headers.get("User-Agent") || "Android IOS v3.0";
  const contentType = originalRequest.headers.get("Content-Type") || "";
  let auth = authHeader;
  if (!auth && xApiKey) auth = "Bearer " + xApiKey;

  const dashMatch = /^(https:\/\/munowatch\.org\/api\/protected\/dashboard\/v2\/)(\d+)(.*)$/.exec(targetUrl);
  if (dashMatch) targetUrl = dashMatch[1] + "0" + dashMatch[3];

  const isPreviewPath = targetUrl.includes("/preview/v2/");
  if (!isPreviewPath && !targetUrl.includes("/episodes/") && !targetUrl.includes("/range/")) {
    const segments = targetUrl.split('/');
    const uidIdx = segments.length - 2;
    const uidVal = segments[uidIdx];
    if (uidIdx > 0 && uidVal && /^\d+$/.test(uidVal)) {
      const originalUid = parseInt(uidVal);
      if (originalUid > 0) {
        const poolIndex = originalUid % PREVIEW_UID_POOL.length;
        segments[uidIdx] = PREVIEW_UID_POOL[poolIndex];
        targetUrl = segments.join('/');
      }
    }
  }

  const h = {
    "User-Agent": userAgent,
    Accept: originalRequest.headers.get("Accept") || "*/*",
    "Accept-Encoding": "identity",
    Range: rangeHeader,
    Cookie: cookieHeader,
    "X-Requested-With": "XMLHttpRequest",
    Referer: "https://" + upstreamHost + "/",
    Origin: "https://" + upstreamHost,
    "X-Api-Key": xApiKey || APP_API_KEY,
  };
  if (auth) h["Authorization"] = auth;
  if (contentType) h["Content-Type"] = contentType;

  const upstream = await fetch(targetUrl, {
    method: originalRequest.method,
    headers: h,
    body: originalRequest.method !== "GET" && originalRequest.method !== "HEAD" ? originalRequest.body : undefined,
    redirect: "manual",
  });

  const outHeaders = new Headers();
  for (const [k, v] of upstream.headers.entries()) {
    const lk = k.toLowerCase();
    if (lk === "location") outHeaders.set("Location", rewriteUrl(v, upstreamHost, workerBase));
    else if (lk === "set-cookie") outHeaders.append("Set-Cookie", rewriteSetCookie(v));
    else if (lk === "content-encoding" || lk === "transfer-encoding") {}
    else if (lk === "access-control-allow-origin") outHeaders.set("Access-Control-Allow-Origin", "*");
    else outHeaders.append(k, v);
  }
  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("Access-Control-Allow-Credentials", "true");

  const ct = (upstream.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json") && upstream.status < 300) {
    try {
      const text = await upstream.text();
      const json = JSON.parse(text);
      const _uidM = /[?&]uid=(\d+)/.exec(targetUrl) || /\/(\d+)(?:\/|$)/.exec(new URL(targetUrl).pathname.split("/").slice(-2).join("/"));
      const _uid = _uidM ? _uidM[1] : 0;
      await fixPlayingUrls(json, workerBase, _uid);
      outHeaders.set("Content-Type", "application/json; charset=utf-8");
      outHeaders.delete("content-length");
      return new Response(JSON.stringify(json), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders,
      });
    } catch (e) {}
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

async function fixPlayingUrls(node, workerBase, uid) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) await fixPlayingUrls(item, workerBase, uid);
    return;
  }
  const fields = ["playingurl", "playingUrl", "nxt_playing_url", "nextUrl", "nxtPlayingUrl"];
  for (const f of fields) {
    if (typeof node[f] === "string" && node[f]) {
      const raw = node[f];
      const vid = node.id || node.vid || node.video_id;
      if (vid) {
        const resolved = await resolveCdnUrl(vid, uid, {
          "User-Agent": BROWSER_UA, Accept: "*/*", "Accept-Encoding": "identity",
          Referer: "https://munowatch.org/", Origin: "https://munowatch.org",
          "X-Requested-With": "XMLHttpRequest",
          Authorization: "Bearer " + APP_API_KEY, "X-Api-Key": APP_API_KEY,
          "Content-Type": "application/x-www-form-urlencoded",
        });
        node[f] = (resolved && !isStubUrl(resolved)) ? encodeVideoUrl(resolved) : (isStubUrl(raw) ? `${workerBase}/api/dl/${vid}/${uid || 0}.mp4` : encodeVideoUrl(raw));
      } else if (!isStubUrl(raw)) {
        node[f] = encodeVideoUrl(raw);
      }
    }
  }
  if (node.playingUrl && !node.playingurl) node.playingurl = node.playingUrl;
  if (node.playingurl && !node.playingUrl) node.playingUrl = node.playingurl;
  if (node.nxt_playing_url && !node.nxtPlayingUrl) node.nxtPlayingUrl = node.nxt_playing_url;
  if (node.nxtPlayingUrl && !node.nxt_playing_url) node.nxt_playing_url = node.nxtPlayingUrl;

  for (const v of Object.values(node)) {
    if (v && typeof v === "object") await fixPlayingUrls(v, workerBase, uid);
  }
}

function rewriteUrl(location, upstreamHost, workerBase) {
  try {
    const abs = location.startsWith("http") ? location : "https://" + upstreamHost + (location.startsWith("/") ? location : "/" + location);
    const u = new URL(abs);
    const known = ["munowatch.org", "munowatch.com", "munotek.com"];
    if (!known.includes(u.hostname)) return location;
    const prefix = u.hostname === "munowatch.org" ? "" : "/" + u.hostname;
    return workerBase + prefix + u.pathname + u.search + u.hash;
  } catch { return location; }
}

function rewriteSetCookie(v) {
  return v.split(";").map(p => p.trim())
    .filter(p => { const l = p.toLowerCase(); return !l.startsWith("domain=") && !l.startsWith("samesite="); })
    .join("; ") + "; SameSite=None";
}

// ── EXPRESS WRAPPER ──

app.all("*", async (req, res) => {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const fullUrl = `${protocol}://${req.get("host")}${req.originalUrl}`;

  const headers = new Map();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((val) => headers.set(k, val));
    else if (v !== undefined) headers.set(k, v);
  }

  const workerReq = {
    method: req.method,
    url: fullUrl,
    headers: {
      get(name) {
        return headers.get(name.toLowerCase()) || null;
      },
    },
    body: ["GET", "HEAD"].includes(req.method) ? null : req.body,
  };

  const waitUntilPromises = [];
  const ctx = {
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    },
  };

  try {
    const workerRes = await workerHandler.fetch(workerReq, {}, ctx);
    
    // Execute async background tasks
    if (waitUntilPromises.length > 0) {
      Promise.all(waitUntilPromises).catch(() => {});
    }

    res.status(workerRes.status);
    workerRes.headers.forEach((val, key) => {
      res.setHeader(key, val);
    });

    const responseText = await workerRes.text();
    res.send(responseText);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});