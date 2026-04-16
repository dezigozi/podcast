// ===== フィルタリング =====
export function filterRows(rows, { leaseCompany, startMonth, endMonth }) {
  return rows.filter(row => {
    if (leaseCompany && leaseCompany !== 'ALL') {
      if (row.leaseCompany !== leaseCompany) return false;
    }
    if (startMonth && endMonth && row.month) {
      const sm = parseInt(startMonth), em = parseInt(endMonth), m = row.month;
      if (sm <= em) { if (m < sm || m > em) return false; }
      else { if (m < sm && m > em) return false; }
    }
    return true;
  });
}

// ===== 集計ヘルパー =====
function makeMap(keys) {
  const m = {};
  keys.forEach(k => { m[k] = 0; });
  return m;
}

function sortByLatest(arr, years) {
  const ly = years[years.length - 1];
  return arr.sort((a, b) => (b.sales[ly] || 0) - (a.sales[ly] || 0));
}

function buildAgg(rows, years, keyFn, extraFn) {
  const map = {};
  rows.forEach(row => {
    const key = keyFn(row);
    if (!map[key]) {
      map[key] = { name: key, sales: makeMap(years), profit: makeMap(years), ...((extraFn && extraFn(row)) || {}) };
    }
    if (row.fiscalYear && years.includes(row.fiscalYear)) {
      map[key].sales[row.fiscalYear] += row.sales || 0;
      map[key].profit[row.fiscalYear] += row.profit || 0;
    }
  });
  return sortByLatest(Object.values(map), years);
}

function buildAggWithQty(rows, years, keyFn) {
  const map = {};
  rows.forEach(row => {
    const key = keyFn(row);
    if (!map[key]) {
      map[key] = { name: key, productName: '', sales: makeMap(years), profit: makeMap(years), quantity: makeMap(years) };
    }
    if (row.productName && !map[key].productName) map[key].productName = row.productName;
    if (row.fiscalYear && years.includes(row.fiscalYear)) {
      map[key].sales[row.fiscalYear] += row.sales || 0;
      map[key].profit[row.fiscalYear] += row.profit || 0;
      map[key].quantity[row.fiscalYear] += row.quantity || 0;
    }
  });
  return sortByLatest(Object.values(map), years);
}

// ===== 第1階層: 部店別 =====
export function aggregateByBranch(rows, years) {
  return buildAgg(rows, years, r => r.branch || '(未分類)');
}

// ===== 第2階層: 注文者別（部店内） =====
export function aggregateByOrderer(rows, years, branchName) {
  return buildAgg(rows.filter(r => r.branch === branchName), years, r => r.ordererName || '(未分類)');
}

// ===== 第3階層: 顧客別（部店+注文者内） =====
export function aggregateByCustomer(rows, years, branchName, ordererName) {
  return buildAgg(rows.filter(r => r.branch === branchName && r.ordererName === ordererName), years, r => r.customerName || '(未分類)');
}

// ===== 部店→顧客 第2階層 =====
export function aggregateByCustomerInBranch(rows, years, branchName) {
  return buildAgg(rows.filter(r => r.branch === branchName), years, r => r.customerName || '(未分類)');
}

// ===== 部店→顧客→担当者 第3階層 =====
export function aggregateByOrdererForCustomer(rows, years, branchName, customerName) {
  return buildAgg(rows.filter(r => r.branch === branchName && r.customerName === customerName), years, r => r.ordererName || '(未分類)');
}

// ===== 第4階層: 品番別 =====
export function aggregateByProductByYear(rows, years, branchName, secondName, thirdName, hierarchyOrder) {
  const filtered = rows.filter(r => {
    if (r.branch !== branchName) return false;
    return hierarchyOrder === 'orderer_first'
      ? r.ordererName === secondName && r.customerName === thirdName
      : r.customerName === secondName && r.ordererName === thirdName;
  });
  return buildAggWithQty(filtered, years, r => r.productCode || '(品番なし)');
}

// ===== 担当者別品番（全顧客合算） =====
export function aggregateByProductForOrderer(rows, years, branchName, ordererName) {
  return buildAggWithQty(rows.filter(r => r.branch === branchName && r.ordererName === ordererName), years, r => r.productCode || '(品番なし)');
}

// ===== 顧客別品番（全担当者合算） =====
export function aggregateByProductForCustomer(rows, years, branchName, customerName) {
  return buildAggWithQty(rows.filter(r => r.branch === branchName && r.customerName === customerName), years, r => r.productCode || '(品番なし)');
}

// ===== 部店全体の品番 =====
export function aggregateByProductInBranch(rows, years, branchName) {
  return buildAggWithQty(rows.filter(r => r.branch === branchName), years, r => r.productCode || '(品番なし)');
}

// ===== ピボットデータ =====
export function generatePivotData(rows, years) {
  const map = {};
  rows.forEach(row => {
    const key = [row.leaseCompany, row.branch, row.ordererName, row.customerName].join('||');
    if (!map[key]) {
      map[key] = { lease: row.leaseCompany || '', branch: row.branch || '', orderer: row.ordererName || '', customer: row.customerName || '', sales: makeMap(years), profit: makeMap(years) };
    }
    if (row.fiscalYear && years.includes(row.fiscalYear)) {
      map[key].sales[row.fiscalYear] += row.sales || 0;
      map[key].profit[row.fiscalYear] += row.profit || 0;
    }
  });
  return Object.values(map).sort((a, b) => {
    if (a.lease !== b.lease) return a.lease.localeCompare(b.lease);
    if (a.branch !== b.branch) return a.branch.localeCompare(b.branch);
    if (a.orderer !== b.orderer) return a.orderer.localeCompare(b.orderer);
    return a.customer.localeCompare(b.customer);
  });
}

// ===== 明細CSV生成 =====
export function generateDetailCsvContent(rows) {
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const headers = ['リース会社', '部店', '注文者名', '顧客名', '品番', '品番名', '日付', '売上', '粗利', '数量'];
  const lines = [headers.map(q).join(',')];
  rows.forEach(row => {
    lines.push([q(row.leaseCompany ?? ''), q(row.branch ?? ''), q(row.ordererName ?? ''), q(row.customerName ?? ''), q(row.productCode ?? ''), q(row.productName ?? ''), q(row.date ?? ''), row.sales ?? 0, row.profit ?? 0, row.quantity ?? 0].join(','));
  });
  return lines.join('\r\n');
}

// ===== ユーティリティ =====
export function calcYoY(curr, prev) {
  if (!prev || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev) * 100).toFixed(1);
}

export function calcMargin(profit, sales) {
  if (!sales || sales === 0) return '0.0';
  return ((profit / sales) * 100).toFixed(1);
}

export function formatCurrency(val) {
  if (!val) return '\u00a50';
  const abs = Math.abs(val);
  if (abs >= 100000000) return '\u00a5' + (val / 100000000).toFixed(1) + '\u5104';
  if (abs >= 10000) return '\u00a5' + (val / 10000).toFixed(0) + '\u4e07';
  return '\u00a5' + val.toLocaleString();
}

export function formatCurrencyFull(val) {
  if (!val) return '\u00a50';
  return '\u00a5' + Math.round(val).toLocaleString();
}

// ===== 顧客検索（半角全角対応） =====
const HANKATA_MAP = new Map([
  ['\uff66', '\u30f2'], ['\uff67', '\u30a1'], ['\uff68', '\u30a3'], ['\uff69', '\u30a5'], ['\uff6a', '\u30a7'],
  ['\uff6b', '\u30a9'], ['\uff6c', '\u30e3'], ['\uff6d', '\u30e5'], ['\uff6e', '\u30e7'], ['\uff6f', '\u30c3'],
  ['\uff70', '\u30fc'], ['\uff71', '\u30a2'], ['\uff72', '\u30a4'], ['\uff73', '\u30a6'], ['\uff74', '\u30a8'],
  ['\uff75', '\u30aa'], ['\uff76', '\u30ab'], ['\uff77', '\u30ad'], ['\uff78', '\u30af'], ['\uff79', '\u30b1'],
  ['\uff7a', '\u30b3'], ['\uff7b', '\u30b5'], ['\uff7c', '\u30b7'], ['\uff7d', '\u30b9'], ['\uff7e', '\u30bb'],
  ['\uff7f', '\u30bd'], ['\uff80', '\u30bf'], ['\uff81', '\u30c1'], ['\uff82', '\u30c4'], ['\uff83', '\u30c6'],
  ['\uff84', '\u30c8'], ['\uff85', '\u30ca'], ['\uff86', '\u30cb'], ['\uff87', '\u30cc'], ['\uff88', '\u30cd'],
  ['\uff89', '\u30ce'], ['\uff8a', '\u30cf'], ['\uff8b', '\u30d2'], ['\uff8c', '\u30d5'], ['\uff8d', '\u30d8'],
  ['\uff8e', '\u30db'], ['\uff8f', '\u30de'], ['\uff90', '\u30df'], ['\uff91', '\u30e0'], ['\uff92', '\u30e1'],
  ['\uff93', '\u30e2'], ['\uff94', '\u30e4'], ['\uff95', '\u30e6'], ['\uff96', '\u30e8'], ['\uff97', '\u30e9'],
  ['\uff98', '\u30ea'], ['\uff99', '\u30eb'], ['\uff9a', '\u30ec'], ['\uff9b', '\u30ed'], ['\uff9c', '\u30ef'],
  ['\uff9d', '\u30f3']
]);

function normalizeJapanese(str) {
  return str
    .replace(/[\uff61-\uff9f]/g, ch => HANKATA_MAP.get(ch) || ch)
    .replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
    .toLowerCase();
}

export function searchCustomers(rows, query) {
  if (!query || !query.trim()) return [];
  const norm = normalizeJapanese(query.trim());
  const seen = new Set();
  const results = [];
  for (const row of rows) {
    if (!row.customerName) continue;
    if (!normalizeJapanese(row.customerName).includes(norm)) continue;
    const key = row.customerName + '||' + row.branch + '||' + row.leaseCompany;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ customerName: row.customerName, branchName: row.branch || '', leaseCompany: row.leaseCompany || '' });
  }
  return results;
}

// ===== 表示幅計算 =====
export function truncateByDisplayWidth(str, maxUnits) {
  if (!str) return '';
  let units = 0, out = '';
  for (const ch of str) {
    const c = ch.codePointAt(0);
    const u = (c <= 0x007e || (c >= 0xff61 && c <= 0xff9f)) ? 0.5 : 1;
    if (units + u > maxUnits) break;
    out += ch; units += u;
  }
  return out;
}
