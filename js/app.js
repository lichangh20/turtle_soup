/* =========================================================================
   海龟汤 · 交互逻辑（原生 JS，无依赖）
   两个视图：题库(list) + 解谜(play)。解谜内向「AI 主持人」提问，由 Claude 大模型裁判。
   启用 AI 的两种方式（二选一）：
   - 运行 server.py（自动检测 Gemini / Claude Code / Gemini CLI / Codex / Anthropic，密钥留在服务器端，最安全）；
   - 或在页面右上角 🔑 填入 Anthropic 或 Gemini API Key（浏览器直连，密钥仅存本机；可用于 file:// 与 GitHub Pages）。
   ========================================================================= */
(function () {
  "use strict";

  /* ---------- 分类 ---------- */
  const CATEGORIES = [
    { code: "all",     label: "全部", emoji: "🍲", color: "#e0a458" },
    { code: "qing",    label: "清淡", emoji: "🌿", color: "#57c4a3" },
    { code: "tuili",   label: "推理", emoji: "🔍", color: "#5aa9e6" },
    { code: "kongbu",  label: "恐怖", emoji: "🕯️", color: "#e05561" },
    { code: "wenqing", label: "温情", emoji: "💗", color: "#f2a2b8" },
    { code: "naodong", label: "脑洞", emoji: "🧠", color: "#b088f9" },
    { code: "fav",     label: "收藏", emoji: "⭐", color: "#ffd166" },
  ];
  const CAT_MAP = Object.fromEntries(CATEGORIES.map((c) => [c.code, c]));

  const VERDICTS = {
    "是":       { cls: "v-yes",  label: "是" },
    "不是":     { cls: "v-no",   label: "不是" },
    "是也不是": { cls: "v-mixed",label: "是也不是" },
    "无关":     { cls: "v-none", label: "无关" },
    "接近":     { cls: "v-near", label: "接近了" },
    "恭喜":     { cls: "v-win",  label: "🎉 恭喜答对" },
    "不好说":   { cls: "v-none", label: "不好说" },
  };

  /* ---------- AI 主持人（Claude）提示词与结构化输出 ---------- */
  const AI_MODEL_DEFAULT = "claude-opus-4-8";
  const GEMINI_MODEL_DEFAULT = "gemini-2.5-flash";
  const ASK_SYSTEM = `你是「海龟汤」情境推理游戏的主持人。你已知这道题的【汤面】（玩家能看到的谜面）和【汤底】（真相，玩家看不到）。
玩家会向你提出只能用「是/否」回答的问题，你要严格依据【汤底】判断，并从下列选项中给出唯一判定：
- "是"：按汤底，问题描述的情况成立。
- "不是"：按汤底，不成立。
- "是也不是"：部分成立、或需分情况。
- "无关"：与还原真相无关，或汤底中没有相关信息。
- "接近"：方向正确、已接近真相但还不完整。
- "恭喜"：玩家说对了汤底的关键真相（核心因果说对了）。
原则：只依据汤底判断，绝不编造；判断要果断稳定，同样的问题给一致判定；note 用一句话简短引导，除"恭喜"外绝不能剧透汤底关键信息；solved 仅在"恭喜"时为 true。只输出结构化 JSON。`;
  const ASK_SCHEMA = { type: "object", properties: {
      verdict: { type: "string", enum: ["是", "不是", "是也不是", "无关", "接近", "恭喜"] },
      note: { type: "string" }, solved: { type: "boolean" },
    }, required: ["verdict", "note", "solved"], additionalProperties: false };
  const HINT_SYSTEM = `你是「海龟汤」游戏的主持人。根据【汤面】和【汤底】，给玩家一条循序渐进、绝不直接泄底的提示，帮助他们向真相靠近一步。只给一条，简短（一两句），语气俏皮一点，不要说出汤底关键答案。只输出结构化 JSON。`;
  const HINT_SCHEMA = { type: "object", properties: { hint: { type: "string" } }, required: ["hint"], additionalProperties: false };
  const GEN_SYSTEM = `你是一位擅长创作「海龟汤」（情境推理谜题）的出题人。请原创一道有趣、逻辑自洽、能通过「是/否」提问一步步推理出来的海龟汤。
要求：surface(汤面) 简洁悬疑 30~80 字、只写表象不含解释；answer(汤底) 完整揭示真相与因果 60~200 字、答案唯一；hints 给 2~3 条循序渐进不泄底的提示；difficulty 为 1~5 整数；tags 给 2~4 个中文标签；category 从 qing/tuili/kongbu/wenqing/naodong 里选最贴切的一个；若给定 flavor 口味请贴合它。有创意有反转即可，不必过度血腥。只输出结构化 JSON。`;
  const GEN_SCHEMA = { type: "object", properties: {
      title: { type: "string" }, surface: { type: "string" }, answer: { type: "string" },
      hints: { type: "array", items: { type: "string" } }, difficulty: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
      category: { type: "string", enum: ["qing", "tuili", "kongbu", "wenqing", "naodong"] },
    }, required: ["title", "surface", "answer", "hints", "difficulty", "tags", "category"], additionalProperties: false };

  const $ = (id) => document.getElementById(id);
  const el = {};
  ["brandHome","navList","navPlay","aiBadge","themeToggle","viewList","viewPlay",
   "searchInput","randomBtn","btnFetch","categoryBar","listStat","grid","emptyHint","sourceNote",
   "backBtn","card","categoryBadge","difficulty","btnFav","title","surface","tags",
   "hintsWrap","hintsList","answerBlock","answerText","answerCover","qaMode","chat","askForm",
   "askInput","askBtn","btnHint","btnAnswer","btnNext","toast","btnGen","qaCount",
   "keyModal","keyInput","modelInput","keySave","keyClear","keyClose","keyStatus",
   "providerRow","providerSelect","browserProvider","browserNote"].forEach((k) => (el[k] = $(k)));

  /* ---------- 状态 ---------- */
  const K_FAV = "ts_favorites", K_THEME = "ts_theme", K_SEEN = "ts_seen", K_SOLVED = "ts_solved";
  const K_APIKEY = "ts_api_key", K_MODEL = "ts_api_model", K_PROVIDER = "ts_provider", K_BROWSER = "ts_browser_provider";
  let deck = [], byId = new Map();
  let favorites = new Set(), seen = new Set(), solved = new Set();
  let currentCat = "all", search = "";
  let current = null, hintIndex = 0, answerShown = false, asking = false;
  let serverAI = false, browserKey = "", aiModel = "", aiSeq = 1;
  let serverLabel = "", serverModel = "", chosenProvider = "", serverProviders = [];
  let browserProvider = "anthropic";   // 浏览器直连后端：anthropic | gemini
  const aiReady = () => serverAI || !!browserKey;
  const defaultModelFor = (prov) => (prov === "gemini" ? GEMINI_MODEL_DEFAULT : AI_MODEL_DEFAULT);
  const browserLabel = () => (browserProvider === "gemini" ? "Gemini" : "Claude");
  const chats = {};      // id -> [ {who:'host'|'me', ...} ]
  const aiHints = {};    // id -> [hint strings already given]

  /* ---------- 工具 ---------- */
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const normKey = (s) => String(s || "").replace(/\s+/g, "");
  const clampDiff = (d) => Math.max(1, Math.min(5, parseInt(d, 10) || 3));
  const splitTags = (s) => String(s || "").split(/[,，、]/).map((t) => t.trim()).filter(Boolean);
  function guessCategory(t) {
    const s = String(t || "");
    if (/恐怖|灵异|尸|食人|食尸|变态|精神|妄想|杀|虐|诡/.test(s)) return "kongbu";
    if (/温情|父爱|母爱|亲情|治愈|善|陪伴/.test(s)) return "wenqing";
    if (/轻松|日常|生活|治疗|机智/.test(s)) return "qing";
    if (/超能力|预知|机器人|科幻|脑洞|穿越|异世界/.test(s)) return "naodong";
    return "tuili";
  }
  let toastTimer;
  function toast(msg) { el.toast.textContent = msg; el.toast.classList.add("is-show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove("is-show"), 3000); }

  const loadSet = (k) => { try { return new Set(JSON.parse(localStorage.getItem(k)) || []); } catch (e) { return new Set(); } };
  const saveSet = (k, s) => { try { localStorage.setItem(k, JSON.stringify([...s])); } catch (e) {} };

  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    document.body.setAttribute("data-theme", t);
    el.themeToggle.textContent = t === "dark" ? "🌙" : "☀️";
    try { localStorage.setItem(K_THEME, t); } catch (e) {}
  }
  function setCat(color) { document.documentElement.style.setProperty("--cat", color); }

  /* ---------- 视图切换 ---------- */
  function showList() {
    el.viewPlay.hidden = true; el.viewList.hidden = false;
    el.navList.classList.add("is-active"); el.navPlay.classList.remove("is-active");
    setCat(CAT_MAP.all.color);
    renderGrid();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function showPlay() {
    el.viewList.hidden = true; el.viewPlay.hidden = false;
    el.navPlay.hidden = false; el.navPlay.classList.add("is-active"); el.navList.classList.remove("is-active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---------- 分类胶囊 ---------- */
  function catCount(code) {
    if (code === "all") return deck.length;
    if (code === "fav") return favorites.size;
    return deck.filter((p) => p.category === code).length;
  }
  function buildChips() {
    el.categoryBar.innerHTML = "";
    CATEGORIES.forEach((c) => {
      const b = document.createElement("button");
      b.className = "chip" + (c.code === currentCat ? " is-active" : "");
      b.style.setProperty("--c", c.color);
      b.dataset.cat = c.code;
      b.innerHTML = "<span>" + c.emoji + " " + c.label + "</span><span class='chip__count'>" + catCount(c.code) + "</span>";
      b.addEventListener("click", () => { currentCat = c.code; buildChips(); renderGrid(); });
      el.categoryBar.appendChild(b);
    });
  }

  /* ---------- 题库网格 ---------- */
  function filtered() {
    let list = deck;
    if (currentCat === "fav") list = list.filter((p) => favorites.has(p.id));
    else if (currentCat !== "all") list = list.filter((p) => p.category === currentCat);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((p) =>
        (p.title || "").toLowerCase().includes(q) ||
        (p.surface || "").toLowerCase().includes(q) ||
        (p.tags || []).some((t) => t.toLowerCase().includes(q)));
    }
    return list;
  }
  function renderGrid() {
    const list = filtered();
    el.grid.innerHTML = "";
    el.emptyHint.hidden = list.length > 0;
    list.forEach((p, i) => el.grid.appendChild(makeTile(p, i)));
    el.listStat.textContent =
      "共 " + deck.length + " 题 · 已看 " + seen.size + " · 已解 " + solved.size +
      (favorites.size ? " · 收藏 " + favorites.size : "");
  }
  function makeTile(p, i) {
    const cat = CAT_MAP[p.category] || CAT_MAP.tuili;
    const t = document.createElement("button");
    t.className = "tile";
    t.style.setProperty("--c", cat.color);
    t.style.animationDelay = Math.min(i, 12) * 0.02 + "s";

    const fav = document.createElement("span");
    fav.className = "tile__fav" + (favorites.has(p.id) ? " is-on" : "");
    fav.textContent = favorites.has(p.id) ? "★" : "☆";
    fav.title = "收藏";
    fav.addEventListener("click", (e) => { e.stopPropagation(); toggleFav(p.id); renderGrid(); });

    const top = document.createElement("div");
    top.className = "tile__top";
    const badge = document.createElement("span");
    badge.className = "badge"; badge.textContent = cat.emoji + " " + cat.label;
    const pips = document.createElement("span"); pips.className = "pips";
    for (let k = 0; k < 5; k++) { const d = document.createElement("i"); if (k < p.difficulty) d.className = "on"; pips.appendChild(d); }
    top.appendChild(badge); top.appendChild(pips);

    const title = document.createElement("h3"); title.className = "tile__title"; title.textContent = p.title;
    const teaser = document.createElement("p"); teaser.className = "tile__teaser"; teaser.textContent = p.surface;

    const foot = document.createElement("div"); foot.className = "tile__foot";
    (p.tags || []).slice(0, 2).forEach((tg) => {
      const s = document.createElement("span");
      s.style.cssText = "font-size:11px;color:var(--ink-mute)";
      s.textContent = "#" + tg;
      foot.appendChild(s);
    });
    const status = document.createElement("span");
    if (solved.has(p.id)) { status.className = "tile__status solved"; status.textContent = "🎉 已解"; }
    else if (seen.has(p.id)) { status.className = "tile__status seen"; status.textContent = "· 看过"; }
    foot.appendChild(status);

    t.appendChild(fav); t.appendChild(top); t.appendChild(title); t.appendChild(teaser); t.appendChild(foot);
    t.addEventListener("click", () => openPuzzle(p.id));
    return t;
  }

  /* ---------- 打开一道题 ---------- */
  function openPuzzle(id) {
    const p = byId.get(id); if (!p) return;
    current = p;
    if (!seen.has(id)) { seen.add(id); saveSet(K_SEEN, seen); }
    render(p);
    showPlay();
  }

  function render(p) {
    const cat = CAT_MAP[p.category] || CAT_MAP.tuili;
    setCat(cat.color);
    el.card.classList.remove("is-entering"); void el.card.offsetWidth; el.card.classList.add("is-entering");

    el.categoryBadge.textContent = cat.emoji + " " + cat.label;
    el.categoryBadge.style.setProperty("--c", cat.color);
    el.difficulty.innerHTML = "";
    for (let i = 0; i < 5; i++) { const d = document.createElement("i"); if (i < p.difficulty) d.className = "on"; el.difficulty.appendChild(d); }
    el.difficulty.title = "难度 " + p.difficulty + "/5";
    el.title.textContent = p.title;
    el.surface.textContent = p.surface;
    el.tags.innerHTML = "";
    (p.tags || []).slice(0, 6).forEach((t) => { const s = document.createElement("span"); s.textContent = t; el.tags.appendChild(s); });

    // 提示重置
    hintIndex = 0; el.hintsList.innerHTML = ""; el.hintsWrap.hidden = true; updateHintBtn();
    // 汤底隐藏
    answerShown = false; el.answerText.textContent = p.answer; el.answerBlock.classList.remove("is-revealed"); el.btnAnswer.textContent = "🥄 公布汤底";
    // 收藏
    updateFav();
    // 聊天
    if (!chats[p.id]) chats[p.id] = [{ who: "host", greet: true, text: "🐢 我心里已经有一个故事了。你可以问我任何能用「是 / 不是」回答的问题，一步步逼近真相。" }];
    renderChat();
    updateQaMode();
    el.askInput.value = "";
  }

  function updateFav() {
    const on = current && favorites.has(current.id);
    el.btnFav.textContent = on ? "★" : "☆";
    el.btnFav.classList.toggle("is-on", !!on);
    el.btnFav.title = on ? "取消收藏" : "收藏本题";
  }
  function toggleFav(id) {
    if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
    saveSet(K_FAV, favorites);
    if (current && current.id === id) updateFav();
    buildChips();
  }

  /* ---------- 提示 ---------- */
  function updateHintBtn() {
    const p = current; const n = p && p.hints ? p.hints.length : 0;
    if (hintIndex < n) { el.btnHint.disabled = false; el.btnHint.textContent = "💡 看提示 (" + hintIndex + "/" + n + ")"; }
    else if (aiReady()) { el.btnHint.disabled = false; el.btnHint.textContent = "✦ 求主持人点拨"; }
    else { el.btnHint.disabled = true; el.btnHint.textContent = n ? "💡 提示已看完" : "💡 暂无提示"; }
  }
  function appendHint(text, isAi) {
    el.hintsWrap.hidden = false;
    const li = document.createElement("li"); li.textContent = text; if (isAi) li.className = "ai";
    el.hintsList.appendChild(li);
  }
  async function onHint() {
    const p = current; if (!p) return;
    const hints = p.hints || [];
    if (hintIndex < hints.length) { appendHint(hints[hintIndex], false); hintIndex++; updateHintBtn(); return; }
    if (!aiReady()) { toast("点右上角 🔑 设置 API Key 后，可请主持人给提示"); openKeyPanel(); return; }
    el.btnHint.classList.add("is-loading"); el.btnHint.disabled = true;
    try {
      const hint = await judgeHint(p.surface, p.answer, aiHints[p.id] || []);
      if (hint) { aiHints[p.id] = (aiHints[p.id] || []).concat(hint); appendHint(hint, true); }
      else toast("主持人一时也想不出新提示了");
    } catch (e) { toast(aiErrText(e)); }
    finally { el.btnHint.classList.remove("is-loading"); updateHintBtn(); }
  }

  /* ---------- 汤底 ---------- */
  function toggleAnswer() {
    if (!current) return;
    answerShown = !answerShown;
    el.answerBlock.classList.toggle("is-revealed", answerShown);
    el.btnAnswer.textContent = answerShown ? "🙈 收起汤底" : "🥄 公布汤底";
    if (answerShown && !solved.has(current.id)) { solved.add(current.id); saveSet(K_SOLVED, solved); }
  }

  /* ---------- 提问区（聊天） ---------- */
  function updateQaMode() {
    const on = aiReady();
    let desc;
    if (serverAI) desc = "服务器 · " + activeProviderLabel();
    else if (browserKey) desc = "浏览器·" + browserLabel() + " · " + (aiModel || defaultModelFor(browserProvider));
    else desc = "";
    el.qaMode.textContent = on ? ("🤖 AI 主持（" + desc + "）") : "⚠️ 未启用 AI · 点 🔑 设置 API Key";
    el.aiBadge.className = "ai-badge " + (on ? "is-ai" : "is-off");
    el.aiBadge.textContent = on ? "🤖 AI 主持" : "🔑 设置 Key";
    el.aiBadge.title = on ? "AI 主持人已就位（点击可修改 Key）" : "点击设置 API Key（Anthropic 或 Gemini）以启用 AI 主持人";
    if (el.btnGen) el.btnGen.hidden = !on;
  }
  function updateQaCount() {
    const p = current; if (!p) { el.qaCount.textContent = ""; return; }
    const n = (chats[p.id] || []).filter((m) => m.who === "me").length;
    el.qaCount.textContent = n ? "已提问 " + n + " 次" : "";
  }
  function renderChat() {
    const p = current; if (!p) return;
    const arr = chats[p.id] || [];
    el.chat.innerHTML = "";
    arr.forEach((m) => el.chat.appendChild(makeMsg(m)));
    el.chat.scrollTop = el.chat.scrollHeight;
    updateQaCount();
  }
  function makeMsg(m) {
    const wrap = document.createElement("div");
    if (m.who === "me") {
      wrap.className = "msg msg--me";
      const b = document.createElement("div"); b.className = "msg__bubble"; b.textContent = m.text; wrap.appendChild(b);
    } else if (m.thinking) {
      wrap.className = "msg msg--host thinking";
      const b = document.createElement("div"); b.className = "msg__bubble"; b.innerHTML = "主持人思考中<span class='dots'></span>"; wrap.appendChild(b);
    } else if (m.greet) {
      wrap.className = "msg msg--host";
      const b = document.createElement("div"); b.className = "msg__bubble"; b.textContent = m.text; wrap.appendChild(b);
    } else if (m.error) {
      wrap.className = "msg msg--host error";
      const b = document.createElement("div"); b.className = "msg__bubble"; b.textContent = "⚠️ " + m.text; wrap.appendChild(b);
    } else {
      wrap.className = "msg msg--host";
      const b = document.createElement("div"); b.className = "msg__bubble";
      const v = VERDICTS[m.verdict] || VERDICTS["不好说"];
      const row = document.createElement("span"); row.className = "msg__verdict";
      if (m.qn) { const qn = document.createElement("span"); qn.className = "msg__qn"; qn.textContent = "第 " + m.qn + " 问"; row.appendChild(qn); }
      const chip = document.createElement("span"); chip.className = "verdict-chip " + v.cls; chip.textContent = v.label;
      row.appendChild(chip);
      b.appendChild(row);
      if (m.note) { const note = document.createElement("div"); note.className = "msg__note"; note.textContent = m.note; b.appendChild(note); }
      wrap.appendChild(b);
    }
    return wrap;
  }

  async function ask(question) {
    const p = current; if (!p || asking) return;
    const q = question.trim(); if (!q) return;
    if (!aiReady()) { toast("请先点右上角 🔑 设置 API Key（Anthropic 或 Gemini，或用配置了密钥的服务器打开）"); openKeyPanel(); return; }
    asking = true; el.askBtn.disabled = true; el.askInput.disabled = true;
    chats[p.id].push({ who: "me", text: q });
    chats[p.id].push({ who: "host", thinking: true });
    renderChat();
    try {
      const hist = [];
      const msgs = chats[p.id];
      for (let i = 0; i < msgs.length; i++) { if (msgs[i].who === "me") { const next = msgs[i + 1]; if (next && next.verdict) hist.push({ q: msgs[i].text, verdict: next.verdict }); } }
      const r = await judgeAsk(p.surface, p.answer, q, hist);
      chats[p.id] = chats[p.id].filter((m) => !m.thinking);
      const qn = chats[p.id].filter((m) => m.who === "me").length;
      chats[p.id].push({ who: "host", verdict: r.verdict, note: r.note, qn: qn });
      renderChat();
      if (r.solved || r.verdict === "恭喜") {
        if (!solved.has(p.id)) { solved.add(p.id); saveSet(K_SOLVED, solved); }
        toast("🎉 猜对啦！可以点「公布汤底」核对完整真相。");
      }
    } catch (e) {
      chats[p.id] = chats[p.id].filter((m) => !m.thinking);
      chats[p.id].push({ who: "host", error: true, text: aiErrText(e) });
      renderChat();
    } finally {
      asking = false; el.askBtn.disabled = false; el.askInput.disabled = false; el.askInput.focus();
    }
  }

  /* ---------- AI 客户端（服务器优先，其次浏览器直连 Anthropic / Gemini）----------
     无 AI 时不再有“本地裁判”兜底：海龟汤的裁判必须由大模型完成。 */
  async function anthropicDirect(system, user, schema, maxTokens) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": browserKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: aiModel || AI_MODEL_DEFAULT, max_tokens: maxTokens,
        system: system, messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema: schema } },
      }),
    });
    if (!res.ok) {
      let t = ""; try { t = await res.text(); } catch (e) {}
      throw new Error("HTTP " + res.status + (res.status === 401 ? "（API Key 无效）" : "") + " " + t.slice(0, 120));
    }
    const data = await res.json();
    if (data.stop_reason === "refusal") throw new Error("模型拒绝作答");
    let text = ""; for (const b of (data.content || [])) { if (b.type === "text") { text = b.text; break; } }
    return JSON.parse(text);
  }
  /* 把标准 JSON-Schema 转成 Gemini 的 responseSchema（类型大写、去掉 additionalProperties），与 server.py 一致。 */
  function geminiSchema(s) {
    if (Array.isArray(s)) return s.map(geminiSchema);
    if (!s || typeof s !== "object") return s;
    const out = {};
    for (const k in s) {
      if (k === "additionalProperties") continue;
      if (k === "type") out.type = String(s.type).toUpperCase();
      else if (k === "properties") { out.properties = {}; for (const p in s.properties) out.properties[p] = geminiSchema(s.properties[p]); }
      else if (k === "items") out.items = geminiSchema(s.items);
      else out[k] = s[k];
    }
    return out;
  }
  /* 浏览器直连 Gemini：与 server.py 的 gen_gemini 等价（key 走 ?key= 查询参数，浏览器直接 TLS 直连 Google，不经第三方）。 */
  async function geminiDirect(system, user, schema, maxTokens) {
    const model = aiModel || GEMINI_MODEL_DEFAULT;
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(browserKey);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: geminiSchema(schema), maxOutputTokens: Math.max(maxTokens, 768) },
      }),
    });
    if (!res.ok) {
      let t = ""; try { t = await res.text(); } catch (e) {}
      const bad = res.status === 400 || res.status === 403;
      throw new Error("HTTP " + res.status + (bad ? "（API Key 无效或无权限）" : "") + " " + t.slice(0, 160));
    }
    const data = await res.json();
    const cand = (data.candidates || [])[0];
    if (!cand) {
      const br = data.promptFeedback && data.promptFeedback.blockReason;
      throw new Error(br ? ("请求被拦截：" + br) : "Gemini 无返回内容");
    }
    let text = ""; for (const part of ((cand.content && cand.content.parts) || [])) { if (part.text) text += part.text; }
    if (!text) throw new Error(cand.finishReason === "MAX_TOKENS" ? "输出超长被截断，请重试" : "Gemini 返回为空");
    return JSON.parse(text);
  }
  /* 按所选浏览器后端分发 */
  function browserDirect(system, user, schema, maxTokens) {
    return browserProvider === "gemini"
      ? geminiDirect(system, user, schema, maxTokens)
      : anthropicDirect(system, user, schema, maxTokens);
  }
  function buildAskUser(surface, answer, question, history) {
    let u = "【汤面】\n" + surface.trim() + "\n\n【汤底（仅你可见，严禁泄露给玩家）】\n" + answer.trim();
    if (history && history.length) {
      const lines = history.slice(-8).filter((h) => h.q).map((h) => "玩家问：" + h.q + " → 你答：" + h.verdict);
      if (lines.length) u += "\n\n【已问过的问题（保持判定一致）】\n" + lines.join("\n");
    }
    return u + "\n\n【玩家现在的提问】\n" + question.trim();
  }
  function serverReason(r) { return r === "no_api_key" ? "服务器未配置密钥" : ("服务器出错：" + (r || "")); }
  async function judgeAsk(surface, answer, question, history) {
    if (serverAI) {
      try {
        const res = await fetch("api/ask", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ surface: surface, answer: answer, question: question, history: history, provider: chosenProvider }) });
        const d = await res.json();
        if (d.ok) return { verdict: d.verdict, note: d.note, solved: d.solved };
        if (!browserKey) throw new Error(serverReason(d.reason));
      } catch (e) { if (!browserKey) throw e; }
    }
    const r = await browserDirect(ASK_SYSTEM, buildAskUser(surface, answer, question, history), ASK_SCHEMA, 500);
    return { verdict: r.verdict, note: r.note, solved: !!r.solved };
  }
  async function judgeHint(surface, answer, asked) {
    if (serverAI) {
      try {
        const res = await fetch("api/hint", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ surface: surface, answer: answer, asked: asked, provider: chosenProvider }) });
        const d = await res.json();
        if (d.ok) return d.hint;
        if (!browserKey) throw new Error(serverReason(d.reason));
      } catch (e) { if (!browserKey) throw e; }
    }
    let u = "【汤面】\n" + surface + "\n\n【汤底（仅你可见）】\n" + answer;
    if (asked && asked.length) u += "\n\n【已给过的提示，请勿重复】\n" + asked.map((a) => "- " + a).join("\n");
    return (await browserDirect(HINT_SYSTEM, u, HINT_SCHEMA, 300)).hint;
  }
  async function judgeGenerate(flavor) {
    if (serverAI) {
      try {
        const res = await fetch("api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flavor: flavor, provider: chosenProvider }) });
        const d = await res.json();
        if (d.ok && d.puzzle) return d.puzzle;
        if (!browserKey) throw new Error(serverReason(d.reason));
      } catch (e) { if (!browserKey) throw e; }
    }
    let u = "请原创一道全新的海龟汤。"; if (flavor) u += "口味偏向：" + flavor + "。";
    return await browserDirect(GEN_SYSTEM, u, GEN_SCHEMA, 1200);
  }
  function aiErrText(e) {
    const m = (e && e.message) || String(e);
    if (m.indexOf("401") >= 0 || m.indexOf("Key 无效") >= 0) return "API Key 无效或无权限，请点右上角 🔑 检查后重试。";
    if (m.indexOf("Failed to fetch") >= 0 || m.indexOf("NetworkError") >= 0 || m.indexOf("Load failed") >= 0) return "连接 AI 失败（网络或跨域被拦截）。请检查网络，或改用 python3 server.py 打开。";
    if (m.indexOf("未配置密钥") >= 0) return "服务器没有配置 ANTHROPIC_API_KEY —— 可点右上角 🔑 直接填入 Key。";
    return "AI 主持人暂时无法回应：" + m;
  }

  /* ---------- 换一题 ---------- */
  function nextPuzzle() {
    let pool = filtered();
    if (pool.length === 0) pool = deck;
    let choice = pool[Math.floor(Math.random() * pool.length)];
    if (current && pool.length > 1) { let guard = 0; while (choice.id === current.id && guard++ < 8) choice = pool[Math.floor(Math.random() * pool.length)]; }
    openPuzzle(choice.id);
  }

  /* ---------- 从网上获取更多 ---------- */
  function parseSource(text) {
    const labels = { ID: "id", "标题": "title", "汤面": "surface", "汤底": "answer", "难度": "difficulty", "标签": "tags" };
    const re = /^(ID|标题|汤面|汤底|难度|标签)\s*[:：]\s*(.*)$/;
    const recs = []; let cur = {};
    text.split(/\r?\n/).forEach((line) => {
      const t = line.trim();
      if (t.startsWith("#")) return;
      if (t === "---") { if (Object.keys(cur).length) { recs.push(cur); cur = {}; } return; }
      const m = line.match(re); if (m) cur[labels[m[1]]] = m[2].trim();
    });
    if (Object.keys(cur).length) recs.push(cur);
    return recs;
  }
  function normFetched(r) {
    const meta = window.WEB_META || {};
    const idNum = String(parseInt(r.id, 10));
    return {
      id: "w" + String(r.id || Math.random().toString(36).slice(2, 6)).padStart(3, "0"),
      title: (r.title || "无题").trim(),
      category: (meta.categoryById && meta.categoryById[idNum]) || guessCategory(r.tags),
      difficulty: clampDiff(r.difficulty),
      surface: (r.surface || "").trim(),
      answer: (r.answer || "").trim(),
      hints: (meta.hintsById && meta.hintsById[idNum]) || [],
      tags: splitTags(r.tags), source: "web",
    };
  }
  async function fetchSourceText() {
    const sources = (window.WEB_META && window.WEB_META.sources) || [];
    for (const url of sources) {
      try { const res = await fetch(url, { cache: "no-store" }); if (res.ok) { const t = await res.text(); if (t && t.length > 500) return t; } } catch (e) {}
    }
    try { const res = await fetch("api/fetch", { cache: "no-store" }); if (res.ok) { const d = await res.json(); if (d && d.ok && d.text) return d.text; } } catch (e) {}
    throw new Error("all sources failed");
  }
  async function fetchMore() {
    el.btnFetch.classList.add("is-loading"); el.btnFetch.disabled = true;
    try {
      const text = await fetchSourceText();
      const recs = parseSource(text);
      const have = new Set(deck.map((p) => normKey(p.surface)));
      let added = 0;
      recs.forEach((r) => {
        const p = normFetched(r); if (!p.surface || !p.answer) return;
        const k = normKey(p.surface); if (have.has(k)) return;
        have.add(k); deck.push(p); byId.set(p.id, p); added++;
      });
      if (added > 0) { buildChips(); renderGrid(); toast("🌐 已从网上获取 " + added + " 道新题！题库现有 " + deck.length + " 题"); }
      else toast("🌐 已同步在线题库，暂时没有新题啦");
    } catch (e) { toast("🌐 联网获取失败，请检查网络（离线题库仍可畅玩）"); }
    finally { el.btnFetch.classList.remove("is-loading"); el.btnFetch.disabled = false; }
  }

  /* ---------- AI 出题（LLM 自动出题）---------- */
  function normGenerated(g) {
    const cat = g.category && CAT_MAP[g.category] ? g.category : "naodong";
    return {
      id: "ai" + (aiSeq++), title: (g.title || "AI 现编").trim(), category: cat,
      difficulty: clampDiff(g.difficulty), surface: (g.surface || "").trim(), answer: (g.answer || "").trim(),
      hints: Array.isArray(g.hints) ? g.hints.slice(0, 4) : [], tags: Array.isArray(g.tags) ? g.tags : [], source: "ai",
    };
  }
  async function generatePuzzle() {
    if (!aiReady()) { toast("AI 出题需先点右上角 🔑 设置 API Key（或用配置了密钥的服务器打开）"); openKeyPanel(); return; }
    el.btnGen.classList.add("is-loading"); el.btnGen.disabled = true;
    try {
      const flavor = (currentCat !== "all" && currentCat !== "fav" && CAT_MAP[currentCat]) ? CAT_MAP[currentCat].label : "";
      const g = await judgeGenerate(flavor);
      if (g && g.surface && g.answer) {
        const p = normGenerated(g);
        deck.push(p); byId.set(p.id, p); buildChips();
        toast("🤖 AI 现编了一道新题，开始推理吧！");
        openPuzzle(p.id);
      } else toast("AI 出题失败了，稍后再试～");
    } catch (e) { toast(aiErrText(e)); }
    finally { el.btnGen.classList.remove("is-loading"); el.btnGen.disabled = false; }
  }

  /* ---------- AI 设置面板（选择后端 / 填 Key） ---------- */
  function activeProviderLabel() {
    if (chosenProvider) {
      const p = serverProviders.find((x) => x.id === chosenProvider);
      if (p) return p.label + (p.model ? " · " + p.model : "");
    }
    return (serverLabel || "AI") + (serverModel ? " · " + serverModel : "");
  }
  function populateProviders() {
    if (!el.providerSelect) return;
    el.providerSelect.innerHTML = "";
    const auto = document.createElement("option"); auto.value = ""; auto.textContent = "自动（推荐，最快优先 + 自动回退）";
    el.providerSelect.appendChild(auto);
    serverProviders.forEach((p) => {
      const o = document.createElement("option"); o.value = p.id;
      o.textContent = p.label + (p.model ? "（" + p.model + "）" : "");
      el.providerSelect.appendChild(o);
    });
    el.providerSelect.value = chosenProvider || "";
    if (el.providerRow) el.providerRow.hidden = serverProviders.length === 0;
  }
  function refreshKeyStatus() {
    if (!el.keyStatus) return;
    if (serverAI) el.keyStatus.textContent = "当前：本地服务器 · " + activeProviderLabel();
    else if (browserKey) el.keyStatus.textContent = "当前：浏览器直连 " + browserLabel() + "（" + (aiModel || defaultModelFor(browserProvider)) + "）";
    else el.keyStatus.textContent = "当前：未启用 AI —— 提问 / AI 出题都需要它。";
  }
  function updateBrowserHints() {
    const gem = browserProvider === "gemini";
    if (el.keyInput) el.keyInput.placeholder = (gem ? "AIza…" : "sk-ant-…") + "（仅保存在本机浏览器）";
    if (el.modelInput) el.modelInput.placeholder = "模型（可选，默认 " + defaultModelFor(browserProvider) + "）";
    if (el.browserNote) el.browserNote.innerHTML = gem
      ? "密钥只存在你自己的浏览器（localStorage），由浏览器 TLS 直连 Google 官方接口、不经任何第三方；适合 <code>file://</code> 或 GitHub Pages。没有 Key？到 <a href=\"https://aistudio.google.com/apikey\" target=\"_blank\" rel=\"noopener\">aistudio.google.com/apikey</a> 免费获取。"
      : "密钥只存在你自己的浏览器（localStorage），直接发往 Anthropic 官方接口、不经任何第三方；适合 <code>file://</code> 或 GitHub Pages。没有 Key？到 <a href=\"https://console.anthropic.com/settings/keys\" target=\"_blank\" rel=\"noopener\">console.anthropic.com</a> 获取。";
  }
  function openKeyPanel() {
    populateProviders();
    if (el.browserProvider) el.browserProvider.value = browserProvider;
    updateBrowserHints();
    if (el.keyInput) el.keyInput.value = browserKey || "";
    if (el.modelInput) el.modelInput.value = aiModel || "";
    refreshKeyStatus();
    if (el.keyModal) el.keyModal.hidden = false;
  }
  function closeKeyPanel() { if (el.keyModal) el.keyModal.hidden = true; }
  function saveKey() {
    const k = (el.keyInput.value || "").trim();
    const m = (el.modelInput.value || "").trim();
    if (el.providerSelect) chosenProvider = el.providerSelect.value;
    // 浏览器直连后端：优先用下拉选择；若 key 前缀明确（AIza→Gemini / sk-ant→Anthropic）则以 key 为准，避免选错。
    let bp = el.browserProvider ? el.browserProvider.value : browserProvider;
    if (/^AIza/.test(k)) bp = "gemini"; else if (/^sk-ant/.test(k)) bp = "anthropic";
    browserProvider = bp === "gemini" ? "gemini" : "anthropic";
    browserKey = k; aiModel = m;
    try {
      if (k) localStorage.setItem(K_APIKEY, k); else localStorage.removeItem(K_APIKEY);
      if (m) localStorage.setItem(K_MODEL, m); else localStorage.removeItem(K_MODEL);
      if (chosenProvider) localStorage.setItem(K_PROVIDER, chosenProvider); else localStorage.removeItem(K_PROVIDER);
      localStorage.setItem(K_BROWSER, browserProvider);
    } catch (e) {}
    updateQaMode(); closeKeyPanel();
    toast(aiReady() ? "✅ 已更新 AI 主持人设置" : "已保存（当前仍未启用 AI）");
  }
  function clearKey() {
    browserKey = ""; aiModel = "";
    try { localStorage.removeItem(K_APIKEY); localStorage.removeItem(K_MODEL); } catch (e) {}
    if (el.keyInput) el.keyInput.value = "";
    if (el.modelInput) el.modelInput.value = "";
    updateQaMode(); refreshKeyStatus();
    toast("已清除浏览器里的 API Key");
  }

  /* ---------- AI 探测 ---------- */
  async function detectAI() {
    try {
      const res = await fetch("api/health", { cache: "no-store" });
      if (res.ok) { const d = await res.json(); serverAI = !!(d && d.ai); serverLabel = (d && d.label) || ""; serverModel = (d && d.model) || ""; serverProviders = (d && d.available) || []; }
    } catch (e) { serverAI = false; }
    populateProviders();
    updateQaMode();
  }

  /* ---------- 初始化 ---------- */
  function init() {
    applyTheme(localStorage.getItem(K_THEME) || "dark");
    deck = (window.BUNDLED_PUZZLES || []).map((p) => Object.assign({}, p));
    byId = new Map(deck.map((p) => [p.id, p]));
    favorites = new Set([...loadSet(K_FAV)].filter((id) => byId.has(id)));
    seen = loadSet(K_SEEN); solved = loadSet(K_SOLVED);
    try { browserKey = localStorage.getItem(K_APIKEY) || ""; aiModel = localStorage.getItem(K_MODEL) || ""; chosenProvider = localStorage.getItem(K_PROVIDER) || ""; browserProvider = localStorage.getItem(K_BROWSER) === "gemini" ? "gemini" : "anthropic"; } catch (e) {}

    buildChips();
    el.sourceNote.innerHTML = "题库来源：网络公开题库 + 世界经典情境谜题 · 离线自带 <b>" + deck.length + "</b> 题，点「🌐 从网上获取更多」可解锁更多在线题目。";
    updateQaMode();

    // 事件
    el.brandHome.addEventListener("click", showList);
    el.navList.addEventListener("click", showList);
    el.navPlay.addEventListener("click", () => { if (current) showPlay(); });
    el.backBtn.addEventListener("click", showList);
    el.randomBtn.addEventListener("click", () => { const c = currentCat === "fav" && favorites.size === 0 ? "all" : currentCat; currentCat = c; nextPuzzle(); });
    el.btnFetch.addEventListener("click", fetchMore);
    el.btnGen.addEventListener("click", generatePuzzle);
    el.searchInput.addEventListener("input", () => { search = el.searchInput.value.trim(); renderGrid(); });
    el.themeToggle.addEventListener("click", () => applyTheme(document.body.getAttribute("data-theme") === "dark" ? "light" : "dark"));

    // AI 设置面板
    el.aiBadge.addEventListener("click", openKeyPanel);
    if (el.keyClose) el.keyClose.addEventListener("click", closeKeyPanel);
    if (el.keyModal) el.keyModal.addEventListener("click", (e) => { if (e.target === el.keyModal) closeKeyPanel(); });
    if (el.keySave) el.keySave.addEventListener("click", saveKey);
    if (el.keyClear) el.keyClear.addEventListener("click", clearKey);
    if (el.providerSelect) el.providerSelect.addEventListener("change", () => {
      chosenProvider = el.providerSelect.value;
      try { if (chosenProvider) localStorage.setItem(K_PROVIDER, chosenProvider); else localStorage.removeItem(K_PROVIDER); } catch (e) {}
      updateQaMode(); refreshKeyStatus();
    });
    if (el.browserProvider) el.browserProvider.addEventListener("change", () => {
      browserProvider = el.browserProvider.value === "gemini" ? "gemini" : "anthropic";
      try { localStorage.setItem(K_BROWSER, browserProvider); } catch (e) {}
      updateBrowserHints(); updateQaMode(); refreshKeyStatus();
    });

    el.btnFav.addEventListener("click", () => current && toggleFav(current.id));
    el.btnHint.addEventListener("click", onHint);
    el.btnAnswer.addEventListener("click", toggleAnswer);
    el.answerCover.addEventListener("click", () => { if (!answerShown) toggleAnswer(); });
    el.btnNext.addEventListener("click", nextPuzzle);
    el.askForm.addEventListener("submit", (e) => { e.preventDefault(); const q = el.askInput.value; el.askInput.value = ""; ask(q); });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (el.keyModal && !el.keyModal.hidden) { closeKeyPanel(); return; }
      if (!el.viewPlay.hidden) showList();
    });

    renderGrid();
    detectAI();

    // 深链：?p=<id> 直接打开某题（便于分享 / 收藏）
    try {
      const pid = new URLSearchParams(location.search).get("p");
      if (pid && byId.has(pid)) openPuzzle(pid);
    } catch (e) {}
  }

  init();
})();
