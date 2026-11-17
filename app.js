const STORAGE_KEY = "budget-app-v1";
const DEFAULT_CATEGORIES = [
  { id: "food", name: "食費" },
  { id: "daily", name: "日用品" },
  { id: "transit", name: "交通" },
  { id: "util", name: "光熱費" },
  { id: "comm", name: "通信" },
  { id: "fun", name: "娯楽" },
  { id: "med", name: "医療" },
  { id: "clothes", name: "衣服" },
  { id: "other", name: "その他" }
];

const $ = (id) => document.getElementById(id);

function jstNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const g = (t) => parts.find(p => p.type === t).value;
  return { year: g("year"), month: g("month"), day: g("day") };
}
function todayStr() {
  const t = jstNow();
  return `${t.year}-${t.month}-${t.day}`;
}
function currentMonth() {
  const t = jstNow();
  return `${t.year}-${t.month}`;
}
function monthLabel(ym) {
  const [y, m] = ym.split("-");
  return `${y}年${Number(m)}月`;
}
function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function daysInMonth(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function monthIndex(ym) {
  const [y, m] = String(ym).split("-").map(Number);
  return y * 12 + m;
}
function monthPace(ym, today) {
  const t = today || jstNow();
  const total = daysInMonth(ym);
  const todayKey = `${String(t.year).padStart(4, "0")}-${String(t.month).padStart(2, "0")}`;
  const view = monthIndex(ym);
  const now = monthIndex(todayKey);
  let remaining;
  let status;
  if (view < now) {
    remaining = 0;
    status = "past";
  } else if (view > now) {
    remaining = total;
    status = "future";
  } else {
    const day = Math.min(total, Math.max(1, Number(t.day)));
    remaining = total - day + 1;
    status = "current";
  }
  const ratio = total > 0 ? remaining / total : 0;
  return {
    total,
    remaining,
    pct: Math.round(ratio * 100),
    status
  };
}
function monthPaceLabel(pace) {
  return `月末まで残り ${pace.remaining}日（${pace.pct}%）`;
}
function budgetRemainPace(totalBudget, remain, pace) {
  if (!(totalBudget > 0)) {
    return { text: "予算の残り 未設定", pct: null, width: 0, cls: "" };
  }
  const pct = Math.max(-999, Math.min(999, Math.round(remain / totalBudget * 100)));
  const width = Math.max(0, Math.min(100, pct));
  let cls = "";
  if (pct < 0) cls = "danger";
  else if (pace && pace.status === "current" && pct < pace.pct) cls = "warn";
  const shown = pct < 0 ? `−${Math.abs(pct)}%` : `${pct}%`;
  return { text: `予算の残り ${shown}`, pct, width, cls };
}
function categoryRemainBar(budget, spent, pace) {
  const b = Number(budget) || 0;
  const s = Number(spent) || 0;
  const remain = b - s;
  if (!(b > 0)) {
    return { remain, pct: null, width: s > 0 ? 100 : 0, cls: "" };
  }
  const pct = Math.max(0, Math.min(100, Math.round(remain / b * 100)));
  const cls = pace && typeof pace.pct === "number" && pct < pace.pct ? "behind" : "";
  return { remain, pct, width: pct, cls };
}
function yen(n) {
  const v = Math.round(Number(n) || 0);
  return "¥" + v.toLocaleString("ja-JP");
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (!Array.isArray(data.categories) || !data.budgets || !Array.isArray(data.expenses)) throw new Error("bad");
      return data;
    }
  } catch (e) {}
  return { categories: DEFAULT_CATEGORIES.map(c => ({ ...c })), budgets: {}, expenses: [] };
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
}

function enqueueSync(events) {
  if (!events || !events.length || !window.BudgetSync) return Promise.resolve();
  const st = BudgetSync.loadState(localStorage);
  BudgetSync.enqueue(st, events);
  BudgetSync.saveState(localStorage, st);
  return BudgetSync.flush(localStorage, window.fetch.bind(window)).then(refreshSyncStatus).catch(refreshSyncStatus);
}
function refreshSyncStatus() {
  const el = $("syncStatus");
  if (!el || !window.BudgetSync) return;
  el.textContent = BudgetSync.statusLine(BudgetSync.loadState(localStorage));
}
function readSyncForm() {
  const st = BudgetSync.loadState(localStorage);
  const urlEl = $("syncUrl");
  const tokenEl = $("syncToken");
  if (urlEl) st.url = urlEl.value.trim();
  if (tokenEl) st.token = tokenEl.value.trim();
  BudgetSync.saveState(localStorage, st);
  refreshSyncStatus();
  BudgetSync.flush(localStorage, window.fetch.bind(window)).then(refreshSyncStatus);
  return st;
}

const state = {
  month: currentMonth(),
  data: load(),
  sheet: null
};
let paceStamp = todayStr();

function catName(id) {
  const c = state.data.categories.find(x => x.id === id);
  return c ? c.name : "不明";
}
function monthBudget(ym) {
  return state.data.budgets[ym] || {};
}
function expensesInMonth(ym) {
  return state.data.expenses
    .filter(e => e.date && e.date.startsWith(ym))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
}
function spentByCategory(ym) {
  const map = {};
  for (const e of expensesInMonth(ym)) {
    map[e.categoryId] = (map[e.categoryId] || 0) + Number(e.amount || 0);
  }
  return map;
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("on"), 1800);
}

function closeSheet() {
  if ($("syncUrl") && window.BudgetSync) readSyncForm();
  state.sheet = null;
  $("sheet").classList.remove("on");
  $("scrim").classList.remove("on");
}
function openSheet(title, bodyHtml, footerHtml) {
  $("sheet").innerHTML = `<div class="handle"></div><h3>${title}</h3>${bodyHtml}${footerHtml || ""}`;
  $("sheet").classList.add("on");
  $("scrim").classList.add("on");
}

function render() {
  paceStamp = todayStr();
  const ym = state.month;
  const budgetMap = monthBudget(ym);
  const spentMap = spentByCategory(ym);
  const cats = state.data.categories;
  let totalBudget = 0;
  let totalSpent = 0;
  for (const c of cats) {
    totalBudget += Number(budgetMap[c.id] || 0);
    totalSpent += Number(spentMap[c.id] || 0);
  }
  // include leftover spent in deleted categories
  for (const [id, amt] of Object.entries(spentMap)) {
    if (!cats.some(c => c.id === id)) totalSpent += Number(amt || 0);
  }
  const remain = totalBudget - totalSpent;
  const remainCls = remain < 0 ? "over" : "";
  const pace = monthPace(ym);
  const budgetPace = budgetRemainPace(totalBudget, remain, pace);
  const paceText = monthPaceLabel(pace);
  const budgetAria = budgetPace.pct == null
    ? 'aria-valuetext="未設定"'
    : `aria-valuenow="${budgetPace.width}"`;

  $("app").innerHTML = `
    <header class="top">
      <div class="month-nav">
        <button class="icon-btn" id="prevM" aria-label="前の月">‹</button>
        <h1>${monthLabel(ym)}</h1>
        <button class="icon-btn" id="nextM" aria-label="次の月">›</button>
      </div>
      <button class="icon-btn" id="openSettings" aria-label="設定">☰</button>
    </header>
    <section class="summary">
      <div class="label">残りの予算</div>
      <div class="remain ${remainCls}">${yen(remain)}</div>
      <div class="row">
        <div class="cell"><span>今月の予算</span><b>${yen(totalBudget)}</b></div>
        <div class="cell"><span>使った金額</span><b>${yen(totalSpent)}</b></div>
      </div>
      <div class="pace">
        <div class="pace-label" id="budgetPaceLabel">${escapeHtml(budgetPace.text)}</div>
        <div class="bar ${budgetPace.cls}" id="budgetPaceBar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeHtml(budgetPace.text)}" ${budgetAria}><i style="width:${budgetPace.width}%"></i></div>
        <div class="pace-label" id="monthPaceLabel">${escapeHtml(paceText)}</div>
        <div class="bar" id="monthPaceBar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pace.pct}" aria-label="${escapeHtml(paceText)}"><i style="width:${pace.pct}%"></i></div>
      </div>
    </section>
    <section class="section">
      <h2>カテゴリ別 <button class="linkish" id="openBudgets">予算を設定</button></h2>
      <div class="card" id="catList"></div>
    </section>
    <section class="section">
      <h2>支出の記録</h2>
      <div class="card" id="expList"></div>
    </section>
  `;

  const catList = $("catList");
  if (!cats.length) {
    catList.innerHTML = `<div class="empty">カテゴリがありません</div>`;
  } else {
    catList.innerHTML = cats.map(c => {
      const b = Number(budgetMap[c.id] || 0);
      const s = Number(spentMap[c.id] || 0);
      const bar = categoryRemainBar(b, s, pace);
      return `<div class="cat">
        <div class="cat-main">
          <div class="name">${escapeHtml(c.name)}</div>
          <div class="amt">${yen(s)}${b ? " / " + yen(b) : ""}</div>
          <div class="sub"><span>${b ? "残り " + yen(bar.remain) : "予算未設定"}</span><span>${bar.pct == null ? "" : bar.pct + "%"}</span></div>
          <div class="bar ${bar.cls}"><i style="width:${bar.width}%"></i></div>
        </div>
        <button type="button" class="record-btn" data-cat="${escapeHtml(c.id)}" aria-label="${escapeHtml(c.name)}の支出を記録">記録</button>
      </div>`;
    }).join("");
  }

  const exps = expensesInMonth(ym);
  const expList = $("expList");
  if (!exps.length) {
    expList.innerHTML = `<div class="empty">まだ支出の記録はありません</div>`;
  } else {
    expList.innerHTML = exps.map(e => `
        <button class="exp" data-id="${escapeHtml(e.id)}">
        <div>
          <div>${escapeHtml(catName(e.categoryId))}${e.memo ? " · " + escapeHtml(e.memo) : ""}</div>
          <div class="meta">${formatDate(e.date)}</div>
        </div>
        <div class="yen">${yen(e.amount)}</div>
      </button>
    `).join("");
  }

  $("fabWrap").innerHTML = `<button class="fab" id="addExp">支出を記録</button>`;

  $("prevM").onclick = () => { state.month = shiftMonth(state.month, -1); render(); };
  $("nextM").onclick = () => { state.month = shiftMonth(state.month, 1); render(); };
  $("openSettings").onclick = showSettings;
  $("openBudgets").onclick = showBudgets;
  $("addExp").onclick = () => showExpense();
  catList.querySelectorAll(".record-btn").forEach(btn => {
    btn.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      showExpense(null, btn.dataset.cat);
    };
  });
  expList.querySelectorAll(".exp").forEach(btn => {
    btn.onclick = () => {
      const item = state.data.expenses.find(x => x.id === btn.dataset.id);
      if (item) showExpense(item);
    };
  });
}

function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${Number(m)}月${Number(d)}日`;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function showExpense(existing, presetCategoryId) {
  const cats = state.data.categories;
  if (!cats.length) { toast("先にカテゴリを追加してください"); showSettings(); return; }
  const preset = cats.some(c => c.id === presetCategoryId) ? presetCategoryId : cats[0].id;
  const e = existing || { date: todayStr(), categoryId: preset, amount: "", memo: "" };
    const options = cats.map(c => `<option value="${escapeHtml(c.id)}" ${c.id === e.categoryId ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
  const delBtn = existing ? `<button class="btn danger" id="delExp">削除</button>` : `<button class="btn ghost" id="cancelSheet">やめる</button>`;
  openSheet(existing ? "支出を編集" : "支出を記録", `
      <div class="field"><label>金額</label><input id="fAmount" type="number" inputmode="numeric" min="0" step="1" value="${escapeHtml(e.amount || "")}" placeholder="例: 1200"></div>
      <div class="field"><label>カテゴリ</label><select id="fCat">${options}</select></div>
      <div class="field"><label>日付</label><input id="fDate" type="date" value="${escapeHtml(e.date || todayStr())}"></div>
    <div class="field"><label>メモ（任意）</label><input id="fMemo" type="text" maxlength="80" value="${escapeHtml(e.memo || "")}" placeholder="店名など"></div>
    <div class="actions">
      ${delBtn}
      <button class="btn primary" id="saveExp">保存</button>
    </div>
  `);
  $("fAmount").focus();
  $("saveExp").onclick = () => {
    const amount = Math.round(Number($("fAmount").value));
    const date = $("fDate").value;
    const categoryId = $("fCat").value;
    const memo = $("fMemo").value.trim();
    if (!amount || amount < 0 || !Number.isFinite(amount)) { toast("金額を入力してください"); return; }
    if (!date) { toast("日付を入力してください"); return; }
    const updatedAt = new Date().toISOString();
    let item = existing;
    if (existing) {
      existing.amount = amount;
      existing.date = date;
      existing.categoryId = categoryId;
      existing.memo = memo;
    } else {
      item = { id: uid(), amount, date, categoryId, memo, createdAt: Date.now() };
      state.data.expenses.push(item);
    }
    if (date.startsWith(state.month) === false) state.month = date.slice(0, 7);
    save();
    enqueueSync([BudgetSync.expenseUpsert(item, catName(categoryId), updatedAt)]);
    closeSheet();
    render();
    toast(existing ? "支出を更新しました" : "支出を記録しました");
  };
  const cancel = $("cancelSheet");
  if (cancel) cancel.onclick = closeSheet;
  const del = $("delExp");
  if (del) del.onclick = () => {
    if (!confirm("この支出を削除しますか？")) return;
    const deletedId = existing.id;
    const updatedAt = new Date().toISOString();
    state.data.expenses = state.data.expenses.filter(x => x.id !== deletedId);
    save();
    enqueueSync([BudgetSync.expenseDelete(deletedId, updatedAt)]);
    closeSheet();
    render();
    toast("削除しました");
  };
}

function showBudgets() {
  const ym = state.month;
  const budgetMap = { ...monthBudget(ym) };
  const rows = state.data.categories.map(c => `
    <div class="budget-row">
      <div>${escapeHtml(c.name)}</div>
        <input type="number" inputmode="numeric" min="0" step="1" data-id="${escapeHtml(c.id)}" value="${escapeHtml(budgetMap[c.id] || "")}" placeholder="0">
    </div>
  `).join("");
  const prev = shiftMonth(ym, -1);
  const hasPrev = Object.keys(monthBudget(prev)).length > 0;
  openSheet(`${monthLabel(ym)}の予算`, `
    ${hasPrev ? `<div class="note"><button class="linkish" id="copyPrev">前月（${monthLabel(prev)}）の予算をコピー</button></div>` : ""}
    ${rows || `<div class="empty">カテゴリがありません</div>`}
    <div class="actions">
      <button class="btn ghost" id="cancelSheet">やめる</button>
      <button class="btn primary" id="saveBudgets">保存</button>
    </div>
  `);
  const copy = $("copyPrev");
  if (copy) copy.onclick = () => {
    const src = monthBudget(prev);
    $("sheet").querySelectorAll("input[data-id]").forEach(inp => {
      inp.value = src[inp.dataset.id] || "";
    });
    toast("前月の予算を入れました。保存してください");
  };
  $("cancelSheet").onclick = closeSheet;
  $("saveBudgets").onclick = () => {
    const next = {};
    $("sheet").querySelectorAll("input[data-id]").forEach(inp => {
      const n = Math.round(Number(inp.value));
      if (Number.isFinite(n) && n > 0) next[inp.dataset.id] = n;
    });
    const updatedAt = new Date().toISOString();
    const knownIds = new Set(state.data.categories.map(c => c.id));
    const beforeKnown = {};
    Object.keys(monthBudget(ym)).forEach(id => {
      if (knownIds.has(id)) beforeKnown[id] = monthBudget(ym)[id];
    });
    const events = BudgetSync.budgetDiffEvents(ym, beforeKnown, next, catName, updatedAt);
    state.data.budgets[ym] = next;
    save();
    enqueueSync(events);
    closeSheet();
    render();
    toast("予算を保存しました");
  };
}

function showSettings() {
  const rows = state.data.categories.map(c => `
    <div class="cat-edit">
        <input type="text" maxlength="20" data-id="${escapeHtml(c.id)}" value="${escapeHtml(c.name)}">
        <button class="icon-btn" data-del="${escapeHtml(c.id)}" aria-label="削除">×</button>
    </div>
  `).join("");
  const syncSaved = BudgetSync.loadState(localStorage);
  openSheet("設定", `
    <div class="field"><label>カテゴリ</label></div>
    ${rows}
    <div class="actions" style="margin-bottom:16px">
      <button class="btn ghost" id="addCat">カテゴリを追加</button>
      <button class="btn primary" id="saveCats">カテゴリを保存</button>
    </div>
    <div class="field"><label>データ</label></div>
    <div class="muted" style="margin-bottom:10px">記録の本体は、この端末の中に保存されます。機種変更の前に書き出しておくと安心です。</div>
    <div class="actions">
      <button class="btn ghost" id="exportData">書き出す</button>
      <button class="btn ghost" id="importData">読み込む</button>
    </div>
    <input type="file" id="importFile" accept="application/json,.json" hidden>
    <div class="field" style="margin-top:18px"><label>スプレッドシート連携</label></div>
    <div class="muted" style="margin-bottom:10px">任意です。URLと合言葉は、この端末の中だけに保存されます。未設定でも、これまでどおり使えます。</div>
    <div class="field"><label>送信先URL</label><input id="syncUrl" type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="ウェブアプリのURL" value="${escapeHtml(syncSaved.url)}"></div>
      <div class="field"><label>合言葉</label><div class="secret-row"><input id="syncToken" type="password" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" placeholder="合言葉" value="${escapeHtml(syncSaved.token)}"><button type="button" class="text-btn" id="syncTokenToggle" aria-label="合言葉を表示">表示</button></div></div>
    <div class="actions">
      <button class="btn ghost" id="syncTest">接続テスト</button>
    </div>
    <div class="actions">
      <button class="btn ghost" id="syncAll">全データを送り直す</button>
    </div>
    <p class="sync-status" id="syncStatus"></p>
  `);
  refreshSyncStatus();
    $("syncUrl").addEventListener("change", readSyncForm);
    $("syncToken").addEventListener("change", readSyncForm);
    $("syncTokenToggle").onclick = () => {
      const input = $("syncToken");
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      $("syncTokenToggle").textContent = show ? "隠す" : "表示";
      $("syncTokenToggle").setAttribute("aria-label", show ? "合言葉を隠す" : "合言葉を表示");
    };
  $("addCat").onclick = () => {
    readSyncForm();
    const name = prompt("新しいカテゴリ名");
    if (!name || !name.trim()) return;
    state.data.categories.push({ id: uid(), name: name.trim() });
    save();
    showSettings();
    toast("カテゴリを追加しました");
  };
  $("sheet").querySelectorAll("[data-del]").forEach(btn => {
    btn.onclick = () => {
      readSyncForm();
      const id = btn.getAttribute("data-del");
      if (!confirm("このカテゴリを削除しますか？記録は残りますが、分類名は「不明」になります。")) return;
      const before = JSON.parse(JSON.stringify(state.data));
      const updatedAt = new Date().toISOString();
      state.data.categories = state.data.categories.filter(c => c.id !== id);
      save();
      enqueueSync(BudgetSync.mirrorDiffEvents(before, state.data, updatedAt));
      showSettings();
    };
  });
  $("saveCats").onclick = () => {
    readSyncForm();
    const before = JSON.parse(JSON.stringify(state.data));
    $("sheet").querySelectorAll("input[data-id]").forEach(inp => {
      const c = state.data.categories.find(x => x.id === inp.dataset.id);
      const nextName = inp.value.trim();
      if (c && nextName) c.name = nextName;
    });
    const updatedAt = new Date().toISOString();
    save();
    enqueueSync(BudgetSync.mirrorDiffEvents(before, state.data, updatedAt));
    closeSheet();
    render();
    toast("カテゴリを保存しました");
  };
  $("exportData").onclick = () => {
    const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `budget-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast("書き出しました");
  };
  $("importData").onclick = () => $("importFile").click();
  $("importFile").onchange = (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
          const data = BudgetSync.sanitizeImport(JSON.parse(String(reader.result)));
          if (!confirm("今の記録を、読み込んだデータで置き換えますか？")) return;
          const before = state.data;
          const updatedAt = new Date().toISOString();
          state.data = data;
        save();
        enqueueSync(BudgetSync.replaceDataEvents(before, state.data, updatedAt));
        closeSheet();
        render();
        toast("読み込みました");
      } catch (err) {
        toast("読み込めませんでした");
      }
    };
    reader.readAsText(file);
  };
  $("syncTest").onclick = testSync;
  $("syncAll").onclick = resendAll;
}

  function syncReady(st) {
    if (!st.url.trim() || !st.token.trim()) {
      toast("送信先URLと合言葉を入力してください");
      return false;
    }
    if (!BudgetSync.safeUrl(st.url)) {
      toast(BudgetSync.URL_ERROR);
      return false;
    }
    return true;
  }

  async function testSync() {
    const st = readSyncForm();
    if (!syncReady(st)) return;
  try {
    const data = await BudgetSync.postEvents(window.fetch.bind(window), BudgetSync.safeUrl(st.url), st.token, [BudgetSync.pingEvent()]);
    const current = BudgetSync.loadState(localStorage);
    if (data && data.ok === true && data.pong === true) {
      current.lastError = "";
      BudgetSync.saveState(localStorage, current);
      toast("接続できました");
    } else {
      current.lastError = BudgetSync.errorText(data);
      BudgetSync.saveState(localStorage, current);
      toast("接続できませんでした");
    }
  } catch (e) {
    const current = BudgetSync.loadState(localStorage);
    current.lastError = "送信できませんでした";
    BudgetSync.saveState(localStorage, current);
    toast("接続できませんでした");
  }
  refreshSyncStatus();
}

  function resendAll() {
    const st = readSyncForm();
    if (!syncReady(st)) return;
  const events = BudgetSync.snapshotEvents(state.data, new Date().toISOString());
  if (!events.length) {
    toast("送る記録がありません");
    return;
  }
  enqueueSync(events);
  toast("送り直しています");
}

function msUntilNextJstDay() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const g = (type) => Number(parts.find((p) => p.type === type).value);
  let hour = g("hour");
  if (hour === 24) hour = 0;
  return ((23 - hour) * 3600 + (59 - g("minute")) * 60 + (60 - g("second"))) * 1000 + 250;
}
function refreshPaceIfDateChanged() {
  if (todayStr() === paceStamp) return;
  render();
}
function schedulePaceRefresh() {
  setTimeout(() => {
    render();
    schedulePaceRefresh();
  }, msUntilNextJstDay());
}
function boot() {
  $("scrim").onclick = closeSheet;
  render();
  BudgetSync.flush(localStorage, window.fetch.bind(window)).then(refreshSyncStatus);
  window.addEventListener("online", () => {
    BudgetSync.flush(localStorage, window.fetch.bind(window)).then(refreshSyncStatus);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    BudgetSync.flush(localStorage, window.fetch.bind(window)).then(refreshSyncStatus);
    refreshPaceIfDateChanged();
  });
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  schedulePaceRefresh();
}

if (typeof document !== "undefined" && document.getElementById("scrim")) boot();

if (typeof module !== "undefined" && module.exports) {
  module.exports = { daysInMonth, monthPace, monthPaceLabel, budgetRemainPace, categoryRemainBar, jstNow, shiftMonth };
}
