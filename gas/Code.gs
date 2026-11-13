/**
 * 予算管理アプリから、このスプレッドシートへ記録のコピーを受け取ります。
 *
 * 準備（詳しくは SETUP.md）:
 * 1. 拡張機能 → Apps Script に、このファイルの中身を貼る
 * 2. プロジェクトの設定 → スクリプト プロパティ
 *    名前は SYNC_TOKEN、値はアプリの「合言葉」と同じ文字列
 * 3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *    実行するユーザーは「自分」、アクセスできるユーザーは「全員」
 * 4. このファイルを直したあとは、デプロイを管理 → 編集 → 新バージョン
 *    （URL を変えないため）
 *
 * 合言葉の値、ウェブアプリの URL、支出の金額は、このファイルや Git に書かないでください。
 * 端末の中の記録が本体です。こちらはコピーです。
 * 文字の列はプレーンテキストとして書き、= + - @ で始まる値には引用符を付けます。
 */

var EXPENSE_SHEET = "支出";
var BUDGET_SHEET = "予算";
var EXPENSE_HEADERS = ["ID", "日付", "月", "カテゴリ", "金額", "メモ", "更新日時", "削除"];
var BUDGET_HEADERS = ["月", "カテゴリ", "予算額", "更新日時"];
var MAX_EVENTS = 500;
var MAX_TEXT = 200;
var MAX_ID = 64;
var MAX_UPDATED = 80;

function doGet() {
  return json_({ ok: true });
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    if (!authorized_(body && body.token)) {
      return json_({ ok: false, error: "unauthorized" });
    }
    var events = body && Array.isArray(body.events) ? body.events : [];
    if (events.length > MAX_EVENTS) {
      return json_({ ok: false, error: "too many events" });
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var sawPing = false;
      var skipped = 0;
      for (var i = 0; i < events.length; i++) {
        var ev = events[i] || {};
        if (ev.type === "ping") {
          sawPing = true;
        } else if (ev.type === "expense_upsert") {
          if (!validExpenseUpsert_(ev)) skipped++;
          else upsertExpense_(ev);
        } else if (ev.type === "expense_delete") {
          if (!validExpenseDelete_(ev)) skipped++;
          else markExpenseDeleted_(ev);
        } else if (ev.type === "budget_upsert") {
          if (!validBudgetUpsert_(ev)) skipped++;
          else upsertBudget_(ev);
        } else {
          skipped++;
        }
      }
      SpreadsheetApp.flush();
      var result = { ok: true, skipped: skipped };
      if (sawPing) result.pong = true;
      return json_(result);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function authorized_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty("SYNC_TOKEN");
  if (!expected || token === undefined || token === null || String(token) === "") return false;
  return String(token) === String(expected);
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  return JSON.parse(e.postData.contents);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function validId_(id) {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID && /^[A-Za-z0-9_-]+$/.test(id);
}

function validDate_(value) {
  var text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  var y = Number(text.slice(0, 4));
  var m = Number(text.slice(5, 7));
  var d = Number(text.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function validMonth_(value) {
  var text = String(value || "");
  if (!/^\d{4}-\d{2}$/.test(text)) return false;
  var m = Number(text.slice(5, 7));
  return m >= 1 && m <= 12;
}

function textLenOk_(value) {
  return String(value == null ? "" : value).length <= MAX_TEXT;
}

function updatedOk_(value) {
  return String(value == null ? "" : value).length <= MAX_UPDATED;
}

function validExpenseUpsert_(ev) {
  var date = String(ev.date || "");
  var month = String(ev.month || "");
  return validId_(ev.id) && validDate_(date) && validMonth_(month) && month === date.slice(0, 7) && textLenOk_(ev.category) && textLenOk_(ev.memo) && updatedOk_(ev.updatedAt);
}

function validExpenseDelete_(ev) {
  return validId_(ev.id) && updatedOk_(ev.updatedAt);
}

function validBudgetUpsert_(ev) {
  var category = String(ev.category == null ? "" : ev.category);
  return validMonth_(ev.month) && category.length > 0 && textLenOk_(category) && updatedOk_(ev.updatedAt);
}

function sheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("スプレッドシートに紐づいたスクリプトとして実行してください");
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function findRowBy_(sh, match) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var width = Math.max(sh.getLastColumn(), 1);
  var values = sh.getRange(2, 1, last - 1, width).getValues();
  for (var i = 0; i < values.length; i++) {
    if (match(values[i])) return i + 2;
  }
  return -1;
}

function isStale_(incoming, existing) {
  var inc = toMillis_(incoming);
  var cur = toMillis_(storedText_(existing));
  if (inc === null || cur === null) return false;
  return inc < cur;
}

function toMillis_(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && isFinite(value)) return value;
  var text = storedText_(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  var parsed = Date.parse(text);
  return isNaN(parsed) ? null : parsed;
}

function storedText_(value) {
  if (value instanceof Date) return value;
  var text = String(value == null ? "" : value);
  if (text.charAt(0) === "'") return text.slice(1);
  return text;
}

function plainText_(value) {
  var text = String(value == null ? "" : value);
  if (!text) return "";
  var first = text.charAt(0);
  if (first === "=" || first === "+" || first === "-" || first === "@" || first === "\t" || first === "\r") {
    return "'" + text;
  }
  return text;
}

function amount_(value) {
  var n = Number(value);
  if (!isFinite(n)) return 0;
  return n;
}

function markText_(sh, row, cols) {
  for (var i = 0; i < cols.length; i++) sh.getRange(row, cols[i]).setNumberFormat("@");
}

function upsertExpense_(ev) {
  var id = String(ev.id);
  var sh = sheet_(EXPENSE_SHEET, EXPENSE_HEADERS);
  var row = findRowBy_(sh, function (values) { return storedText_(values[0]) === id; });
  if (row > 1 && isStale_(ev.updatedAt, sh.getRange(row, 7).getValue())) return;
  var target = row > 1 ? row : sh.getLastRow() + 1;
  markText_(sh, target, [1, 2, 3, 4, 6, 7]);
  sh.getRange(target, 5).setNumberFormat("0");
  var values = [[
    plainText_(id),
    plainText_(ev.date || ""),
    plainText_(ev.month || ""),
    plainText_(ev.category || ""),
    amount_(ev.amount),
    plainText_(ev.memo || ""),
    plainText_(ev.updatedAt || ""),
    false
  ]];
  sh.getRange(target, 1, 1, 8).setValues(values);
}

function markExpenseDeleted_(ev) {
  var id = String(ev.id);
  var sh = sheet_(EXPENSE_SHEET, EXPENSE_HEADERS);
  var row = findRowBy_(sh, function (values) { return storedText_(values[0]) === id; });
  if (row > 1) {
    if (isStale_(ev.updatedAt, sh.getRange(row, 7).getValue())) return;
    markText_(sh, row, [7]);
    sh.getRange(row, 7).setValue(plainText_(ev.updatedAt || ""));
    sh.getRange(row, 8).setValue(true);
    return;
  }
  var target = sh.getLastRow() + 1;
  markText_(sh, target, [1, 2, 3, 4, 6, 7]);
  sh.getRange(target, 1, 1, 8).setValues([[
    plainText_(id), "", "", "", "", "", plainText_(ev.updatedAt || ""), true
  ]]);
}

function upsertBudget_(ev) {
  var month = String(ev.month || "");
  var category = String(ev.category || "");
  var sh = sheet_(BUDGET_SHEET, BUDGET_HEADERS);
  var row = findRowBy_(sh, function (values) {
    return storedText_(values[0]) === month && storedText_(values[1]) === category;
  });
  if (row > 1 && isStale_(ev.updatedAt, sh.getRange(row, 4).getValue())) return;
  var target = row > 1 ? row : sh.getLastRow() + 1;
  markText_(sh, target, [1, 2, 4]);
  sh.getRange(target, 3).setNumberFormat("0");
  sh.getRange(target, 1, 1, 4).setValues([[
    plainText_(month),
    plainText_(category),
    amount_(ev.amount),
    plainText_(ev.updatedAt || "")
  ]]);
}
