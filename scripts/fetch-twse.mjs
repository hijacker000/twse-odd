import fs from "node:fs/promises";
import path from "node:path";

// 證交所 (TWSE - 上市)
const TWSE_ODD_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/TWT53U";
const TWSE_ROUND_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX";

// 櫃買中心 (TPEx - 上櫃)
const TPEX_ODD_URL = "https://www.tpex.org.tw/www/zh-tw/afterTrading/odd";
const TPEX_ROUND_URL = "https://www.tpex.org.tw/www/zh-tw/afterTrading/otc";

const DATA_FILE = path.resolve("data/odd_history.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getTodayString() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}${m}${d}`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "application/json, text/plain, */*"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// TWSE 漲跌幅計算
function calcTwseChangeRate(closeStr, signStr, diffStr) {
  if (!closeStr || closeStr === "--") return "--";
  const close = parseFloat(closeStr.replace(/,/g, ""));
  const diff = parseFloat((diffStr || "").replace(/,/g, "")) || 0;
  if (isNaN(close) || close <= 0) return "--";

  let sign = 0;
  if ((signStr || "").includes("+")) sign = 1;
  else if ((signStr || "").includes("-")) sign = -1;

  if (sign === 0 || diff === 0) return "0.00%";
  const prevClose = close - sign * diff;
  if (prevClose <= 0) return "--";
  const rate = ((sign * diff) / prevClose) * 100;
  return `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%`;
}

// TPEx 漲跌幅計算 (TPEx 自帶 +/- 符號)
function calcTpexChangeRate(closeStr, changeStr) {
  if (!closeStr || closeStr === "--") return "--";
  const close = parseFloat(closeStr.replace(/,/g, ""));
  const diff = parseFloat((changeStr || "").replace(/,/g, ""));
  if (isNaN(close) || close <= 0 || isNaN(diff)) return "--";
  if (diff === 0) return "0.00%";
  const prevClose = close - diff;
  if (prevClose <= 0) return "--";
  const rate = (diff / prevClose) * 100;
  return `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%`;
}

async function main() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });

  let historyData = {};
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    historyData = JSON.parse(raw);
  } catch {
    await fs.writeFile(DATA_FILE, "{}", "utf-8");
  }

  const manualDate = (process.env.TARGET_DATE || "").trim();
  const isManual = manualDate.length === 8;
  const targetDate = isManual ? manualDate : getTodayString();
  const tpexDate = `${targetDate.slice(0, 4)}/${targetDate.slice(4, 6)}/${targetDate.slice(6, 8)}`;

  console.log(`========================================`);
  console.log(`[執行目標] 日期: ${targetDate} (${isManual ? "手動指定" : "定時排程"})`);

  if (!isManual && historyData[targetDate]) {
    console.log(`[略過] ${targetDate} 資料已存在，無需重複抓取。`);
    return;
  }

  const stockMap = {};

  // ----------------------------------------------------
  // 1. TWSE (上市) - 零股
  // ----------------------------------------------------
  console.log(`[1/4 上市零股] 正在抓取 ${targetDate}...`);
  let twseOddPayload = null;
  try {
    const url = `${TWSE_ODD_URL}?date=${targetDate}&selectType=ALL&response=json`;
    twseOddPayload = await fetchJson(url);
    if (twseOddPayload.stat !== "OK" || !Array.isArray(twseOddPayload.data)) {
      console.log(`[1/4 上市零股] 無資料: ${twseOddPayload.stat || "休市或尚未產出"}`);
    } else {
      console.log(`[1/4 上市零股] 成功取得 ${twseOddPayload.data.length} 檔`);
    }
  } catch (err) {
    console.error(`[1/4 上市零股錯誤]: ${err.message}`);
  }

  await sleep(2500);

  // ----------------------------------------------------
  // 2. TWSE (上市) - 整股
  // ----------------------------------------------------
  console.log(`[2/4 上市整股] 正在抓取 ${targetDate}...`);
  const twseRoundMap = {};
  try {
    const url = `${TWSE_ROUND_URL}?date=${targetDate}&type=ALLBUT0999NOTIND&response=json`;
    const twseRoundPayload = await fetchJson(url);
    const table = twseRoundPayload.tables?.find((t) => t?.title?.includes("每日收盤行情"));

    if (table && Array.isArray(table.data)) {
      const codeIdx = table.fields.indexOf("證券代號");
      const nameIdx = table.fields.indexOf("證券名稱");
      const volIdx = table.fields.indexOf("成交股數");
      const closeIdx = table.fields.indexOf("收盤價");
      const signIdx = table.fields.indexOf("漲跌(+/-)");
      const diffIdx = table.fields.indexOf("漲跌價差");

      for (const r of table.data) {
        const code = String(r[codeIdx]).trim();
        twseRoundMap[code] = {
          name: r[nameIdx],
          close: r[closeIdx],
          changeRate: calcTwseChangeRate(r[closeIdx], r[signIdx], r[diffIdx]),
          volume: r[volIdx]
        };
      }
      console.log(`[2/4 上市整股] 成功取得 ${Object.keys(twseRoundMap).length} 檔`);
    }
  } catch (err) {
    console.warn(`[2/4 上市整股警告]: ${err.message}`);
  }

  // 合併上市資料
  if (twseOddPayload?.stat === "OK" && Array.isArray(twseOddPayload.data)) {
    const codeIdx = twseOddPayload.fields.indexOf("證券代號");
    const nameIdx = twseOddPayload.fields.indexOf("證券名稱");
    const priceIdx = twseOddPayload.fields.indexOf("成交價");
    const volIdx = twseOddPayload.fields.indexOf("成交股數");
    const bPriceIdx = twseOddPayload.fields.indexOf("最後揭示買價");
    const bVolIdx = twseOddPayload.fields.indexOf("最後揭示買量");
    const sPriceIdx = twseOddPayload.fields.indexOf("最後揭示賣價");
    const sVolIdx = twseOddPayload.fields.indexOf("最後揭示賣量");

    for (const r of twseOddPayload.data) {
      const code = String(r[codeIdx]).trim();
      const round = twseRoundMap[code] || { close: "--", changeRate: "--", volume: "--" };
      stockMap[code] = {
        name: r[nameIdx],
        odd: {
          price: r[priceIdx],
          volume: r[volIdx],
          bidPrice: r[bPriceIdx],
          bidVol: r[bVolIdx],
          askPrice: r[sPriceIdx],
          askVol: r[sVolIdx]
        },
        round: {
          close: round.close,
          changeRate: round.changeRate,
          volume: round.volume
        }
      };
    }
  }

  await sleep(2500);

  // ----------------------------------------------------
  // 3. TPEx (上櫃) - 零股
  // ----------------------------------------------------
  console.log(`[3/4 上櫃零股] 正在抓取 ${tpexDate}...`);
  let tpexOddData = [];
  let tpexOddFields = [];
  try {
    const url = `${TPEX_ODD_URL}?type=Daily&date=${encodeURIComponent(tpexDate)}&id=&response=json`;
    const payload = await fetchJson(url);
    const table = payload.tables?.[0];
    if (table && Array.isArray(table.data) && table.data.length > 0) {
      tpexOddData = table.data;
      tpexOddFields = table.fields.map((f) => f.trim());
      console.log(`[3/4 上櫃零股] 成功取得 ${tpexOddData.length} 檔`);
    } else {
      console.log(`[3/4 上櫃零股] 查無資料`);
    }
  } catch (err) {
    console.error(`[3/4 上櫃零股錯誤]: ${err.message}`);
  }

  await sleep(2500);

  // ----------------------------------------------------
  // 4. TPEx (上櫃) - 整股
  // ----------------------------------------------------
  console.log(`[4/4 上櫃整股] 正在抓取 ${tpexDate}...`);
  const tpexRoundMap = {};
  try {
    const url = `${TPEX_ROUND_URL}?date=${encodeURIComponent(tpexDate)}&type=EW&id=&response=json`;
    const payload = await fetchJson(url);
    const table = payload.tables?.[0];

    if (table && Array.isArray(table.data)) {
      const fields = table.fields.map((f) => f.replace(/<[^>]*>/g, "").trim());
      const codeIdx = fields.indexOf("代號");
      const nameIdx = fields.indexOf("名稱");
      const closeIdx = fields.indexOf("收盤");
      const changeIdx = fields.indexOf("漲跌");
      const volIdx = fields.indexOf("成交股數");

      for (const r of table.data) {
        const code = String(r[codeIdx]).trim();
        tpexRoundMap[code] = {
          name: r[nameIdx],
          close: r[closeIdx],
          changeRate: calcTpexChangeRate(r[closeIdx], r[changeIdx]),
          volume: r[volIdx]
        };
      }
      console.log(`[4/4 上櫃整股] 成功取得 ${Object.keys(tpexRoundMap).length} 檔`);
    }
  } catch (err) {
    console.warn(`[4/4 上櫃整股警告]: ${err.message}`);
  }

  // 合併上櫃資料
  if (tpexOddData.length > 0) {
    const codeIdx = tpexOddFields.indexOf("代號");
    const nameIdx = tpexOddFields.indexOf("名稱");
    const volIdx = tpexOddFields.indexOf("成交股數");
    const priceIdx = tpexOddFields.indexOf("成交價格(元)");
    const bPriceIdx = tpexOddFields.indexOf("未成交買價");
    const bVolIdx = tpexOddFields.indexOf("未成交買量");
    const sPriceIdx = tpexOddFields.indexOf("未成交賣價");
    const sVolIdx = tpexOddFields.indexOf("未成交賣量");

    for (const r of tpexOddData) {
      const code = String(r[codeIdx]).trim();
      const round = tpexRoundMap[code] || { close: "--", changeRate: "--", volume: "--" };
      stockMap[code] = {
        name: r[nameIdx],
        odd: {
          price: r[priceIdx],
          volume: r[volIdx],
          bidPrice: r[bPriceIdx],
          bidVol: r[bVolIdx],
          askPrice: r[sPriceIdx],
          askVol: r[sVolIdx]
        },
        round: {
          close: round.close,
          changeRate: round.changeRate,
          volume: round.volume
        }
      };
    }
  }

  // ----------------------------------------------------
  // 5. 寫入儲存
  // ----------------------------------------------------
  const totalStocks = Object.keys(stockMap).length;
  if (totalStocks === 0) {
    console.log(`[略過] ${targetDate} 今日無任何上市櫃交易資料（可能為休市）。`);
    return;
  }

  historyData[targetDate] = stockMap;

  // 保留最近 30 天
  const sortedDates = Object.keys(historyData).sort().reverse().slice(0, 30);
  const trimmed = {};
  for (const d of sortedDates) trimmed[d] = historyData[d];

  await fs.writeFile(DATA_FILE, JSON.stringify(trimmed), "utf-8");
  console.log(`[完成] 已成功儲存 ${targetDate} (上市 + 上櫃共 ${totalStocks} 檔證券)`);
  console.log(`========================================`);
}

main().catch((err) => {
  console.error("[腳本異常終止]:", err);
  process.exit(1);
});
