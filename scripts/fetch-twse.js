import fs from "node:fs/promises";
import path from "node:path";

const TWSE_ENDPOINT = "https://www.twse.com.tw/rwd/zh/afterTrading/TWT53U";
const DATA_FILE = path.resolve("data/odd_history.json");

function getTodayString() {
  // 轉為台北時間 YYYYMMDD
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

async function fetchTWSE(dateStr) {
  const url = `${TWSE_ENDPOINT}?date=${dateStr}&selectType=ALL&response=json`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "application/json, text/plain, */*"
    }
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });

  // 1. 讀取既有資料
  let historyData = {};
  try {
    const raw = await fs.readFile(DATA_FILE, "utf-8");
    historyData = JSON.parse(raw);
  } catch {}

  // 2. 決定要抓取的日期與模式
  const manualDate = (process.env.TARGET_DATE || "").trim();
  const isManual = manualDate.length === 8;
  const targetDate = isManual ? manualDate : getTodayString();

  console.log(`[執行目標] 日期: ${targetDate} (${isManual ? "手動指定重抓" : "例行自動抓取"})`);

  // 3. 自動排程下，如果今天已抓過，直接跳過
  if (!isManual && historyData[targetDate]) {
    console.log(`[略過] ${targetDate} 資料已存在，無需重複抓取。`);
    return;
  }

  // 4. 向證交所發出請求
  console.log(`[抓取中] 正在向證交所請求 ${targetDate}...`);
  const payload = await fetchTWSE(targetDate);

  if (payload.stat !== "OK" || !Array.isArray(payload.data)) {
    console.log(`[無資料] 證交所回應: ${payload.stat || "無交易資料"} (可能為休市、颱風假或尚未更新)`);
    return;
  }

  // 5. 整理個股資料結構
  const codeIdx = payload.fields.indexOf("證券代號");
  const nameIdx = payload.fields.indexOf("證券名稱");
  const priceIdx = payload.fields.indexOf("成交價");
  const volIdx = payload.fields.indexOf("成交股數");
  const bPriceIdx = payload.fields.indexOf("最後揭示買價");
  const bVolIdx = payload.fields.indexOf("最後揭示買量");
  const sPriceIdx = payload.fields.indexOf("最後揭示賣價");
  const sVolIdx = payload.fields.indexOf("最後揭示賣量");

  const stockMap = {};
  for (const row of payload.data) {
    const code = String(row[codeIdx]).trim();
    stockMap[code] = {
      "證券代號": code,
      "證券名稱": row[nameIdx],
      "成交價": row[priceIdx],
      "成交股數": row[volIdx],
      "最後揭示買價": row[bPriceIdx],
      "最後揭示買量": row[bVolIdx],
      "最後揭示賣價": row[sPriceIdx],
      "最後揭示賣量": row[sVolIdx]
    };
  }

  // 覆寫或新增該日資料
  historyData[targetDate] = stockMap;

  // 保留最近 30 天歷史，避免檔案過大
  const sortedDates = Object.keys(historyData).sort().reverse().slice(0, 30);
  const trimmedData = {};
  for (const d of sortedDates) {
    trimmedData[d] = historyData[d];
  }

  await fs.writeFile(DATA_FILE, JSON.stringify(trimmedData), "utf-8");
  console.log(`[完成] 已成功更新 ${targetDate} 資料 (共 ${Object.keys(stockMap).length} 檔證券)。`);
}

main().catch((err) => {
  console.error("[異常錯誤]:", err);
  process.exit(1);
});
