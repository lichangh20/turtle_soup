/* =========================================================================
   海龟汤 · 交互逻辑（原生 JS，无依赖）
   两个视图：题库(list) + 解谜(play)。解谜内可向「主持人」提问。
   - 通过本地服务器打开时：若配置了 ANTHROPIC_API_KEY，则由 Claude 实时裁判；
   - 否则（含 file:// 直接打开）：使用「本地裁判(近似)」，保证离线也能玩。
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

  const $ = (id) => document.getElementById(id);
  const el = {};
  ["brandHome","navList","navPlay","aiBadge","themeToggle","viewList","viewPlay",
   "searchInput","randomBtn","btnFetch","categoryBar","listStat","grid","emptyHint","sourceNote",
   "backBtn","card","categoryBadge","difficulty","btnFav","title","surface","tags",
   "hintsWrap","hintsList","answerBlock","answerText","answerCover","qaMode","chat","askForm",
   "askInput","askBtn","btnHint","btnAnswer","btnNext","toast","btnGen","qaCount"].forEach((k) => (el[k] = $(k)));

  /* ---------- 状态 ---------- */
  const K_FAV = "ts_favorites", K_THEME = "ts_theme", K_SEEN = "ts_seen", K_SOLVED = "ts_solved";
  let deck = [], byId = new Map();
  let favorites = new Set(), seen = new Set(), solved = new Set();
  let currentCat = "all", search = "";
  let current = null, hintIndex = 0, answerShown = false, asking = false;
  let aiAvailable = false, aiSeq = 1;
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
    else if (aiAvailable) { el.btnHint.disabled = false; el.btnHint.textContent = "✦ 求主持人点拨"; }
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
    if (!aiAvailable) { toast("已经没有更多提示啦，试着揭晓汤底或换一题～"); return; }
    el.btnHint.classList.add("is-loading"); el.btnHint.disabled = true;
    try {
      const res = await fetch("api/hint", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ surface: p.surface, answer: p.answer, asked: aiHints[p.id] || [] }) });
      const data = await res.json();
      if (data.ok && data.hint) { aiHints[p.id] = (aiHints[p.id] || []).concat(data.hint); appendHint(data.hint, true); }
      else toast("主持人一时也想不出新提示了");
    } catch (e) { toast("获取提示失败，请稍后再试"); }
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
    el.qaMode.textContent = aiAvailable ? "🤖 AI 主持人实时裁判" : "🧩 本地裁判 · 近似判断，仅供参考";
    el.aiBadge.className = "ai-badge " + (aiAvailable ? "is-ai" : "is-local");
    el.aiBadge.textContent = aiAvailable ? "🤖 AI 主持" : "🧩 本地裁判";
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
    asking = true; el.askBtn.disabled = true; el.askInput.disabled = true;
    chats[p.id].push({ who: "me", text: q });
    chats[p.id].push({ who: "host", thinking: true });
    renderChat();

    let verdict, note, solvedFlag = false;
    if (aiAvailable) {
      try {
        const hist = [];
        const msgs = chats[p.id];
        for (let i = 0; i < msgs.length; i++) { if (msgs[i].who === "me") { const next = msgs[i + 1]; if (next && next.verdict) hist.push({ q: msgs[i].text, verdict: next.verdict }); } }
        const res = await fetch("api/ask", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ surface: p.surface, answer: p.answer, question: q, history: hist.slice(0, -1) }) });
        const data = await res.json();
        if (data.ok) { verdict = data.verdict; note = data.note; solvedFlag = data.solved; }
        else { const j = localJudge(q, p); verdict = j.verdict; note = "（本地裁判）" + j.note; }
      } catch (e) { const j = localJudge(q, p); verdict = j.verdict; note = "（本地裁判）" + j.note; }
    } else {
      const j = localJudge(q, p); verdict = j.verdict; note = j.note;
      solvedFlag = verdict === "恭喜";
    }

    chats[p.id] = chats[p.id].filter((m) => !m.thinking);
    const qn = chats[p.id].filter((m) => m.who === "me").length;
    chats[p.id].push({ who: "host", verdict: verdict, note: note, qn: qn });
    renderChat();

    if (solvedFlag || verdict === "恭喜") {
      if (!solved.has(p.id)) { solved.add(p.id); saveSet(K_SOLVED, solved); }
      toast("🎉 猜对啦！可以点「公布汤底」核对完整真相。");
    }
    asking = false; el.askBtn.disabled = false; el.askInput.disabled = false; el.askInput.focus();
  }

  /* ---------- 本地裁判（近似，离线可用） ---------- */
  function bigrams(s) {
    const t = String(s).replace(/[\s，。、！？；：""''（）()\[\]{}.,!?;:"'~—…-]/g, "");
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    if (t.length === 1) set.add(t);
    return set;
  }
  function overlap(a, b) { let n = 0; a.forEach((x) => { if (b.has(x)) n++; }); return a.size ? n / a.size : 0; }
  function localJudge(q, p) {
    if (!q) return { verdict: "无关", note: "请先输入一个能用「是 / 不是」回答的问题～" };
    const qg = bigrams(q), ag = bigrams(p.answer), sg = bigrams(p.surface);
    const ao = overlap(qg, ag), so = overlap(qg, sg);
    const neg = /(不|没|无|非|别|未)/.test(q);
    const isGuess = /(是不是因为|是因为|因为|所以|真相是|答案是|我猜|其实|难道|莫非|凶手|自杀|他杀)/.test(q) || q.length >= 16;
    if (ao >= 0.5) {
      if (isGuess) return { verdict: "恭喜", note: "你已经非常接近真相了！点「公布汤底」核对一下吧。" };
      return neg ? { verdict: "不是", note: "" } : { verdict: "是", note: "" };
    }
    if (ao >= 0.28) return { verdict: "接近", note: "方向对了，再具体一点。" };
    if (so >= 0.4 && ao < 0.15) return { verdict: "无关", note: "这和汤面已知信息相关，但不是关键。" };
    if (ao <= 0.08) return { verdict: "无关", note: "" };
    return { verdict: "不好说", note: "本地裁判也拿不准，换个角度问问看？" };
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
    if (!aiAvailable) { toast("AI 出题需先配置 ANTHROPIC_API_KEY 并通过本地服务器打开"); return; }
    el.btnGen.classList.add("is-loading"); el.btnGen.disabled = true;
    try {
      const flavor = (currentCat !== "all" && currentCat !== "fav" && CAT_MAP[currentCat]) ? CAT_MAP[currentCat].label : "";
      const res = await fetch("api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flavor }) });
      const data = await res.json();
      if (data.ok && data.puzzle && data.puzzle.surface && data.puzzle.answer) {
        const p = normGenerated(data.puzzle);
        deck.push(p); byId.set(p.id, p); buildChips();
        toast("🤖 AI 现编了一道新题，开始推理吧！");
        openPuzzle(p.id);
      } else toast("AI 出题失败了，稍后再试～");
    } catch (e) { toast("AI 出题失败，请检查网络"); }
    finally { el.btnGen.classList.remove("is-loading"); el.btnGen.disabled = false; }
  }

  /* ---------- AI 探测 ---------- */
  async function detectAI() {
    try { const res = await fetch("api/health", { cache: "no-store" }); if (res.ok) { const d = await res.json(); aiAvailable = !!(d && d.ai); } }
    catch (e) { aiAvailable = false; }
    updateQaMode();
    el.btnGen.hidden = !aiAvailable;
  }

  /* ---------- 初始化 ---------- */
  function init() {
    applyTheme(localStorage.getItem(K_THEME) || "dark");
    deck = (window.BUNDLED_PUZZLES || []).map((p) => Object.assign({}, p));
    byId = new Map(deck.map((p) => [p.id, p]));
    favorites = new Set([...loadSet(K_FAV)].filter((id) => byId.has(id)));
    seen = loadSet(K_SEEN); solved = loadSet(K_SOLVED);

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

    el.btnFav.addEventListener("click", () => current && toggleFav(current.id));
    el.btnHint.addEventListener("click", onHint);
    el.btnAnswer.addEventListener("click", toggleAnswer);
    el.answerCover.addEventListener("click", () => { if (!answerShown) toggleAnswer(); });
    el.btnNext.addEventListener("click", nextPuzzle);
    el.askForm.addEventListener("submit", (e) => { e.preventDefault(); const q = el.askInput.value; el.askInput.value = ""; ask(q); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.viewPlay.hidden) showList(); });

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
