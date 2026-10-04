import fs from "node:fs/promises";
import path from "node:path";

const TWSE_ODD_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/TWT53U";
const TWSE_ROUND_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX";
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
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json, text/plain, */*"
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function calcChangeRate(closeStr, signStr, diffStr) {
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

  console.log(`========================================`);
  console.log(`[執行目標] 日期: ${targetDate} (${isManual ? "手動指定" : "定時排程"})`);

  if (!isManual && historyData[targetDate]) {
    console.log(`[略過] ${targetDate} 資料已存在，無需重複抓取。`);
    return;
  }

  // 步驟 1: 抓取盤後零股 (TWT53U)
  console.log(`[1/2 零股] 正在抓取 ${targetDate}...`);
  let oddPayload = null;
  try {
    const oddUrl = `${TWSE_ODD_URL}?date=${targetDate}&selectType=ALL&response=json`;
    oddPayload = await fetchJson(oddUrl);
    if (oddPayload.stat !== "OK" || !Array.isArray(oddPayload.data)) {
      console.log(`[1/2 零股] 無資料: ${oddPayload.stat || "休市或尚未產出"}`);
      return;
    }
    console.log(`[1/2 零股] 成功取得，共 ${oddPayload.data.length} 筆資料`);
  } catch (err) {
    console.error(`[1/2 零股錯誤]: ${err.message}`);
    return;
  }

  await sleep(3000); // 禮貌性延遲 3 秒避免 429 限制

  // 步驟 2: 抓取整股收盤行情 (MI_INDEX)
  console.log(`[2/2 整股] 正在抓取 ${targetDate}...`);
  const roundMap = {};
  try {
    const roundUrl = `${TWSE_ROUND_URL}?date=${targetDate}&type=ALLBUT0999NOTIND&response=json`;
    const roundPayload = await fetchJson(roundUrl);
    const roundTable = roundPayload.tables?.find(
      (t) => t && t.title && t.title.includes("每日收盤行情")
    );

    if (roundTable && Array.isArray(roundTable.data)) {
      const rCodeIdx = roundTable.fields.indexOf("證券代號");
      const rNameIdx = roundTable.fields.indexOf("證券名稱");
      const rVolIdx = roundTable.fields.indexOf("成交股數");
      const rCloseIdx = roundTable.fields.indexOf("收盤價");
      const rSignIdx = roundTable.fields.indexOf("漲跌(+/-)");
      const rDiffIdx = roundTable.fields.indexOf("漲跌價差");

      for (const r of roundTable.data) {
        const code = String(r[rCodeIdx]).trim();
        roundMap[code] = {
          name: r[rNameIdx],
          close: r[rCloseIdx],
          changeRate: calcChangeRate(r[rCloseIdx], r[rSignIdx], r[rDiffIdx]),
          volume: r[rVolIdx]
        };
      }
      console.log(`[2/2 整股] 成功取得，共 ${Object.keys(roundMap).length} 筆資料`);
    } else {
      console.log(`[2/2 整股] 查無收盤行情表: ${roundPayload.stat || "無資料"}`);
    }
  } catch (err) {
    console.warn(`[2/2 整股警告]: ${err.message} (將僅儲存零股資料)`);
  }

  // 步驟 3: 合併資料
  const codeIdx = oddPayload.fields.indexOf("證券代號");
  const nameIdx = oddPayload.fields.indexOf("證券名稱");
  const priceIdx = oddPayload.fields.indexOf("成交價");
  const volIdx = oddPayload.fields.indexOf("成交股數");
  const bPriceIdx = oddPayload.fields.indexOf("最後揭示買價");
  const bVolIdx = oddPayload.fields.indexOf("最後揭示買量");
  const sPriceIdx = oddPayload.fields.indexOf("最後揭示賣價");
  const sVolIdx = oddPayload.fields.indexOf("最後揭示賣量");

  const stockMap = {};
  for (const row of oddPayload.data) {
    const code = String(row[codeIdx]).trim();
    const roundInfo = roundMap[code] || { close: "--", changeRate: "--", volume: "--" };

    stockMap[code] = {
      name: row[nameIdx],
      odd: {
        price: row[priceIdx],
        volume: row[volIdx],
        bidPrice: row[bPriceIdx],
        bidVol: row[bVolIdx],
        askPrice: row[sPriceIdx],
        askVol: row[sVolIdx]
      },
      round: {
        close: roundInfo.close,
        changeRate: roundInfo.changeRate,
        volume: roundInfo.volume
      }
    };
  }

  historyData[targetDate] = stockMap;

  // 保留最近 30 天歷史
  const sortedDates = Object.keys(historyData).sort().reverse().slice(0, 30);
  const trimmed = {};
  for (const d of sortedDates) trimmed[d] = historyData[d];

  await fs.writeFile(DATA_FILE, JSON.stringify(trimmed), "utf-8");
  console.log(`[完成] 已成功儲存 ${targetDate} (共 ${Object.keys(stockMap).length} 檔)`);
  console.log(`========================================`);
}

main().catch((err) => {
  console.error("[腳本異常終止]:", err);
  process.exit(1);
});
