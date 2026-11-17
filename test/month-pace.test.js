const assert = require("assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { daysInMonth, monthPace, monthPaceLabel, budgetRemainPace, categoryRemainBar, jstNow } = require("../app.js");

function on(year, month, day) {
  return {
    year: String(year),
    month: String(month).padStart(2, "0"),
    day: String(day).padStart(2, "0")
  };
}

function pace(ym, year, month, day) {
  return monthPace(ym, on(year, month, day));
}

function testMonthLengths() {
  assert.strictEqual(daysInMonth("2023-02"), 28);
  assert.strictEqual(daysInMonth("2024-02"), 29);
  assert.strictEqual(daysInMonth("1900-02"), 28);
  assert.strictEqual(daysInMonth("2000-02"), 29);
  assert.strictEqual(daysInMonth("2026-11"), 30);
  assert.strictEqual(daysInMonth("2026-01"), 31);
  assert.strictEqual(daysInMonth("2026-04"), 30);
  assert.strictEqual(daysInMonth("2026-12"), 31);
}

function testIncludesTodayAndRounds() {
  const nov = pace("2026-11", 2026, 11, 17);
  assert.strictEqual(nov.status, "current");
  assert.strictEqual(nov.total, 30);
  assert.strictEqual(nov.remaining, 14);
  assert.strictEqual(nov.pct, 47);
  assert.strictEqual(monthPaceLabel(nov), "月末まで残り 14日（47%）");

  const example = pace("2026-01", 2026, 1, 18);
  assert.strictEqual(example.remaining, 14);
  assert.strictEqual(example.pct, 45);
  assert.strictEqual(monthPaceLabel(example), "月末まで残り 14日（45%）");

  assert.deepStrictEqual(
    { remaining: pace("2026-11", 2026, 11, 1).remaining, pct: pace("2026-11", 2026, 11, 1).pct },
    { remaining: 30, pct: 100 }
  );
  assert.deepStrictEqual(
    { remaining: pace("2026-11", 2026, 11, 30).remaining, pct: pace("2026-11", 2026, 11, 30).pct },
    { remaining: 1, pct: 3 }
  );
  assert.strictEqual(pace("2026-04", 2026, 4, 15).remaining, 16);
  assert.strictEqual(pace("2026-04", 2026, 4, 15).pct, 53);
  assert.strictEqual(pace("2026-01", 2026, 1, 31).remaining, 1);
  assert.strictEqual(pace("2026-01", 2026, 1, 31).pct, 3);
}

function testLeapDays() {
  assert.strictEqual(pace("2024-02", 2024, 2, 1).remaining, 29);
  assert.strictEqual(pace("2024-02", 2024, 2, 1).pct, 100);
  assert.strictEqual(pace("2024-02", 2024, 2, 29).remaining, 1);
  assert.strictEqual(pace("2024-02", 2024, 2, 29).pct, 3);
  assert.strictEqual(pace("2023-02", 2023, 2, 28).remaining, 1);
  assert.strictEqual(pace("2023-02", 2023, 2, 28).pct, 4);
  assert.strictEqual(pace("2000-02", 2000, 2, 29).remaining, 1);
  assert.strictEqual(pace("1900-02", 1900, 2, 28).total, 28);
}

function testMonthBoundaries() {
  const endOfNov = pace("2026-11", 2026, 12, 1);
  assert.strictEqual(endOfNov.status, "past");
  assert.strictEqual(endOfNov.remaining, 0);
  assert.strictEqual(endOfNov.pct, 0);
  assert.strictEqual(monthPaceLabel(endOfNov), "月末まで残り 0日（0%）");

  const beforeNov = pace("2026-11", 2026, 10, 31);
  assert.strictEqual(beforeNov.status, "future");
  assert.strictEqual(beforeNov.remaining, 30);
  assert.strictEqual(beforeNov.pct, 100);

  assert.strictEqual(pace("2026-12", 2026, 12, 31).remaining, 1);
  assert.strictEqual(pace("2027-01", 2026, 12, 31).status, "future");
  assert.strictEqual(pace("2027-01", 2026, 12, 31).remaining, 31);
  assert.strictEqual(pace("2026-12", 2027, 1, 1).status, "past");
  assert.strictEqual(pace("2026-12", 2027, 1, 1).remaining, 0);

  assert.strictEqual(pace("2028-02", 2026, 11, 17).remaining, 29);
  assert.strictEqual(pace("2027-02", 2026, 11, 17).remaining, 28);
  assert.strictEqual(pace("2024-02", 2024, 3, 1).remaining, 0);
  assert.strictEqual(pace("2024-01", 2024, 2, 29).status, "past");
}

function testBudgetComparison() {
  const current = pace("2026-11", 2026, 11, 17);
  const unset = budgetRemainPace(0, 0, current);
  assert.strictEqual(unset.text, "予算の残り 未設定");
  assert.strictEqual(unset.pct, null);
  assert.strictEqual(unset.width, 0);

  const ahead = budgetRemainPace(100000, 62000, current);
  assert.strictEqual(ahead.text, "予算の残り 62%");
  assert.strictEqual(ahead.width, 62);
  assert.strictEqual(ahead.cls, "");

  const behind = budgetRemainPace(100000, 40000, current);
  assert.strictEqual(behind.text, "予算の残り 40%");
  assert.strictEqual(behind.cls, "warn");

  const tied = budgetRemainPace(100, current.pct, current);
  assert.strictEqual(tied.pct, current.pct);
  assert.strictEqual(tied.cls, "");

  const over = budgetRemainPace(100000, -5000, current);
  assert.strictEqual(over.text, "予算の残り −5%");
  assert.strictEqual(over.width, 0);
  assert.strictEqual(over.cls, "danger");

  const past = pace("2026-10", 2026, 11, 17);
  assert.strictEqual(budgetRemainPace(100000, 40000, past).cls, "");
  const future = pace("2026-12", 2026, 11, 17);
  assert.strictEqual(budgetRemainPace(100000, 40000, future).cls, "");
}

function testCategoryRemainBar() {
  const current = pace("2026-11", 2026, 11, 17);
  assert.strictEqual(current.pct, 47);

  const unset = categoryRemainBar(0, 0, current);
  assert.strictEqual(unset.pct, null);
  assert.strictEqual(unset.width, 0);
  assert.strictEqual(unset.cls, "");

  const unsetSpent = categoryRemainBar(0, 1200, current);
  assert.strictEqual(unsetSpent.pct, null);
  assert.strictEqual(unsetSpent.width, 100);
  assert.strictEqual(unsetSpent.cls, "");
  assert.strictEqual(unsetSpent.remain, -1200);

  const ahead = categoryRemainBar(100000, 38000, current);
  assert.strictEqual(ahead.pct, 62);
  assert.strictEqual(ahead.width, 62);
  assert.strictEqual(ahead.cls, "");
  assert.strictEqual(ahead.remain, 62000);

  const behind = categoryRemainBar(100000, 60000, current);
  assert.strictEqual(behind.pct, 40);
  assert.strictEqual(behind.width, 40);
  assert.strictEqual(behind.cls, "behind");

  const tied = categoryRemainBar(100, 100 - current.pct, current);
  assert.strictEqual(tied.pct, current.pct);
  assert.strictEqual(tied.width, current.pct);
  assert.strictEqual(tied.cls, "");

  const justUnder = categoryRemainBar(100, 100 - (current.pct - 1), current);
  assert.strictEqual(justUnder.pct, current.pct - 1);
  assert.strictEqual(justUnder.cls, "behind");

  const over = categoryRemainBar(100000, 120000, current);
  assert.strictEqual(over.pct, 0);
  assert.strictEqual(over.width, 0);
  assert.strictEqual(over.cls, "behind");
  assert.strictEqual(over.remain, -20000);

  const past = pace("2026-10", 2026, 11, 17);
  assert.strictEqual(past.pct, 0);
  assert.strictEqual(categoryRemainBar(10000, 15000, past).cls, "");
  assert.strictEqual(categoryRemainBar(10000, 15000, past).pct, 0);
  assert.strictEqual(categoryRemainBar(10000, 4000, past).pct, 60);
  assert.strictEqual(categoryRemainBar(10000, 4000, past).cls, "");

  const future = pace("2026-12", 2026, 11, 17);
  assert.strictEqual(future.pct, 100);
  const futureFull = categoryRemainBar(10000, 0, future);
  assert.strictEqual(futureFull.pct, 100);
  assert.strictEqual(futureFull.width, 100);
  assert.strictEqual(futureFull.cls, "");
  const futureSpent = categoryRemainBar(10000, 100, future);
  assert.strictEqual(futureSpent.pct, 99);
  assert.strictEqual(futureSpent.cls, "behind");

  const rounded = categoryRemainBar(3, 1, current);
  assert.strictEqual(rounded.pct, 67);
  assert.strictEqual(rounded.width, 67);
  assert.strictEqual(rounded.cls, "");

  assert.strictEqual(categoryRemainBar("", 500, current).pct, null);
  assert.strictEqual(categoryRemainBar(null, 0, null).cls, "");
}

function testClockUsesTokyo() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit"
  });
  const [year, month, day] = fmt.format(new Date()).split("-");
  const today = jstNow();
  assert.strictEqual(today.year, year);
  assert.strictEqual(today.month, month);
  assert.strictEqual(today.day, day);
  const live = monthPace(year + "-" + month, today);
  assert.strictEqual(live.status, "current");
  assert.strictEqual(live.remaining, daysInMonth(year + "-" + month) - Number(day) + 1);
}

function pngInfo(file) {
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.toString("ascii", 1, 4), "PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idats = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === "IDAT") {
      idats.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idats));
  return { width, height, colorType, r: raw[1], g: raw[2], b: raw[3] };
}

function testIconsAndManifest() {
  const root = path.join(__dirname, "..");
  const icon180 = pngInfo(path.join(root, "icon-180.png"));
  const icon192 = pngInfo(path.join(root, "icon-192.png"));
  const icon512 = pngInfo(path.join(root, "icon-512.png"));
  assert.deepStrictEqual([icon180.width, icon180.height], [180, 180]);
  assert.deepStrictEqual([icon192.width, icon192.height], [192, 192]);
  assert.deepStrictEqual([icon512.width, icon512.height], [512, 512]);
  for (const icon of [icon180, icon192, icon512]) {
    assert.strictEqual(icon.colorType, 2);
    assert.deepStrictEqual([icon.r, icon.g, icon.b], [0x1f, 0x6b, 0x4a]);
  }
  const svg = fs.readFileSync(path.join(root, "icon.svg"), "utf8");
  assert.ok(svg.includes('fill="#1F6B4A"'));
  assert.ok(svg.includes("<svg"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
  const purposes = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`);
  assert.ok(purposes.includes("192x192:any"));
  assert.ok(purposes.includes("512x512:any"));
  assert.ok(purposes.includes("192x192:maskable"));
  assert.ok(purposes.includes("512x512:maskable"));
  assert.strictEqual(manifest.theme_color, "#1F6B4A");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.includes('rel="apple-touch-icon" sizes="180x180" href="icon-180.png"'));
  assert.ok(html.includes('name="theme-color" content="#1F6B4A"'));
  const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
  assert.ok(sw.includes('const CACHE = "budget-app-v6"'));
  assert.ok(sw.includes("./icon-180.png"));
  assert.ok(sw.includes("./icon-192.png"));
  assert.ok(sw.includes("./icon-512.png"));
  const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.ok(app.includes('class="record-btn"'));
  assert.ok(app.includes("月末まで残り"));
  assert.ok(app.includes('timeZone: "Asia/Tokyo"'));
  assert.ok(app.includes("categoryRemainBar(b, s, pace)"));
  assert.ok(!app.includes("s / b"));
  assert.ok(html.includes("--shu: #EB6101"));
  assert.ok(html.includes(".cat .bar.behind > i { background: var(--shu); }"));
  const catBlock = app.slice(app.indexOf("catList.innerHTML"), app.indexOf("const exps"));
  assert.ok(catBlock.includes("categoryRemainBar(b, s, pace)"));
  assert.ok(!catBlock.includes("月末まで残り"));
  assert.ok(!catBlock.includes("monthPace"));
}

testMonthLengths();
testIncludesTodayAndRounds();
testLeapDays();
testMonthBoundaries();
testBudgetComparison();
testCategoryRemainBar();
testClockUsesTokyo();
testIconsAndManifest();
console.log("month pace tests passed");
