const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");
const BudgetSync = require("../sync.js");

function memoryStorage() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); }
  };
}

function sampleData() {
  return {
    categories: [
      { id: "food", name: "食費" },
      { id: "daily", name: "日用品" }
    ],
    budgets: { "2026-11": { food: 30000, daily: 5000 } },
    expenses: [
      { id: "e1", amount: 1200, date: "2026-11-03", categoryId: "food", memo: "パン", createdAt: 1 }
    ]
  };
}

async function testQueueAndMockServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      received.push({
        method: req.method,
        contentType: req.headers["content-type"],
        body
      });
      res.setHeader("Content-Type", "application/json");
      if (body.token !== "test-token") {
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      if ((body.events || []).some((event) => event.type === "ping")) {
        res.end(JSON.stringify({ ok: true, pong: true }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/exec`;
  const storage = memoryStorage();
  const state = BudgetSync.loadState(storage);
  state.url = url;
  state.token = "test-token";
  const updatedAt = "2026-11-13T00:00:00.000Z";
  BudgetSync.enqueue(state, [
    BudgetSync.expenseUpsert(sampleData().expenses[0], "食費", updatedAt),
    BudgetSync.budgetUpsert("2026-11", "食費", 30000, updatedAt)
  ]);
  BudgetSync.saveState(storage, state);

  await BudgetSync.flush(storage, fetch);
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].method, "POST");
  assert.strictEqual(received[0].contentType, "text/plain;charset=utf-8");
  assert.strictEqual(received[0].body.token, "test-token");
  assert.deepStrictEqual(received[0].body.events.map((event) => event.type), ["expense_upsert", "budget_upsert"]);
  assert.strictEqual(received[0].body.events[0].qid, undefined);
  assert.strictEqual(received[0].body.events[0].month, "2026-11");
  assert.strictEqual(received[0].body.events[0].category, "食費");
  const after = BudgetSync.loadState(storage);
  assert.strictEqual(after.queue.length, 0);
  assert.ok(after.lastSyncAt);
  assert.strictEqual(after.lastError, "");

  const ping = await BudgetSync.postEvents(fetch, url, "test-token", [BudgetSync.pingEvent()]);
  assert.deepStrictEqual(ping, { ok: true, pong: true });

  const queued = BudgetSync.loadState(storage);
  BudgetSync.enqueue(queued, [BudgetSync.expenseDelete("e1", updatedAt)]);
  queued.token = "wrong";
  BudgetSync.saveState(storage, queued);
  await BudgetSync.flush(storage, fetch);
  const kept = BudgetSync.loadState(storage);
  assert.strictEqual(kept.queue.length, 1);
  assert.strictEqual(kept.lastError, "合言葉が一致しません");
  assert.strictEqual(kept.queue[0].type, "expense_delete");

  server.close();
}

async function testRetryAndOverlap() {
  const storage = memoryStorage();
  const state = BudgetSync.loadState(storage);
  state.url = "https://example.com/exec";
  state.token = "test-token";
  BudgetSync.enqueue(state, [BudgetSync.expenseDelete("e1", "2026-11-13T00:00:00.000Z")]);
  BudgetSync.saveState(storage, state);

  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new Error("offline");
    return { json: async () => ({ ok: true }) };
  };
  await BudgetSync.flush(storage, fetchImpl);
  assert.strictEqual(BudgetSync.loadState(storage).queue.length, 1);
  assert.strictEqual(BudgetSync.loadState(storage).lastError, "送信できませんでした");
  await BudgetSync.flush(storage, fetchImpl);
  assert.strictEqual(BudgetSync.loadState(storage).queue.length, 0);

  const gate = {};
  gate.promise = new Promise((resolve) => { gate.resolve = resolve; });
  const bodies = [];
  const slowFetch = (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return gate.promise.then(() => ({ json: async () => ({ ok: true }) }));
  };
  const again = BudgetSync.loadState(storage);
  again.url = "https://example.com/exec";
  again.token = "test-token";
  BudgetSync.enqueue(again, [BudgetSync.budgetUpsert("2026-11", "食費", 1000, "2026-11-13T01:00:00.000Z")]);
  BudgetSync.saveState(storage, again);
  const first = BudgetSync.flush(storage, slowFetch);
  const queued = BudgetSync.loadState(storage);
  BudgetSync.enqueue(queued, [BudgetSync.budgetUpsert("2026-11", "日用品", 500, "2026-11-13T01:00:01.000Z")]);
  BudgetSync.saveState(storage, queued);
  const second = BudgetSync.flush(storage, slowFetch);
  gate.resolve();
  await first;
  await second;
  assert.strictEqual(BudgetSync.loadState(storage).queue.length, 0);
  assert.deepStrictEqual(bodies.map((body) => body.events.map((event) => event.category)), [["食費"], ["日用品"]]);
}

function testEventShapes() {
  const data = sampleData();
  const at = "2026-11-13T02:00:00.000Z";
  const copied = BudgetSync.budgetDiffEvents("2026-11", {}, { food: 30000, daily: 5000 }, (id) => id === "food" ? "食費" : "日用品", at);
  assert.strictEqual(copied.length, 2);
  assert.deepStrictEqual(copied[0], {
    type: "budget_upsert", month: "2026-11", category: "食費", amount: 30000, updatedAt: at
  });
  const cleared = BudgetSync.budgetDiffEvents("2026-11", { food: 30000 }, {}, () => "食費", at);
  assert.strictEqual(cleared[0].amount, 0);
  const same = BudgetSync.budgetDiffEvents("2026-11", { food: 30000 }, { food: 30000 }, () => "食費", at);
  assert.strictEqual(same.length, 0);

  const renamed = BudgetSync.categoryRenameEvents(data, "food", "食費", "食事", at);
  assert.strictEqual(renamed[0].type, "expense_upsert");
  assert.strictEqual(renamed[0].category, "食事");
  assert.deepStrictEqual(renamed.slice(1).map((event) => [event.category, event.amount]), [["食費", 0], ["食事", 30000]]);

  const removed = BudgetSync.categoryDeleteEvents(data, "food", "食費", at);
  assert.strictEqual(removed[0].category, "不明");
  assert.strictEqual(removed[1].amount, 0);

  const swapped = sampleData();
  const beforeSwap = JSON.parse(JSON.stringify(swapped));
  swapped.categories[0].name = "日用品";
  swapped.categories[1].name = "食費";
  const swapEvents = BudgetSync.mirrorDiffEvents(beforeSwap, swapped, at);
  const swapBudgets = swapEvents.filter((event) => event.type === "budget_upsert");
  assert.deepStrictEqual(swapBudgets.map((event) => [event.category, event.amount]).sort(), [["日用品", 30000], ["食費", 5000]]);
  assert.strictEqual(swapEvents.filter((event) => event.type === "expense_upsert" && event.category === "日用品").length, 1);

  const snap = BudgetSync.snapshotEvents(data, at);
  assert.strictEqual(snap.filter((event) => event.type === "expense_upsert").length, 1);
  assert.strictEqual(snap.filter((event) => event.type === "budget_upsert").length, 2);
  const withOrphan = sampleData();
  withOrphan.budgets["2026-11"].removed = 9999;
  const orphanSnap = BudgetSync.snapshotEvents(withOrphan, at);
  assert.ok(!orphanSnap.some((event) => event.amount === 9999 || event.category === "不明"));

  const replaced = BudgetSync.replaceDataEvents(data, {
    categories: data.categories,
    budgets: { "2026-11": { daily: 5000 } },
    expenses: []
  }, at);
  assert.ok(replaced.some((event) => event.type === "expense_delete" && event.id === "e1"));
  assert.ok(replaced.some((event) => event.type === "budget_upsert" && event.category === "食費" && event.amount === 0));

  const offline = memoryStorage();
  const state = BudgetSync.loadState(offline);
  BudgetSync.enqueue(state, [BudgetSync.pingEvent()]);
  BudgetSync.saveState(offline, state);
  let called = false;
  return BudgetSync.flush(offline, () => { called = true; return Promise.resolve({ json: async () => ({ ok: true }) }); })
    .then((result) => {
      assert.strictEqual(called, false);
      assert.strictEqual(result.queue.length, 1);
      assert.strictEqual(BudgetSync.configured(result), false);
    });
}

function testSheets() {
  const syntaxPath = path.join(os.tmpdir(), "budget-code-syntax-check.js");
  fs.copyFileSync(path.join(__dirname, "../gas/Code.gs"), syntaxPath);
  const syntax = spawnSync(process.execPath, ["--check", syntaxPath], { encoding: "utf8" });
  fs.unlinkSync(syntaxPath);
  assert.strictEqual(syntax.status, 0, syntax.stderr);

  class MemSheet {
    constructor(name) {
      this.name = name;
      this.rows = [];
      this.frozen = 0;
    }
    getLastRow() { return this.rows.length; }
    getLastColumn() { return this.rows.reduce((max, row) => Math.max(max, row.length), 0); }
    setFrozenRows(n) { this.frozen = n; }
    appendRow(values) { this.rows.push(values.slice()); }
    getRange(row, col, numRows, numCols) {
      const r = row;
      const c = col;
      const nr = numRows === undefined ? 1 : numRows;
      const nc = numCols === undefined ? 1 : numCols;
      const sheet = this;
      return {
        setValues(values) {
          for (let i = 0; i < values.length; i++) {
            while (sheet.rows.length < r + i) sheet.rows.push([]);
            const target = sheet.rows[r - 1 + i];
            for (let j = 0; j < values[i].length; j++) target[c - 1 + j] = values[i][j];
          }
        },
        setValue(value) { this.setValues([[value]]); },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const src = sheet.rows[r - 1 + i] || [];
            const line = [];
            for (let j = 0; j < nc; j++) line.push(src[c - 1 + j] === undefined ? "" : src[c - 1 + j]);
            out.push(line);
          }
          return out;
        },
        getValue() { return this.getValues()[0][0]; }
      };
    }
  }

  const sheets = [];
  const props = { SYNC_TOKEN: "phrase" };
  let locks = 0;
  const context = {
    Date, JSON, Math, Number, String, Object, Array, Error, RegExp, isFinite, isNaN,
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput(text) {
        return { text, setMimeType(mime) { this.mime = mime; return this; } };
      }
    },
    LockService: {
      getScriptLock() {
        return {
          waitLock() { locks += 1; },
          releaseLock() { locks -= 1; }
        };
      }
    },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty(key) { return props[key] || null; } };
      }
    },
    SpreadsheetApp: {
      flush() {},
      getActiveSpreadsheet() {
        return {
          getSheetByName(name) { return sheets.find((sheet) => sheet.name === name) || null; },
          insertSheet(name) {
            const sheet = new MemSheet(name);
            sheets.push(sheet);
            return sheet;
          }
        };
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../gas/Code.gs"), "utf8"), context);

  function post(body, token) {
    const output = context.doPost({
      postData: { contents: JSON.stringify(Object.assign({ token: token === undefined ? "phrase" : token }, body)) }
    });
    assert.strictEqual(output.mime, "application/json");
    return JSON.parse(output.text);
  }

  assert.deepStrictEqual(JSON.parse(context.doGet().text), { ok: true });
  assert.deepStrictEqual(post({ events: [{ type: "ping" }] }, "nope"), { ok: false, error: "unauthorized" });
  assert.strictEqual(sheets.length, 0);
  delete props.SYNC_TOKEN;
  assert.strictEqual(post({ events: [{ type: "ping" }] }).ok, false);
  props.SYNC_TOKEN = "phrase";
  assert.deepStrictEqual(post({ events: [{ type: "ping" }] }), { ok: true, pong: true });
  assert.strictEqual(locks, 0);

  const t1 = "2026-11-13T03:00:00.000Z";
  const t0 = "2026-11-13T02:00:00.000Z";
  const t2 = "2026-11-13T04:00:00.000Z";
  assert.strictEqual(post({
    events: [{ type: "expense_upsert", id: "e1", date: "2026-11-03", month: "2026-11", category: "食費", amount: 1200, memo: "パン", updatedAt: t1 }]
  }).ok, true);
  const expense = sheets.find((sheet) => sheet.name === "支出");
  assert.deepStrictEqual(expense.rows[0], ["ID", "日付", "月", "カテゴリ", "金額", "メモ", "更新日時", "削除"]);
  assert.strictEqual(expense.frozen, 1);
  assert.strictEqual(expense.rows[1][4], 1200);
  assert.strictEqual(expense.rows[1][7], false);

  post({ events: [{ type: "expense_upsert", id: "e1", date: "2026-11-03", month: "2026-11", category: "食費", amount: 1, memo: "古い", updatedAt: t0 }] });
  assert.strictEqual(expense.rows[1][4], 1200);
  assert.strictEqual(expense.rows.length, 2);

  post({ events: [{ type: "expense_delete", id: "e1", updatedAt: t0 }] });
  assert.strictEqual(expense.rows[1][7], false);

  post({ events: [{ type: "expense_delete", id: "e1", updatedAt: t2 }] });
  assert.strictEqual(expense.rows[1][7], true);
  assert.strictEqual(expense.rows[1][4], 1200);
  assert.strictEqual(expense.rows.length, 2);

  post({ events: [{ type: "expense_delete", id: "gone", updatedAt: t2 }] });
  assert.strictEqual(expense.rows[2][0], "gone");
  assert.strictEqual(expense.rows[2][7], true);

  post({
    events: [{ type: "expense_upsert", id: "e1", date: "2026-11-04", month: "2026-11", category: "日用品", amount: 800, memo: "", updatedAt: "2026-11-13T05:00:00.000Z" }]
  });
  assert.strictEqual(expense.rows[1][3], "日用品");
  assert.strictEqual(expense.rows[1][4], 800);
  assert.strictEqual(expense.rows[1][7], false);

  post({
    events: [
      { type: "budget_upsert", month: "2026-11", category: "食費", amount: 30000, updatedAt: t1 },
      { type: "budget_upsert", month: "2026-11", category: "食費", amount: 100, updatedAt: t0 },
      { type: "budget_upsert", month: "2026-11", category: "日用品", amount: 5000, updatedAt: t1 }
    ]
  });
  const budget = sheets.find((sheet) => sheet.name === "予算");
  assert.deepStrictEqual(budget.rows[0], ["月", "カテゴリ", "予算額", "更新日時"]);
  assert.strictEqual(budget.rows.length, 3);
  assert.strictEqual(budget.rows[1][2], 30000);
  assert.strictEqual(budget.rows[2][1], "日用品");
}

async function testRepoHasNoSecrets() {
  const files = [
    "index.html", "sync.js", "sw.js", "README.md", "gas/Code.gs", "gas/SETUP.md", "manifest.webmanifest"
  ];
  const banned = [/ghp_[A-Za-z0-9]/, /github_pat_[A-Za-z0-9]/, /AIza[0-9A-Za-z_-]{20}/, /SYNC_TOKEN\s*[:=]\s*["'][^"']+["']/];
  for (const file of files) {
    const text = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    for (const pattern of banned) assert.strictEqual(pattern.test(text), false, file + " matched " + pattern);
  }
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.ok(html.includes('src="sync.js"'));
  assert.ok(html.includes("スプレッドシート連携"));
  assert.ok(html.includes("接続テスト"));
  assert.ok(html.includes("全データを送り直す"));
  const sw = fs.readFileSync(path.join(__dirname, "../sw.js"), "utf8");
  assert.ok(sw.includes('const CACHE = "budget-app-v2"'));
  assert.ok(sw.includes("./sync.js"));
}

(async function main() {
  await testQueueAndMockServer();
  await testRetryAndOverlap();
  await testEventShapes();
  testSheets();
  await testRepoHasNoSecrets();
  console.log("sync tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
