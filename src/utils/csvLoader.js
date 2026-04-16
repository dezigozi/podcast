export async function loadCsvData() {
  const response = await fetch('./public/data/master_data.csv');
  if (!response.ok) throw new Error('CSV ' + response.status);
  return parseCsv(await response.text());
}

function parseCsv(csv) {
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (!lines.length) throw new Error('CSV empty');
  const headers = parseLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = parseLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => {
      const v = vals[idx]?.trim() || '';
      const n = Number(v);
      row[h] = isNaN(n) || v === '' ? v : n;
    });
    if (row.date && !row.fiscalYear) {
      const d = parseDate(row.date);
      if (d) { row.fiscalYear = d.fiscalYear; row.month = d.month; }
    }
    rows.push(row);
  }

  const yearsSet = new Set(), leaseSet = new Set();
  rows.forEach(r => {
    if (r.fiscalYear) yearsSet.add(Number(r.fiscalYear));
    if (r.leaseCompany) leaseSet.add(r.leaseCompany);
  });

  return {
    rows,
    years: Array.from(yearsSet).sort((a, b) => a - b),
    leaseCompanies: Array.from(leaseSet).sort(),
  };
}

function parseDate(val) {
  if (typeof val === 'string') {
    const parts = val.split(' ')[0].split(/[-\/]/).map(Number);
    if (parts.length === 3) {
      const [y, m] = parts;
      if (y > 1900 && m >= 1 && m <= 12) {
        return { fiscalYear: m >= 4 ? y : y - 1, month: m };
      }
    }
  }
  if (typeof val === 'number' && val > 0) {
    const d = new Date(new Date(1900, 0, -1).getTime() + val * 86400000);
    const m = d.getMonth() + 1;
    return { fiscalYear: m >= 4 ? d.getFullYear() : d.getFullYear() - 1, month: m };
  }
  return null;
}

function parseLine(line) {
  const result = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (c === ',' && !inQ) {
      result.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}
