(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BudgetSync = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SYNC_KEY = "budget-app-sync-v1";

  function emptyState() {
    return { url: "", token: "", queue: [], lastSyncAt: null, lastError: "" };
  }

  function loadState(storage) {
    try {
      const raw = storage.getItem(SYNC_KEY);
      if (!raw) return emptyState();
      const data = JSON.parse(raw);
      return {
        url: typeof data.url === "string" ? data.url : "",
        token: typeof data.token === "string" ? data.token : "",
        queue: Array.isArray(data.queue) ? data.queue : [],
        lastSyncAt: data.lastSyncAt || null,
        lastError: typeof data.lastError === "string" ? data.lastError : ""
      };
    } catch (e) {
      return emptyState();
    }
  }

  function saveState(storage, state) {
    storage.setItem(SYNC_KEY, JSON.stringify({
      url: state.url || "",
      token: state.token || "",
      queue: Array.isArray(state.queue) ? state.queue : [],
      lastSyncAt: state.lastSyncAt || null,
      lastError: state.lastError || ""
    }));
  }

  function qid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function stamp(event) {
    const copy = Object.assign({}, event);
    if (!copy.qid) copy.qid = qid();
    return copy;
  }

  function enqueue(state, events) {
    const list = Array.isArray(events) ? events : [events];
    state.queue = state.queue.concat(list.filter(Boolean).map(stamp));
    return state;
  }

  function toWire(event) {
    const copy = Object.assign({}, event);
    delete copy.qid;
    return copy;
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || "").trim());
      if (url.protocol !== "https:" && url.protocol !== "http:") return "";
      return url.toString();
    } catch (e) {
      return "";
    }
  }

  function configured(state) {
    return Boolean(safeUrl(state.url) && String(state.token || "").trim());
  }

  function categoryName(data, id) {
    const found = (data.categories || []).find(function (c) { return c.id === id; });
    return found ? found.name : "不明";
  }

  function expenseUpsert(expense, categoryNameValue, updatedAt) {
    const date = expense && expense.date ? String(expense.date) : "";
    return {
      type: "expense_upsert",
      id: expense.id,
      date: date,
      month: date.slice(0, 7),
      category: categoryNameValue || "不明",
      amount: Math.round(Number(expense.amount) || 0),
      memo: expense.memo ? String(expense.memo) : "",
      updatedAt: updatedAt
    };
  }

  function expenseDelete(id, updatedAt) {
    return { type: "expense_delete", id: id, updatedAt: updatedAt };
  }

  function budgetUpsert(month, category, amount, updatedAt) {
    return {
      type: "budget_upsert",
      month: month,
      category: category || "不明",
      amount: Math.round(Number(amount) || 0),
      updatedAt: updatedAt
    };
  }

  function pingEvent() {
    return { type: "ping" };
  }

  function budgetDiffEvents(month, beforeMap, afterMap, nameOf, updatedAt) {
    const events = [];
    const ids = new Set(Object.keys(beforeMap || {}).concat(Object.keys(afterMap || {})));
    ids.forEach(function (id) {
      const before = Math.round(Number((beforeMap || {})[id]) || 0);
      const after = Math.round(Number((afterMap || {})[id]) || 0);
      if (before !== after) events.push(budgetUpsert(month, nameOf(id), after, updatedAt));
    });
    return events;
  }

  function categoryRenameEvents(data, categoryId, oldName, newName, updatedAt) {
    const events = [];
    (data.expenses || []).forEach(function (expense) {
      if (expense.categoryId === categoryId) events.push(expenseUpsert(expense, newName, updatedAt));
    });
    Object.keys(data.budgets || {}).forEach(function (month) {
      const amount = Math.round(Number((data.budgets[month] || {})[categoryId]) || 0);
      if (amount > 0) {
        events.push(budgetUpsert(month, oldName, 0, updatedAt));
        events.push(budgetUpsert(month, newName, amount, updatedAt));
      }
    });
    return events;
  }

  function categoryDeleteEvents(data, categoryId, oldName, updatedAt) {
    const events = [];
    (data.expenses || []).forEach(function (expense) {
      if (expense.categoryId === categoryId) events.push(expenseUpsert(expense, "不明", updatedAt));
    });
    Object.keys(data.budgets || {}).forEach(function (month) {
      const amount = Math.round(Number((data.budgets[month] || {})[categoryId]) || 0);
      if (amount > 0) events.push(budgetUpsert(month, oldName, 0, updatedAt));
    });
    return events;
  }

  function budgetNameAmounts(data) {
    const map = new Map();
    Object.keys(data.budgets || {}).forEach(function (month) {
      Object.keys(data.budgets[month] || {}).forEach(function (id) {
        const amount = Math.round(Number(data.budgets[month][id]) || 0);
        if (amount <= 0) return;
        if (!(data.categories || []).some(function (c) { return c.id === id; })) return;
        const key = month + "\n" + categoryName(data, id);
        map.set(key, (map.get(key) || 0) + amount);
      });
    });
    return map;
  }

  function snapshotEvents(data, updatedAt) {
    const events = [];
    (data.expenses || []).forEach(function (expense) {
      events.push(expenseUpsert(expense, categoryName(data, expense.categoryId), updatedAt));
    });
    budgetNameAmounts(data).forEach(function (amount, key) {
      const nl = key.indexOf("\n");
      events.push(budgetUpsert(key.slice(0, nl), key.slice(nl + 1), amount, updatedAt));
    });
    return events;
  }

  function mirrorDiffEvents(before, after, updatedAt) {
    const events = [];
    const beforeExpenses = new Map((before.expenses || []).map(function (expense) { return [expense.id, expense]; }));
    const afterExpenses = new Map((after.expenses || []).map(function (expense) { return [expense.id, expense]; }));
    beforeExpenses.forEach(function (expense, id) {
      if (!afterExpenses.has(id)) events.push(expenseDelete(id, updatedAt));
    });
    afterExpenses.forEach(function (expense, id) {
      const prev = beforeExpenses.get(id);
      const name = categoryName(after, expense.categoryId);
      const prevName = prev ? categoryName(before, prev.categoryId) : "";
      const changed = !prev
        || prev.date !== expense.date
        || Math.round(Number(prev.amount) || 0) !== Math.round(Number(expense.amount) || 0)
        || String(prev.memo || "") !== String(expense.memo || "")
        || prevName !== name;
      if (changed) events.push(expenseUpsert(expense, name, updatedAt));
    });
    const beforeBudgets = budgetNameAmounts(before);
    const afterBudgets = budgetNameAmounts(after);
    const keys = new Set(Array.from(beforeBudgets.keys()).concat(Array.from(afterBudgets.keys())));
    keys.forEach(function (key) {
      const prev = beforeBudgets.get(key) || 0;
      const next = afterBudgets.get(key) || 0;
      if (prev === next) return;
      const nl = key.indexOf("\n");
      events.push(budgetUpsert(key.slice(0, nl), key.slice(nl + 1), next, updatedAt));
    });
    return events;
  }

  function replaceDataEvents(before, after, updatedAt) {
    const events = [];
    const afterIds = new Set((after.expenses || []).map(function (e) { return e.id; }));
    (before.expenses || []).forEach(function (expense) {
      if (!afterIds.has(expense.id)) events.push(expenseDelete(expense.id, updatedAt));
    });
    events.push.apply(events, snapshotEvents(after, updatedAt));
    const beforeBudgets = budgetNameAmounts(before);
    const afterBudgets = budgetNameAmounts(after);
    beforeBudgets.forEach(function (amount, key) {
      if (afterBudgets.has(key)) return;
      const nl = key.indexOf("\n");
      events.push(budgetUpsert(key.slice(0, nl), key.slice(nl + 1), 0, updatedAt));
    });
    return events;
  }

  function errorText(data) {
    if (data && data.error === "unauthorized") return "合言葉が一致しません";
    const msg = data && data.error ? String(data.error) : "送信に失敗しました";
    return msg.slice(0, 80);
  }

  function statusLine(state) {
    let when = "まだありません";
    if (state.lastSyncAt) {
      const date = new Date(state.lastSyncAt);
      when = Number.isNaN(date.getTime())
        ? String(state.lastSyncAt)
        : new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23"
        }).format(date);
    }
    const err = state.lastError ? state.lastError : "なし";
    return "最終送信: " + when + " / 保留 " + state.queue.length + "件 / エラー: " + err;
  }

  function postEvents(fetchImpl, url, token, events) {
    return fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: token, events: events.map(toWire) })
    }).then(function (res) { return res.json(); });
  }

  let running = false;
  let rerun = false;
  let chain = Promise.resolve();

  function flushOnce(storage, fetchImpl) {
    const state = loadState(storage);
    if (!state.queue.length) return Promise.resolve(state);
    const token = String(state.token || "").trim();
    const url = safeUrl(state.url);
    if (!token || !url) {
      if (state.url.trim() && !url) {
        state.lastError = "送信先URLを確認してください";
        saveState(storage, state);
      }
      return Promise.resolve(state);
    }
    const batch = state.queue.slice();
    return postEvents(fetchImpl, url, token, batch).then(function (data) {
      const current = loadState(storage);
      if (data && data.ok === true) {
        const sent = new Set(batch.map(function (ev) { return ev.qid; }));
        current.queue = current.queue.filter(function (ev) { return !sent.has(ev.qid); });
        current.lastSyncAt = new Date().toISOString();
        current.lastError = "";
        saveState(storage, current);
        return current;
      }
      current.lastError = errorText(data);
      saveState(storage, current);
      return current;
    }).catch(function () {
      const current = loadState(storage);
      current.lastError = "送信できませんでした";
      saveState(storage, current);
      return current;
    });
  }

  function flush(storage, fetchImpl) {
    if (running) {
      rerun = true;
      return chain;
    }
    running = true;
    chain = (async function () {
      try {
        do {
          rerun = false;
          await flushOnce(storage, fetchImpl);
        } while (rerun);
      } finally {
        running = false;
      }
      return loadState(storage);
    })();
    return chain;
  }

  return {
    SYNC_KEY: SYNC_KEY,
    loadState: loadState,
    saveState: saveState,
    enqueue: enqueue,
    configured: configured,
    safeUrl: safeUrl,
    expenseUpsert: expenseUpsert,
    expenseDelete: expenseDelete,
    budgetUpsert: budgetUpsert,
    pingEvent: pingEvent,
    budgetDiffEvents: budgetDiffEvents,
    categoryRenameEvents: categoryRenameEvents,
    categoryDeleteEvents: categoryDeleteEvents,
    snapshotEvents: snapshotEvents,
    mirrorDiffEvents: mirrorDiffEvents,
    replaceDataEvents: replaceDataEvents,
    errorText: errorText,
    statusLine: statusLine,
    postEvents: postEvents,
    toWire: toWire,
    flush: flush
  };
});
