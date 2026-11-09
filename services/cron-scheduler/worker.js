// dobby-cron — 平台 cron 函数被裁后的替代排程层（2026-10-31）
// CF Workers cron triggers：08:00 北京时间 = 00:00 UTC，抖音热榜推微信
// 手动触发：GET /run?task=douyin&key=<MANUAL_TOKEN>
// 2026-11-07：GLaDOS 签到全线撤除（TA 令）——cron 档/调试端点/签到链/SS 链全部摘除

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === "0 0 * * *") {
      ctx.waitUntil(pushDouyin(env));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const task = url.searchParams.get("task");
    if (url.pathname === "/run" && (task === "douyin" || task === "hooktest")) {
      if (!env.MANUAL_TOKEN || url.searchParams.get("key") !== env.MANUAL_TOKEN) {
        return new Response("forbidden", { status: 403 });
      }
      if (task === "hooktest") {
        // 探针：真实 prompt 形状直调 AI + 走完整 genHooksOnce，不推微信（零打扰）
        const titles = ["苏超决赛无锡vs常州", "国际金价暴跌创近一年新低", "勇士25分逆转湖人"];
        const probes = [];
        for (const model of HOOK_MODELS) {
          try {
            const raw = await env.AI.run(model, {
              messages: [
                { role: "system", content: "你是短视频文案老手，只输出一个合法JSON数组，每条含 i 和 hook 两个字段。" },
                { role: "user", content: buildHookPrompt(titles) },
              ],
              max_tokens: 800,
            });
            probes.push({
              model,
              ctor: raw?.constructor?.name,
              keys: Array.isArray(raw) ? `ARRAY len=${raw.length}` : Object.keys(raw || {}),
              resp: JSON.stringify(raw?.response ?? "MISSING")?.slice(0, 200),
              result: JSON.stringify(raw?.result ?? "MISSING")?.slice(0, 100),
              choices0: JSON.stringify(raw?.choices?.[0]?.message?.content ?? "MISSING")?.slice(0, 200),
              unwrapped: unwrapAI(raw),
            });
          } catch (e) {
            probes.push({ model, error: e.message });
          }
        }
        let hooks = null;
        try { hooks = await genHooks(env, titles); } catch (e) { hooks = `genHooks fail: ${e.message}`; }
        // QQ API 探针（2026-11-01）：定位 worker fetch 525 死点（沙箱 curl 绿 worker 死同族坑）
        const qqProbe = {};
        for (const u of [
          ["token", "https://bots.qq.com/app/getAppAccessToken"],
          ["api", "https://api.sgroup.qq.com/users/@me"],
        ]) {
          try {
            const t0 = Date.now();
            const r = await fetch(u[1], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId: "probe", clientSecret: "probe" }) });
            const txt = await r.text();
            qqProbe[u[0]] = { status: r.status, ms: Date.now() - t0, head: txt.slice(0, 80) };
          } catch (e) { qqProbe[u[0]] = { error: String(e.message).slice(0, 100) }; }
        }
        return new Response(JSON.stringify({ probes, hooks, qqProbe }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
      }
      const result = await pushDouyin(env);
      return new Response(result, { status: result.startsWith("push: 200") ? 200 : 500 });
    }
    // 安全加固（2026-11-01）：非 /run 一律 404，不报 worker 身份；验活走带 token 的 /run?task=hooktest
    return new Response("404", { status: 404 });
  },
};

async function pushMsg(env, title, text) {
  await fetch("https://www.pushplus.plus/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: env.PUSHPLUS_TOKEN, title, content: text, template: "txt" }),
  });
}

async function pushDouyin(env) {
  try {
    // 数据源：v2.xxapi.cn（QQ bot /热榜 同款，10-25 实战验证；viki.moe 系 CF 托管被 Workers fetch 挑战页全灭）
    const api = await fetch("https://v2.xxapi.cn/api/douyinhot", {
      headers: { "User-Agent": "dobby-cron/1.0", "Accept": "application/json" },
    });
    const data = await api.json();
    if (data.code !== 200) return `api bad code: ${data.code}`;

    const raw = (data.data || data.result || data.list || []).slice(0, 10);
    const titles = raw.map((it) => it.title ?? it.word ?? it.name ?? "").filter(Boolean);
    // AI 钩子：每条 15 字内网感化看点（失败降级=原题直推，不阻塞主链）
    let hooks = [];
    try {
      hooks = await genHooks(env, titles);
    } catch (e) {
      console.log("hook gen fallback:", e.message);
    }
    const medals = ["🥇", "🥈", "🥉", "4.", "5.", "6.", "7.", "8.", "9.", "10."];
    const rows = raw
      .map((it, i) => {
        const title = it.title ?? it.word ?? it.name ?? "";
        const hot = Number(it.hot_value ?? it.hot ?? 0);
        const hook = hooks[i] ? `<br><span style="color:#e06699;font-size:13px">💬 ${esc(hooks[i])}</span>` : "";
        return `<p style="margin:8px 0;font-size:15px">${medals[i]} ${esc(title)}` +
          `<span style="color:#999;font-size:12px"> 🔥${hot.toLocaleString()}</span>${hook}</p>`;
      })
      .join("");
    const html =
      `<div style="font-family:sans-serif"><h3 style="margin:0 0 4px">📣 抖音热榜 Top10</h3>` +
      `<p style="color:#888;font-size:12px;margin:0 0 8px">每日 08:00 播报 · by Dobby</p>${rows}` +
      `<p style="margin-top:10px"><a href="https://www.douyin.com/hot">查看完整热榜 →</a></p></div>`;

    const push = await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: env.PUSHPLUS_TOKEN,
        title: "抖音热榜 Top10",
        content: html,
        template: "html",
      }),
    });
    const resp = await push.json();
    // 验活断言入返回值：/run 响应直接看钩子生成率，杜绝「push:200 但钩子全灭」假绿
    const line = `push: ${resp.code} ${resp.msg || ""} hooks=${hooks.filter(Boolean).length}/${raw.length}`;
    console.log(line);
    return line;
  } catch (e) {
    console.log("douyin push error:", e.message);
    return `error: ${e.message}`;
  }
}

// AI 钩子：一次调用批量生成，15 字内轻松网感化，直击痛点/制造悬念，不照搬原文
// 模型链（2026-10-31 REST 实测定版）：70b 文案质感主刀 → 8b-instruct-fp8-fast 兜底（墙/QQ bot 同款实战 ID）。
// 坑档：@cf/meta/llama-3.1-8b-fp8-fast 不存在（AI.run 抛错被上层 catch 吞 → 静默无钩子）；
//       glm-5.3-flash 403 套餐限制；qwen3-30b-a3b thinking 模式响应恒空。
const HOOK_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
];

// 15 字红线：超长按句读截断，避免半句话吊着
function tidyHook(h) {
  let s = String(h || "").trim().replace(/^["'“”「『]+|["'“”「』」。．.!！?？…~～]+$/g, "");
  if (s.length > 15) {
    const cut = s.slice(0, 15);
    const punct = Math.max(cut.lastIndexOf("，"), cut.lastIndexOf("、"), cut.lastIndexOf("："), cut.lastIndexOf("；"));
    s = punct >= 6 ? cut.slice(0, punct) : cut;
  }
  return s.length > 1 ? s : "";
}

// binding 响应拆包（2026-10-31 探针显微镜定版）——四种形状全兼容：
// ① response = 已解析的 hooks 对象数组（binding 自动 parse，主形态）
// ② response = 纯文本/嵌套 JSON 原文字符串
// ③ out 本体 = chat.completion 对象（content 在 choices[0].message.content）
// ④ 坑：response 可能是空串/undefined（|| 跳过，?? 不跳空串）
// 返回值：hooks 对象数组 或 纯文本字符串
function unwrapAI(out) {
  let t = out?.response || out?.result || out || "";
  if (Array.isArray(t)) return t; // 形状①
  if (typeof t === "string" && t.trim().startsWith("{")) {
    try {
      const j = JSON.parse(t);
      if (Array.isArray(j)) return j;
      t = j?.choices?.[0]?.message?.content ?? j?.response ?? t;
    } catch {}
  }
  if (t && typeof t === "object") {
    const inner = t?.choices?.[0]?.message?.content ?? t?.response ?? "";
    if (Array.isArray(inner)) return inner; // 形状③解析出的数组
    return String(inner ?? "").trim();
  }
  return String(t ?? "").trim();
}

function buildHookPrompt(titles) {
  return (
    `给下面${titles.length}条抖音热搜各写一句「核心看点」，要求：不超过15个汉字；直击痛点或制造悬念；` +
    `语气轻松有网感；禁止照搬原标题原句；只输出一个JSON数组，格式 [{"i":1,"hook":"..."},...]，不要其他文字。\n` +
    `范例：国际金价暴跌 → {"i":8,"hook":"金价跳水钱包哭了？"}\n` +
    titles.map((t, i) => `${i + 1}. ${t}`).join("\n")
  );
}

async function genHooksOnce(env, model, titles) {
  const prompt = buildHookPrompt(titles);
  const out = await env.AI.run(model, {
    messages: [
      { role: "system", content: "你是短视频文案老手，只输出一个合法JSON数组，每条含 i 和 hook 两个字段。" },
      { role: "user", content: prompt },
    ],
    max_tokens: 800,
  });
  const result = unwrapAI(out);
  if (!result || (Array.isArray(result) && !result.length)) {
    console.log("hook dbg:", model, JSON.stringify(out)?.slice(0, 300));
    throw new Error("ai empty output");
  }
  // 统一成对象数组：数组形态直接用；字符串形态逐对象提取（兼容 70b 单引号伪 JSON / 8b 分段输出；坏对象跳过）
  let objs;
  if (Array.isArray(result)) {
    objs = result.filter((x) => x && typeof x === "object" && "hook" in x);
    // 纯字符串数组（模型偶发 ["文案1","文案2"]）→ 按序号补 i
    if (!objs.length && result.every((x) => typeof x === "string")) {
      objs = result.map((h, idx) => ({ i: idx + 1, hook: h }));
    }
  } else {
    objs = [];
    for (const m of result.matchAll(/\{[^{}]*\}/g)) {
      let o = null;
      try { o = JSON.parse(m[0]); } catch {}
      if (!o) { try { o = JSON.parse(m[0].replace(/'/g, '"')); } catch {} } // 单引号归一化
      if (o && "i" in o && "hook" in o) objs.push(o);
    }
  }
  if (!objs.length) throw new Error("no hook objects in ai output");
  return titles.map((_, i) => {
    const hit =
      objs.find((x) => x?.i === i + 1 || x?.i === String(i + 1)) ||
      objs[i] /* 模型没给 i 时按序兜底 */;
    return tidyHook(typeof hit === "string" ? hit : hit?.hook);
  });
}

async function genHooks(env, titles) {
  if (!env.AI || !titles.length) return [];
  let lastErr;
  for (const model of HOOK_MODELS) {
    try {
      const hooks = await genHooksOnce(env, model, titles);
      if (hooks.filter(Boolean).length) {
        console.log("hooks via", model);
        return hooks;
      }
    } catch (e) {
      lastErr = e;
      console.log("hook model fail:", model, e.message);
    }
  }
  throw lastErr || new Error("all hook models failed");
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
