/**
 * dobby-hooks — instabox webhook receiver
 *
 * POST /instabox  : verify Standard Webhooks signature, dedup, push to WeChat via PushPlus
 * GET  /healthz   : liveness probe
 *
 * Secret lines (set via `wrangler secret put`):
 *   WEBHOOK_SECRET  — instabox signing secret (whsec_...)
 *   PUSHPLUS_TOKEN  — pushplus.plus token
 */

const REPLAY_WINDOW_S = 300; // ±5 min
const DEDUP_TTL_S = 3 * 86400;

// ---- Standard Webhooks verification (RFC-style, matches instabox docs) ----

async function verifySignature(secret, id, timestamp, signatureHeader, rawBody) {
  if (!secret || !id || !timestamp || !signatureHeader) return false;
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > REPLAY_WINDOW_S) return false;

  const keyBytes = base64ToBytes(secret.replace(/^whsec_/, ""));
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const want = await crypto.subtle.sign("HMAC", cryptoKey,
    new TextEncoder().encode(signedContent)
  );
  const wantB64 = bytesToBase64(new Uint8Array(want));

  // header format: "v1,<b64> v1,<b64> ..."
  for (const part of signatureHeader.split(" ")) {
    const [v, b64] = part.split(",");
    if (v !== "v1" || !b64) continue;
    if (timingSafeEqualStr(b64, wantB64)) return true;
  }
  return false;
}

function bytesToBase64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- PushPlus ----

async function pushWeChat(token, title, htmlContent) {
  const resp = await fetch("https://www.pushplus.plus/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, title, content: htmlContent, template: "html" }),
  });
  const j = await resp.json().catch(() => ({}));
  return { ok: resp.ok && j.code === 200, resp: j };
}

// ---- Event formatting ----

function fmtEvent(evt) {
  const d = evt.data || {};
  const machine = d.sandbox || d.machine || {};
  const name = machine.name || machine.id || d.message || "unknown";
  const reason = d.reason || machine.suspendReason || "";
  const rows = [
    `<b>事件</b> ${evt.type}`,
    `<b>沙箱</b> ${name}`,
    reason ? `<b>原因</b> ${reason}` : "",
    `<b>时间</b> ${evt.createdAt || ""}`,
  ].filter(Boolean);
  return rows.join("<br/>");
}

// ---- Router ----

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return json({ ok: true, ts: new Date().toISOString() });
    }

    if (url.pathname === "/instabox" && request.method === "POST") {
      const rawBody = await request.text();
      const id = request.headers.get("webhook-id") || "";
      const ts = request.headers.get("webhook-timestamp") || "";
      const sig = request.headers.get("webhook-signature") || "";

      const valid = await verifySignature(env.WEBHOOK_SECRET, id, ts, sig, rawBody);
      if (!valid) return json({ error: "invalid signature" }, 401);

      let evt;
      try { evt = JSON.parse(rawBody); } catch { return json({ error: "bad json" }, 400); }

      // dedup by event id
      if (evt.id && env.HOOKS_KV) {
        const seen = await env.HOOKS_KV.get(`evt:${evt.id}`);
        if (seen) return json({ ok: true, dedup: true });
        await env.HOOKS_KV.put(`evt:${evt.id}`, "1", { expirationTtl: DEDUP_TTL_S });
      }

      // reply fast, push async
      ctx.waitUntil((async () => {
        if (!env.PUSHPLUS_TOKEN) return;
        const title = `InstaBox: ${evt.type || "webhook"}`;
        const r = await pushWeChat(env.PUSHPLUS_TOKEN, title, fmtEvent(evt));
        if (env.HOOKS_KV) await env.HOOKS_KV.put(`push:${evt.id}:${Date.now()}`, JSON.stringify(r), { expirationTtl: 86400 });
      })());

      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
