/**
 * 予算管理アプリから、このスプレッドシートへ記録のコピーを受け取ります。
 *
 * 準備（詳しくは SETUP.md）:
 * 1. 拡張機能 → Apps Script に、このファイルの中身を貼る
 * 2. プロジェクトの設定 → スクリプト プロパティ
 *    名前は SYNC_TOKEN、値はアプリの「合言葉」と同じ文字列
 * 3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *    実行するユーザーは「自分」、アクセスできるユーザーは「全員」
 *
 * 合言葉の値、ウェブアプリの URL、支出の金額は、このファイルや Git に書かないでください。
 * 端末の中の記録が本体です。こちらはコピーです。
 */

var EXPENSE_SHEET = "支出";
var BUDGET_SHEET = "予算";
var EXPENSE_HEADERS = ["ID", "日付", "月", "カテゴリ", "金額", "メモ", "更新日時", "削除"];
var BUDGET_HEADERS = ["月", "カテゴリ", "予算額", "更新日時"];

function doGet() {
  return json_({ ok: true });
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    if (!authorized_(body && body.token)) {
      return json_({ ok: false, error: "unauthorized" });
    }
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      var events = body && Array.isArray(body.events) ? body.events : [];
      var sawPing = false;
      for (var i = 0; i < events.length; i++) {
        var ev = events[i] || {};
        if (ev.type === "ping") sawPing = true;
        else if (ev.type === "expense_upsert") upsertExpense_(ev);
        else if (ev.type === "expense_delete") markExpenseDeleted_(ev);
        else if (ev.type === "budget_upsert") upsertBudget_(ev);
      }
      SpreadsheetApp.flush();
      var result = { ok: true };
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
  var cur = toMillis_(existing);
  if (inc === null || cur === null) return false;
  return inc < cur;
}

function toMillis_(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && isFinite(value)) return value;
  var text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  var parsed = Date.parse(text);
  return isNaN(parsed) ? null : parsed;
}

function upsertExpense_(ev) {
  var id = String(ev.id || "");
  if (!id) return;
  var sh = sheet_(EXPENSE_SHEET, EXPENSE_HEADERS);
  var row = findRowBy_(sh, function (values) { return String(values[0]) === id; });
  if (row > 1 && isStale_(ev.updatedAt, sh.getRange(row, 7).getValue())) return;
  var values = [[
    id,
    String(ev.date || ""),
    String(ev.month || ""),
    String(ev.category || ""),
    Number(ev.amount || 0),
    String(ev.memo || ""),
    String(ev.updatedAt || ""),
    false
  ]];
  if (row > 1) sh.getRange(row, 1, 1, 8).setValues(values);
  else sh.appendRow(values[0]);
}

function markExpenseDeleted_(ev) {
  var id = String(ev.id || "");
  if (!id) return;
  var sh = sheet_(EXPENSE_SHEET, EXPENSE_HEADERS);
  var row = findRowBy_(sh, function (values) { return String(values[0]) === id; });
  if (row > 1) {
    if (isStale_(ev.updatedAt, sh.getRange(row, 7).getValue())) return;
    sh.getRange(row, 7).setValue(String(ev.updatedAt || ""));
    sh.getRange(row, 8).setValue(true);
    return;
  }
  sh.appendRow([id, "", "", "", "", "", String(ev.updatedAt || ""), true]);
}

function upsertBudget_(ev) {
  var month = String(ev.month || "");
  var category = String(ev.category || "");
  if (!month || !category) return;
  var sh = sheet_(BUDGET_SHEET, BUDGET_HEADERS);
  var row = findRowBy_(sh, function (values) {
    return String(values[0]) === month && String(values[1]) === category;
  });
  if (row > 1 && isStale_(ev.updatedAt, sh.getRange(row, 4).getValue())) return;
  var values = [[month, category, Number(ev.amount || 0), String(ev.updatedAt || "")]];
  if (row > 1) sh.getRange(row, 1, 1, 4).setValues(values);
  else sh.appendRow(values[0]);
}
