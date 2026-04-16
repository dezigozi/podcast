import { h, render } from 'https://esm.sh/preact@10.24.3';
import { useState, useMemo, useCallback, useEffect, useRef } from 'https://esm.sh/preact@10.24.3/hooks';
import { html } from 'https://esm.sh/htm@3.1.1/preact';

import { getCache, setCache, clearCache } from './utils/db.js';
import { loadCsvData } from './utils/csvLoader.js';
import {
  filterRows, aggregateByBranch, aggregateByOrderer, aggregateByCustomer,
  aggregateByCustomerInBranch, aggregateByOrdererForCustomer,
  aggregateByProductByYear, aggregateByProductForCustomer, aggregateByProductForOrderer,
  aggregateByProductInBranch, searchCustomers,
  generatePivotData, calcYoY, calcMargin, formatCurrency, formatCurrencyFull,
  generateDetailCsvContent, truncateByDisplayWidth,
} from './utils/aggregator.js';

// 環境設定（index.htmlの<meta>タグから取得 or 空）
const GAS_URL = document.querySelector('meta[name="gas-url"]')?.content || '';
const PASSWORD = document.querySelector('meta[name="app-password"]')?.content || '';
const CACHE_KEY = 'kasouhin_uriage_data_v1';

// ===== アイコン（SVG インライン） =====
const Icon = ({ name, size = 20, cls = '' }) => {
  const icons = {
    database: 'M12 3C7.03 3 3 4.34 3 6v12c0 1.66 4.03 3 9 3s9-1.34 9-3V6c0-1.66-4.03-3-9-3zm0 2c3.87 0 7 .9 7 1s-3.13 1-7 1-7-.9-7-1 3.13-1 7-1zm0 14c-3.87 0-7-.9-7-1V8.5c1.47.8 4.07 1.5 7 1.5s5.53-.7 7-1.5V18c0 .1-3.13 1-7 1z',
    refresh: 'M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    building: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    user: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    store: 'M20 4H4v2l8 5 8-5V4zM4 11v7h7v-5h2v5h7v-7l-8 5-8-5z',
    package: 'M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z',
    chevron: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    x: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
    search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
    eyeoff: 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.804 11.804 0 001 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z',
    arrowup: 'M7 14l5-5 5 5z',
    arrowdown: 'M7 10l5 5 5-5z',
    calendar: 'M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13z',
    file: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    filetext: 'M14 17H4v2h10v-2zm6-8H4v2h16V9zM4 15h16v-2H4v2zM4 5v2h16V5H4z',
    settings: 'M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z',
    alert: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
    loader: 'M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z',
    xcircle: 'M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z',
    checksquare: 'M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
    square: 'M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm0 16H5V5h14v14z',
    externallink: 'M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
    listfilter: 'M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z',
    checkcircle: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
    layout: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  };
  const d = icons[name] || '';
  return html`<svg xmlns="http://www.w3.org/2000/svg" width=${size} height=${size} viewBox="0 0 24 24" fill="currentColor" class=${cls}><path d=${d}/></svg>`;
};

// ===== ユーティリティ =====
const fmtAmtFn = (val, unit) => unit === 'thousand'
  ? ('\u00a5' + Math.round((val || 0) / 1000).toLocaleString())
  : formatCurrencyFull(val);

const fmtAmtShortFn = (val, unit) => unit === 'thousand'
  ? (() => { const v = (val || 0) / 1000; return Math.abs(v) >= 100000 ? '\u00a5' + (v / 10000).toFixed(0) + '\u4e07' : '\u00a5' + Math.round(v).toLocaleString(); })()
  : formatCurrency(val);

// ===== ConnectionBadge =====
const ConnectionBadge = ({ status }) => {
  const map = {
    idle:    ['bg-slate-100 text-slate-500 border-slate-200', 'Standby', 'checkcircle'],
    loading: ['bg-amber-50 text-amber-600 border-amber-100', 'Loading...', 'loader'],
    online:  ['bg-blue-50 text-blue-600 border-blue-100', 'Live Sync', 'checkcircle'],
    offline: ['bg-rose-50 text-rose-600 border-rose-100', 'Offline', 'alert'],
  };
  const [cls, label, icon] = map[status] || map.idle;
  return html`<div class=${'flex items-center gap-1.5 px-4 py-1.5 rounded-full text-[10px] font-black uppercase border shadow-sm ' + cls}><${Icon} name=${icon} size=${12} /> ${label}</div>`;
};

// ===== LoadingScreen =====
const LoadingScreen = () => html`
  <div class="flex flex-col items-center justify-center h-96 animate-fade-in">
    <div class="relative mb-8">
      <div class="w-20 h-20 border-4 border-slate-200 rounded-full" />
      <div class="absolute top-0 left-0 w-20 h-20 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-blue-500"><${Icon} name="database" size=${28} /></div>
    </div>
    <h3 class="text-xl font-black text-slate-700 mb-2">\u30c7\u30fc\u30bf\u3092\u8aad\u307f\u8fbc\u3093\u3067\u3044\u307e\u3059</h3>
    <p class="text-sm text-slate-400 font-bold">CSV\u30c7\u30fc\u30bf\u3092\u540c\u671f\u4e2d...</p>
    <div class="flex gap-1 mt-6">${[0,1,2].map(i => html`<div key=${i} class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style=${'animation-delay:' + (i*0.15) + 's'} />`)}</div>
  </div>
`;

// ===== SettingsModal =====
const SettingsModal = ({ gasUrl, onClose, onRefresh }) => html`
  <div class="fixed inset-0 bg-slate-900/60 backdrop-blur-md z-50 flex items-center justify-center p-4 animate-fade-in">
    <div class="bg-white rounded-[3rem] w-full max-w-xl shadow-2xl overflow-hidden">
      <div class="p-10 border-b border-slate-50 bg-slate-50/50 flex justify-between items-center">
        <div>
          <h3 class="text-2xl font-black text-slate-800">\u30c7\u30fc\u30bf\u30bd\u30fc\u30b9\u8a2d\u5b9a</h3>
          <p class="text-[10px] text-slate-400 font-black uppercase mt-1 tracking-widest">GAS Configuration</p>
        </div>
        <button onClick=${onClose} class="w-10 h-10 rounded-full bg-white shadow-sm flex items-center justify-center text-slate-400 hover:text-slate-600"><${Icon} name="xcircle" size=${20} /></button>
      </div>
      <div class="p-10 space-y-6">
        <div class="p-5 bg-slate-50 rounded-3xl border border-slate-100 space-y-3">
          <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest">\u73fe\u5728\u306e GAS URL</label>
          <div class=${'text-sm font-bold px-4 py-3 rounded-2xl ' + (gasUrl ? 'bg-blue-50 text-blue-700 border border-blue-100' : 'bg-amber-50 text-amber-700 border border-amber-100')}>
            ${gasUrl || '\u672a\u8a2d\u5b9a\uff08CSV\u30e2\u30fc\u30c9\uff09'}
          </div>
        </div>
      </div>
      <div class="p-10 pt-0">
        <button onClick=${onRefresh} class="w-full bg-slate-900 text-white py-5 rounded-[1.5rem] font-black shadow-2xl active:scale-[0.98] transition-all flex items-center justify-center gap-2 hover:bg-blue-600">
          <${Icon} name="refresh" size=${18} /> \u30ad\u30e3\u30c3\u30b7\u30e5\u3092\u30af\u30ea\u30a2\u3057\u3066\u518d\u8aad\u8fbc
        </button>
      </div>
    </div>
  </div>
`;

// ===== DashboardView (テーブル部分) =====
const DataTable = ({ data, years, totalRow, activeView, isLeafLevel, isProductMode, isCustomerSearchMode, checkedItems, onCheck, onDrillDown, levelInfo, showProfit, fmtAmt, amountUnit, onShowProducts }) => {
  const isProductLevel = isLeafLevel || isProductMode;
  return html`
  <div class="bg-white rounded-3xl md:rounded-[3rem] shadow-sm border border-slate-100 overflow-hidden">
    <div class="p-4 md:p-8 border-b border-slate-50 flex flex-col md:flex-row md:justify-between md:items-center gap-3 bg-slate-50/30">
      <h3 class="font-black text-slate-800 text-base md:text-xl flex items-center gap-2 flex-wrap">
        <${Icon} name="package" size=${20} cls="text-blue-500 flex-shrink-0" />
        <span>${isCustomerSearchMode ? (activeView.secondName + ' \u54c1\u756a\u5225\u5b9f\u7e3e\uff08\u5168\u62c5\u5f53\u8005\u5408\u7b97\uff09') : levelInfo.title}</span>
      </h3>
      <div class="flex items-center gap-2 text-xs font-bold text-slate-400">
        <${Icon} name="calendar" size=${14} /> ${new Date().toLocaleDateString('ja-JP', { year:'numeric',month:'2-digit',day:'2-digit' })}
      </div>
    </div>
    <div class="overflow-x-auto custom-scrollbar">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-slate-900 text-sm md:text-xl font-black text-white tracking-wide text-center">
            <th class="px-1 md:px-2 py-3 md:py-4 w-10 md:w-12 text-center">\u9078\u629e</th>
            <th class="px-3 md:px-8 py-3 md:py-4 min-w-[140px] md:min-w-[200px] text-center">
              ${isCustomerSearchMode || isProductMode ? '\u54c1\u756a' : levelInfo.label}
              ${amountUnit === 'thousand' ? html`<span class="ml-1 text-amber-400 normal-case tracking-normal text-[10px]">\uff08\u5343\u5186\uff09</span>` : ''}
            </th>
            ${years.map(y => html`<th key=${y} class="px-2 md:px-6 py-3 md:py-4 text-center border-l border-slate-800 min-w-[120px] md:min-w-[auto]">${y}\u5e74\u5ea6</th>`)}
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100">
          ${totalRow && html`
          <tr class="bg-blue-50/50 border-b-2 border-blue-200">
            <td class="px-1 md:px-2 py-4 text-center">\u2014</td>
            <td class="px-3 md:px-8 py-4"><div class="font-black text-blue-700 text-sm md:text-lg">${totalRow.name}</div></td>
            ${years.map((y, yi) => {
              const s = totalRow.sales[y]||0, p = totalRow.profit[y]||0, q = totalRow.quantity?.[y]||0;
              const yoy = years[yi-1] ? calcYoY(s, totalRow.sales[years[yi-1]]) : null;
              const qoy = years[yi-1] ? calcYoY(q, totalRow.quantity?.[years[yi-1]]) : null;
              return html`<td key=${y} class="px-2 md:px-6 py-4 border-l border-blue-200">
                <div class="space-y-2">
                  ${isProductLevel ? html`
                    <div class="flex justify-between items-baseline">
                      <span class="text-[10px] font-black text-blue-500">\u6570\u91cf</span>
                      <div class="text-right">
                        <div class="font-mono font-black text-blue-800 text-xs md:text-base">${q.toLocaleString()}</div>
                        ${qoy !== null && html`<div class=${'text-[10px] font-black flex items-center justify-end gap-0.5 ' + (parseFloat(qoy)>=0?'text-emerald-500':'text-rose-500')}>${parseFloat(qoy)>=0?'\u25b2':'\u25bc'}${qoy}%</div>`}
                      </div>
                    </div>
                  ` : html`
                    <div class="flex justify-between items-baseline">
                      <span class="text-[10px] font-black text-blue-500">\u58f2\u4e0a</span>
                      <div class="text-right">
                        <div class="font-mono font-black text-blue-800 text-xs md:text-base">${fmtAmt(s)}</div>
                        ${yoy !== null && html`<div class=${'text-[10px] font-black flex items-center justify-end gap-0.5 ' + (parseFloat(yoy)>=0?'text-emerald-500':'text-rose-500')}>${parseFloat(yoy)>=0?'\u25b2':'\u25bc'}${yoy}%</div>`}
                      </div>
                    </div>
                    ${showProfit && html`
                      <div class="flex justify-between items-baseline">
                        <span class="text-[10px] font-black text-blue-500">\u7c97\u5229</span>
                        <div class="text-right">
                          <div class="font-mono font-black text-emerald-600 text-xs md:text-base">${fmtAmt(p)}</div>
                          <div class="px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded text-[10px] font-black mt-0.5 w-fit ml-auto border border-emerald-100">${calcMargin(p,s)}%</div>
                        </div>
                      </div>
                    `}
                  `}
                </div>
              </td>`;
            })}
          </tr>`}
          ${data.length === 0
            ? html`<tr><td colSpan=${years.length+2} class="px-4 py-12 text-center text-slate-300 italic">\u8a72\u5f53\u3059\u308b\u30c7\u30fc\u30bf\u304c\u3042\u308a\u307e\u305b\u3093</td></tr>`
            : data.map((item, idx) => {
              const checked = checkedItems.has(item.name);
              return html`<tr key=${idx} class=${'group hover:bg-blue-50/30 transition-all ' + (!isLeafLevel && !isCustomerSearchMode ? 'cursor-pointer' : '')} onClick=${() => !isLeafLevel && !isCustomerSearchMode && onDrillDown(item)}>
                <td class="px-1 md:px-2 py-4 w-10 md:w-12 align-middle text-center" onClick=${e => e.stopPropagation()}>
                  <button type="button" onClick=${() => onCheck(item.name)} class="p-1 rounded hover:bg-slate-200 text-slate-500 hover:text-blue-600 transition-colors">
                    <${Icon} name=${checked ? 'checksquare' : 'square'} size=${16} cls=${checked ? 'text-emerald-600' : 'text-slate-300'} />
                  </button>
                </td>
                <td class="px-3 md:px-8 py-4">
                  <div class="font-black text-slate-800 text-sm md:text-lg group-hover:text-blue-600 transition-colors flex items-center gap-2">
                    ${item.name}
                    ${!isLeafLevel && !isCustomerSearchMode && !isProductMode && html`
                      <button onClick=${e => { e.stopPropagation(); onShowProducts(item); }} class="flex items-center gap-1 px-3 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg text-xs font-black transition-colors no-print">
                        <${Icon} name="package" size=${12} /> \u54c1\u756a
                      </button>
                    `}
                    ${!isLeafLevel && !isCustomerSearchMode && !isProductMode && html`<${Icon} name="chevron" size=${14} cls="opacity-0 group-hover:opacity-100 transition-all" />`}
                  </div>
                  ${(isLeafLevel || isCustomerSearchMode || isProductMode) && item.productName && (() => {
                    const t = truncateByDisplayWidth(item.productName, 15);
                    return html`<div class="text-xs text-slate-500 mt-0.5 font-medium">${t}${t !== item.productName ? '\u2026' : ''}</div>`;
                  })()}
                  ${(isLeafLevel || isCustomerSearchMode || isProductMode) && (() => {
                    const qty = years.reduce((s, y) => s + (item.quantity?.[y] || 0), 0);
                    return qty > 0 ? html`<div class="text-xs text-indigo-500 font-bold mt-0.5">\u53d7\u6ce8\u6570: ${qty.toLocaleString()}</div>` : null;
                  })()}
                  ${!isLeafLevel && !isCustomerSearchMode && !isProductMode && html`<div class="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-tighter no-print">\u30af\u30ea\u30c3\u30af\u3067\u8a73\u7d30\u3092\u8868\u793a</div>`}
                </td>
                ${years.map((y, yi) => {
                  const s = item.sales[y]||0, p = item.profit[y]||0, q = item.quantity?.[y]||0;
                  const yoy = years[yi-1] ? calcYoY(s, item.sales[years[yi-1]]) : null;
                  const qoy = years[yi-1] ? calcYoY(q, item.quantity?.[years[yi-1]]) : null;
                  return html`<td key=${y} class="px-2 md:px-6 py-4 border-l border-slate-300 group-hover:bg-white/50">
                    <div class="space-y-2">
                      ${isProductLevel ? html`
                        <div class="flex justify-between items-baseline">
                          <span class="text-[10px] font-black text-slate-600">\u6570\u91cf</span>
                          <div class="text-right">
                            <div class="font-mono font-black text-slate-700 text-xs md:text-base">${q.toLocaleString()}</div>
                            ${qoy !== null && html`<div class=${'text-[10px] font-black flex items-center justify-end gap-0.5 ' + (parseFloat(qoy)>=0?'text-emerald-500':'text-rose-500')}>${parseFloat(qoy)>=0?'\u25b2':'\u25bc'}${qoy}%</div>`}
                          </div>
                        </div>
                      ` : html`
                        <div class="flex justify-between items-baseline">
                          <span class="text-[10px] font-black text-slate-600">\u58f2\u4e0a</span>
                          <div class="text-right">
                            <div class="font-mono font-black text-slate-700 text-xs md:text-base">${fmtAmt(s)}</div>
                            ${yoy !== null && html`<div class=${'text-[10px] font-black flex items-center justify-end gap-0.5 ' + (parseFloat(yoy)>=0?'text-emerald-500':'text-rose-500')}>${parseFloat(yoy)>=0?'\u25b2':'\u25bc'}${yoy}%</div>`}
                          </div>
                        </div>
                        ${showProfit && html`
                          <div class="flex justify-between items-baseline">
                            <span class="text-[10px] font-black text-slate-600">\u7c97\u5229</span>
                            <div class="text-right">
                              <div class="font-mono font-black text-emerald-600 text-xs md:text-base">${fmtAmt(p)}</div>
                              <div class="px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded text-[10px] font-black mt-0.5 w-fit ml-auto border border-emerald-100">${calcMargin(p,s)}%</div>
                            </div>
                          </div>
                        `}
                      `}
                    </div>
                  </td>`;
                })}
              </tr>`;
            })
          }
        </tbody>
      </table>
    </div>
  </div>`;
};

// ===== App メインコンポーネント =====
const App = () => {
  // --- Auth ---
  const [isAuth, setIsAuth] = useState(() => localStorage.getItem('kasouhin_auth') === 'true' || !PASSWORD);
  const [pwInput, setPwInput] = useState('');
  const [pwError, setPwError] = useState('');

  // --- Data ---
  const [rawData, setRawData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState('');
  const [loadError, setLoadError] = useState(null);
  const [connStatus, setConnStatus] = useState('idle');

  // --- UI ---
  const [selectedLease, setSelectedLease] = useState('ALL');
  const [monthRange, setMonthRange] = useState({ start: '4', end: '3' });
  const [amountUnit, setAmountUnit] = useState('yen');
  const [showProfit, setShowProfit] = useState(true);
  const [hierarchyOrder, setHierarchyOrder] = useState('orderer_first');
  const [checkedItems, setCheckedItems] = useState(new Set());
  const [activeView, setActiveView] = useState({ branchName: null, secondName: null, thirdName: null });
  const [customerViewMode, setCustomerViewMode] = useState('orderer');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);

  // --- ログイン ---
  const handleLogin = e => {
    e.preventDefault();
    if (pwInput === PASSWORD) { localStorage.setItem('kasouhin_auth', 'true'); setIsAuth(true); }
    else setPwError('\u30d1\u30b9\u30ef\u30fc\u30c9\u304c\u9055\u3044\u307e\u3059');
  };

  // --- データ読み込み ---
  const loadData = useCallback(async (forceRefresh = false) => {
    setIsLoading(true); setLoadError(null); setConnStatus('loading');

    if (!GAS_URL) {
      setLoadMsg('CSV\u30c7\u30fc\u30bf\u3092\u8aad\u307f\u8fbc\u307f\u4e2d...');
      try {
        const csv = await loadCsvData();
        setRawData({ ...csv, fromCache: false, cacheAgeMsg: 'CSV' });
        setConnStatus('online');
      } catch (e) {
        setLoadError('CSV\u8aad\u307f\u8fbc\u307f\u5931\u6557: ' + e.message); setConnStatus('offline');
      }
      setIsLoading(false); setLoadMsg('');
      return;
    }

    setLoadMsg('\u30ad\u30e3\u30c3\u30b7\u30e5\u3092\u78ba\u8a8d\u4e2d...');
    try {
      let rows = [], offset = 0;
      if (!forceRefresh) {
        const cached = await getCache(CACHE_KEY);
        if (cached?.data) {
          rows = cached.data.rows || [];
          offset = rows.length;
          const ageMin = Math.floor((Date.now() - cached.timestamp) / 60000);
          setRawData({ ...cached.data, rows, fromCache: true, cacheAgeMsg: ageMin + '\u5206\u524d\u306e\u30c7\u30fc\u30bf' });
          setConnStatus('online');
        }
      } else { await clearCache(); }

      let hasMore = true;
      while (hasMore) {
        const res = await fetch(GAS_URL + '?offset=' + offset + '&limit=5000');
        const json = await res.json();
        if (!json.success) throw new Error(json.error);
        const nr = json.data.rows;
        if (nr.length) { rows = [...rows, ...nr]; offset += nr.length; }
        if (offset >= json.data.totalRows || !nr.length) hasMore = false;
        else setLoadMsg(offset.toLocaleString() + ' / ' + json.data.totalRows.toLocaleString() + ' \u4ef6\u3092\u540c\u671f\u4e2d...');
      }

      const yearsSet = new Set(), leaseSet = new Set();
      rows.forEach(r => { if (r.fiscalYear) yearsSet.add(r.fiscalYear); if (r.leaseCompany) leaseSet.add(r.leaseCompany); });
      const finalData = { rows, years: Array.from(yearsSet).sort((a,b)=>a-b), leaseCompanies: Array.from(leaseSet).sort() };
      await setCache(CACHE_KEY, { data: finalData, timestamp: Date.now() });
      setRawData({ ...finalData, fromCache: false, cacheAgeMsg: '\u6700\u65b0' });
      setConnStatus('online');
    } catch (e) {
      setLoadError('\u30c7\u30fc\u30bf\u53d6\u5f97\u5931\u6557: ' + e.message);
      if (!rawData) setConnStatus('offline');
    }
    setIsLoading(false); setLoadMsg('');
  }, [rawData]);

  useEffect(() => { if (isAuth) loadData(); }, [isAuth]);

  useEffect(() => {
    if (!rawData?.rows.length || !rawData.years.length) return;
    const maxFY = Math.max(...rawData.years);
    const months = rawData.rows.filter(r => r.fiscalYear === maxFY).map(r => r.month);
    if (months.length) {
      const toPos = m => (m - 4 + 12) % 12;
      const latest = months.reduce((b, m) => toPos(m) > toPos(b) ? m : b);
      setMonthRange(prev => ({ ...prev, end: String(latest) }));
    }
  }, [rawData]);

  useEffect(() => { setActiveView(p => ({ ...p, secondName: null, thirdName: null })); }, [hierarchyOrder]);

  // --- 集計 ---
  const filteredRows = useMemo(() => {
    if (!rawData) return [];
    const rows = rawData.rows.filter(r => r.leaseCompany && r.leaseCompany.trim() && r.leaseCompany !== '\u7a7a\u767d' && r.leaseCompany !== '\u305d\u306e\u4ed6');
    return filterRows(rows, { leaseCompany: selectedLease, startMonth: monthRange.start, endMonth: monthRange.end });
  }, [rawData, selectedLease, monthRange]);

  const years = useMemo(() => rawData?.years || [], [rawData]);
  const leaseCompanies = useMemo(() => (rawData?.leaseCompanies || []).filter(l => l && l.trim() && l !== '\u7a7a\u767d' && l !== '\u305d\u306e\u4ed6'), [rawData]);
  const branches = useMemo(() => { const s = new Set(); filteredRows.forEach(r => r.branch && s.add(r.branch)); return [...s].sort(); }, [filteredRows]);

  const excludeKO = rows => rows.filter(r => !String(r.name || '').startsWith('K-O'));
  const isProductMode = customerViewMode === 'product' && activeView.branchName && activeView.secondName && !activeView.thirdName;
  const isCustomerSearchMode = isProductMode && activeView.branchName !== activeView.secondName;
  const isBranchProductMode = isProductMode && activeView.branchName === activeView.secondName;

  const currentTableData = useMemo(() => {
    if (!filteredRows.length || !years.length) return [];
    const { branchName, secondName, thirdName } = activeView;
    if (isProductMode) {
      if (isBranchProductMode) return excludeKO(aggregateByProductInBranch(filteredRows, years, branchName));
      if (hierarchyOrder === 'orderer_first') return excludeKO(aggregateByProductForOrderer(filteredRows, years, branchName, secondName));
      return excludeKO(aggregateByProductForCustomer(filteredRows, years, branchName, secondName));
    }
    if (!branchName) return aggregateByBranch(filteredRows, years);
    if (hierarchyOrder === 'orderer_first') {
      if (!secondName) return aggregateByOrderer(filteredRows, years, branchName);
      if (!thirdName) return aggregateByCustomer(filteredRows, years, branchName, secondName);
      return excludeKO(aggregateByProductByYear(filteredRows, years, branchName, secondName, thirdName, 'orderer_first'));
    }
    if (!secondName) return aggregateByCustomerInBranch(filteredRows, years, branchName);
    if (!thirdName) return aggregateByOrdererForCustomer(filteredRows, years, branchName, secondName);
    return excludeKO(aggregateByProductByYear(filteredRows, years, branchName, secondName, thirdName, 'customer_first'));
  }, [filteredRows, years, activeView, hierarchyOrder, isProductMode]);

  useEffect(() => {
    if (!currentTableData.length) return;
    setCheckedItems(new Set(currentTableData.map(d => d.name)));
  }, [activeView.branchName, activeView.secondName, activeView.thirdName, hierarchyOrder]);

  const isLeafLevel = !!(activeView.branchName && activeView.secondName && activeView.thirdName);
  const isProductLevel = isLeafLevel || isProductMode;

  const totalRow = useMemo(() => {
    if (!currentTableData.length || !years.length) return null;
    const filtered = currentTableData.filter(d => checkedItems.has(d.name));
    if (!filtered.length) return null;
    const sales = {}, profit = {}, quantity = {};
    years.forEach(y => { sales[y] = 0; profit[y] = 0; quantity[y] = 0; });
    filtered.forEach(item => years.forEach(y => {
      sales[y] += item.sales[y] || 0;
      profit[y] += item.profit[y] || 0;
      quantity[y] += item.quantity?.[y] || 0;
    }));
    const { branchName, secondName } = activeView;
    return { name: !branchName ? '\u5168\u90e8\u5e97 \u5408\u8a08' : !secondName ? branchName + ' \u5408\u8a08' : secondName + ' \u5408\u8a08', sales, profit, quantity };
  }, [currentTableData, years, activeView, checkedItems]);

  const levelInfo = useMemo(() => {
    const { branchName, secondName, thirdName } = activeView;
    if (!branchName) return { label: '\u90e8\u5e97\u540d', title: '\u90e8\u5e97\u5225 \u5e74\u6b21\u5b9f\u7e3e\u6bd4\u8f03' };
    if (hierarchyOrder === 'orderer_first') {
      if (!secondName) return { label: '\u6ce8\u6587\u8005\u540d', title: branchName + ' \u5185 \u6ce8\u6587\u8005\u5b9f\u7e3e' };
      if (!thirdName) return { label: '\u9867\u5ba2\u540d', title: secondName + ' \u5185 \u9867\u5ba2\u5b9f\u7e3e' };
      return { label: '\u54c1\u756a', title: thirdName + ' \u5185 \u54c1\u756a\u5225\u5b9f\u7e3e' };
    }
    if (!secondName) return { label: '\u9867\u5ba2\u540d', title: branchName + ' \u5185 \u9867\u5ba2\u5b9f\u7e3e' };
    if (!thirdName) return { label: '\u6ce8\u6587\u8005\u540d', title: secondName + ' \u5185 \u62c5\u5f53\u8005\u4e00\u89a7' };
    return { label: '\u54c1\u756a', title: thirdName + ' \u5185 \u54c1\u756a\u5225\u5b9f\u7e3e' };
  }, [activeView, hierarchyOrder]);

  // --- ハンドラ ---
  const handleDrillDown = item => {
    if (isLeafLevel || isProductMode) return;
    const { branchName, secondName } = activeView;
    if (!branchName) setActiveView({ branchName: item.name, secondName: null, thirdName: null });
    else if (!secondName) setActiveView(p => ({ ...p, secondName: item.name, thirdName: null }));
    else setActiveView(p => ({ ...p, thirdName: item.name }));
  };

  const handleShowProducts = item => {
    const { branchName, secondName } = activeView;
    if (!branchName) setActiveView({ branchName: item.name, secondName: item.name, thirdName: null });
    else if (!secondName) setActiveView(p => ({ ...p, secondName: item.name, thirdName: null }));
    setCustomerViewMode('product');
  };

  const handleBreadcrumb = target => {
    setCustomerViewMode('orderer');
    if (target === 'branch') setActiveView({ branchName: null, secondName: null, thirdName: null });
    else if (target === 'second') setActiveView(p => ({ ...p, secondName: null, thirdName: null }));
    else setActiveView(p => ({ ...p, thirdName: null }));
  };

  const handleSearch = useCallback(q => {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); setIsDropdownOpen(false); return; }
    const r = searchCustomers(filteredRows, q);
    setSearchResults(r); setIsDropdownOpen(r.length > 0);
  }, [filteredRows]);

  const handleSelectCustomer = useCallback(r => {
    setActiveView({ branchName: r.branchName, secondName: r.customerName, thirdName: null });
    setSelectedLease(r.leaseCompany || 'ALL');
    setCustomerViewMode('product');
    setSearchQuery(''); setSearchResults([]); setIsDropdownOpen(false);
  }, []);

  const handleSaveCsv = () => {
    const { branchName, secondName, thirdName } = activeView;
    let rows = filteredRows;
    if (branchName) rows = rows.filter(r => r.branch === branchName);
    if (secondName && secondName !== branchName) rows = rows.filter(r => hierarchyOrder === 'orderer_first' ? r.ordererName === secondName : r.customerName === secondName);
    if (thirdName) rows = rows.filter(r => hierarchyOrder === 'orderer_first' ? r.customerName === thirdName : r.ordererName === thirdName);
    if (!rows.length) return;
    const csv = generateDetailCsvContent(rows);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    const label = [branchName, secondName !== branchName ? secondName : null, thirdName].filter(Boolean).join('_') || 'ALL';
    a.download = '\u660e\u7d30\u30c7\u30fc\u30bf_' + label + '_' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const fmtAmt = val => fmtAmtFn(val, amountUnit);

  // ===== ログイン画面 =====
  if (!isAuth) return html`
    <div class="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div class="bg-white rounded-[3rem] w-full max-w-sm shadow-2xl overflow-hidden">
        <div class="p-10 border-b border-slate-50 bg-slate-50/50">
          <div class="flex items-center gap-3 mb-2">
            <div class="bg-blue-500 p-2 rounded-xl text-white"><${Icon} name="database" size=${22} /></div>
            <h1 class="text-xl font-black tracking-tighter text-slate-800">Sales Report</h1>
          </div>
          <p class="text-[11px] text-slate-400 font-bold uppercase tracking-widest">\u7279\u8ca9\u90e8\u30ea\u30fc\u30b9\u4f1a\u793e\u5b9f\u7e3e</p>
        </div>
        <form onSubmit=${handleLogin} class="p-10 space-y-6">
          <div class="space-y-2">
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-widest">\u30d1\u30b9\u30ef\u30fc\u30c9</label>
            <input type="password" value=${pwInput} onInput=${e => setPwInput(e.target.value)}
              class="w-full bg-slate-100 border-none rounded-2xl p-4 text-sm font-bold text-slate-700 focus:ring-4 focus:ring-blue-500/10"
              placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" autoFocus />
            ${pwError && html`<p class="text-xs text-rose-500 font-bold px-2">${pwError}</p>`}
          </div>
          <button type="submit" class="w-full bg-slate-900 text-white py-4 rounded-2xl font-black shadow-xl hover:bg-blue-600 transition-all active:scale-95">\u30ed\u30b0\u30a4\u30f3</button>
        </form>
      </div>
    </div>`;

  // ===== メイン画面 =====
  return html`
  <div class="min-h-screen bg-slate-50 font-sans text-slate-900 select-none">

    <!-- TopBar -->
    <div class="fixed top-0 left-0 right-0 z-40 bg-slate-900 text-white flex items-center justify-between px-4 py-3 no-print">
      <button onClick=${() => setIsSidebarOpen(v => !v)} class="flex items-center gap-2 hover:opacity-80 transition-opacity">
        <div class="bg-blue-500 p-1.5 rounded-lg"><${Icon} name="database" size=${18} /></div>
        <span class="font-black text-sm tracking-tight">\u67b6\u88c5\u54c1\u58f2\u4e0a\u30ec\u30dd\u30fc\u30c8</span>
      </button>
      <div class="flex items-center gap-2">
        <a href="https://kasouhin-500-web.vercel.app" target="_blank" rel="noopener noreferrer"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-black transition-colors">
          <${Icon} name="externallink" size=${13} /> 500\u53d7\u6ce8\u30ec\u30dd\u30fc\u30c8
        </a>
        <button onClick=${() => setIsSidebarOpen(v => !v)} class="p-2 rounded-xl hover:bg-slate-800 transition-colors">
          <${Icon} name=${isSidebarOpen ? 'x' : 'menu'} size=${22} />
        </button>
      </div>
    </div>

    <!-- Sidebar Overlay -->
    ${isSidebarOpen && html`<div class="fixed inset-0 bg-black/50 z-30" onClick=${() => setIsSidebarOpen(false)} />`}

    <!-- Sidebar -->
    <aside class=${'fixed top-0 left-0 w-64 bg-slate-900 text-white flex flex-col p-6 h-screen shadow-2xl z-40 no-print transition-transform duration-300 ' + (isSidebarOpen ? 'translate-x-0' : '-translate-x-full')}>
      <div class="flex items-center justify-between mb-10 px-2">
        <div class="flex items-center gap-3">
          <div class="bg-blue-500 p-2 rounded-xl text-white"><${Icon} name="database" size=${24} /></div>
          <h1 class="text-lg font-black leading-none tracking-tighter uppercase">Special${html`<br/>`}Sales Report</h1>
        </div>
        <button onClick=${() => setIsSidebarOpen(false)} class="p-1.5 rounded-xl hover:bg-slate-800 text-slate-400"><${Icon} name="x" size=${18} /></button>
      </div>
      <nav class="flex-1 space-y-2">
        <button onClick=${handleSaveCsv} class="flex items-center gap-3 w-full p-4 rounded-2xl text-slate-400 hover:bg-slate-800 transition-all border border-transparent hover:border-slate-700">
          <div class="flex items-center gap-3 italic font-bold text-sm text-slate-200"><${Icon} name="filetext" size=${18} /> CSV Export</div>
        </button>
        <button onClick=${() => window.print()} class="flex items-center gap-3 w-full p-4 rounded-2xl text-slate-400 hover:bg-slate-800 transition-all border border-transparent hover:border-slate-700">
          <div class="flex items-center gap-3 italic font-bold text-sm text-slate-200"><${Icon} name="file" size=${18} /> PDF Export</div>
        </button>
      </nav>
      ${rawData && html`
      <div class="mb-4 p-3 bg-slate-800 rounded-2xl text-xs space-y-1">
        <div class="flex justify-between text-slate-400">
          <span>\u30ec\u30b3\u30fc\u30c9\u6570</span>
          <span class="font-mono font-bold text-slate-200">${rawData.rows.length.toLocaleString()}</span>
        </div>
        <div class="flex justify-between text-slate-400">
          <span>\u30c7\u30fc\u30bf</span>
          <span class=${'font-mono font-bold ' + (rawData.fromCache ? 'text-emerald-400' : 'text-blue-400')}>${rawData.cacheAgeMsg}</span>
        </div>
      </div>`}
      <div class="space-y-2">
        ${PASSWORD && html`<button onClick=${() => { localStorage.removeItem('kasouhin_auth'); setIsAuth(false); }} class="flex items-center gap-3 w-full p-3 rounded-2xl text-slate-500 hover:bg-slate-800 transition-all text-xs font-bold">
          <${Icon} name="xcircle" size=${16} /> \u30ed\u30b0\u30a2\u30a6\u30c8
        </button>`}
        <button onClick=${() => setIsConfigOpen(true)} class="flex items-center gap-3 w-full p-4 rounded-2xl text-slate-400 hover:bg-slate-800 transition-all border border-slate-800">
          <${Icon} name="settings" size=${20} />
          <span class="font-bold text-sm">\u8a2d\u5b9a</span>
        </button>
      </div>
    </aside>

    <!-- Main -->
    <main class="pt-20 min-h-screen px-4 pb-4 md:px-8 md:pb-8 overflow-y-auto custom-scrollbar">
      <header class="mb-6 md:mb-10 space-y-4 md:space-y-8 no-print">
        <div class="flex flex-col md:flex-row md:justify-between md:items-end gap-4">
          <div>
            <div class="flex items-center gap-3 mb-2">
              <h2 class="text-2xl md:text-4xl font-black text-slate-800 tracking-tighter">\u67b6\u88c5\u54c1\u58f2\u4e0a\u30ec\u30dd\u30fc\u30c8</h2>
              <${ConnectionBadge} status=${connStatus} />
            </div>
          </div>
          <div class="flex items-center gap-3">
            ${loadMsg && html`<div class="flex items-center gap-2 text-xs font-bold text-slate-500 bg-slate-100 px-4 py-2 rounded-2xl animate-pulse"><${Icon} name="loader" size=${14} cls="animate-spin" />${loadMsg}</div>`}
            <button onClick=${() => loadData(true)} disabled=${isLoading}
              class=${'group flex items-center gap-2 px-5 md:px-8 py-3 md:py-4 rounded-3xl bg-slate-900 text-white font-black text-sm shadow-2xl hover:bg-blue-600 transition-all duration-300 active:scale-95 disabled:opacity-50 ' + (isLoading ? 'animate-pulse' : '')}>
              <${Icon} name="refresh" size=${16} cls=${isLoading ? 'animate-spin' : ''} />
              <span class="hidden sm:inline">${isLoading ? '\u540c\u671f\u4e2d...' : '\u6700\u65b0\u30c7\u30fc\u30bf\u306b\u66f4\u65b0'}</span>
              <span class="sm:hidden">${isLoading ? '\u540c\u671f\u4e2d' : '\u66f4\u65b0'}</span>
            </button>
          </div>
        </div>

        <!-- Filters -->
        <div class="bg-white p-4 md:p-8 rounded-3xl md:rounded-[3rem] shadow-sm border border-slate-100 flex flex-wrap gap-6 md:gap-12 items-start md:items-center">

          <!-- リース会社 -->
          <div class="space-y-3 w-full">
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">\u30ea\u30fc\u30b9\u4f1a\u793e\u9078\u629e</label>
            <div class="flex gap-2 flex-wrap">
              ${['ALL', ...leaseCompanies].map(l => html`
                <button key=${l} onClick=${() => { setSelectedLease(l); setActiveView({ branchName:null,secondName:null,thirdName:null }); }}
                  class=${'px-4 py-2 rounded-2xl text-xs font-black transition-all duration-300 ' + (selectedLease===l ? 'bg-blue-600 text-white shadow-xl shadow-blue-200' : 'bg-slate-100 text-slate-400 hover:bg-slate-200')}>
                  ${l === 'ALL' ? '\u3059\u3079\u3066' : l}
                </button>`)}
            </div>
          </div>

          <!-- 期間 -->
          <div class="space-y-3">
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">\u671f\u9593\u6307\u5b9a</label>
            <div class="flex items-center gap-4 bg-slate-100 p-2 rounded-2xl">
              <select value=${monthRange.start} onChange=${e => setMonthRange(p => ({ ...p, start: e.target.value }))}
                class="bg-transparent border-none text-sm font-black px-4 py-1.5 focus:ring-0 text-slate-700 cursor-pointer">
                ${Array.from({length:12}, (_,i) => html`<option key=${i+1} value=${String(i+1)}>${i+1}\u6708</option>`)}
              </select>
              <div class="w-4 h-0.5 bg-slate-300 rounded-full" />
              <select value=${monthRange.end} onChange=${e => setMonthRange(p => ({ ...p, end: e.target.value }))}
                class="bg-transparent border-none text-sm font-black px-4 py-1.5 focus:ring-0 text-slate-700 cursor-pointer">
                ${Array.from({length:12}, (_,i) => html`<option key=${i+1} value=${String(i+1)}>${i+1}\u6708</option>`)}
              </select>
            </div>
          </div>

          <!-- 金額単位 -->
          <div class="space-y-3">
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">\u91d1\u984d\u5358\u4f4d</label>
            <div class="flex bg-slate-100 p-1 rounded-2xl">
              ${['yen','thousand'].map(u => html`
                <button key=${u} onClick=${() => setAmountUnit(u)}
                  class=${'px-5 py-2.5 rounded-xl text-xs font-black transition-all duration-300 ' + (amountUnit===u ? 'bg-white text-slate-800 shadow-md' : 'text-slate-400 hover:text-slate-600')}>
                  ${u === 'yen' ? '\u5186' : '\u5343\u5186'}
                </button>`)}
            </div>
          </div>

          <!-- 粗利表示 -->
          <div class="space-y-3">
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">\u7c97\u5229\u8868\u793a</label>
            <button onClick=${() => setShowProfit(p => !p)}
              class=${'flex items-center gap-2 px-5 py-2.5 rounded-2xl text-xs font-black transition-all duration-300 ' + (showProfit ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-200' : 'bg-slate-100 text-slate-400 hover:bg-slate-200')}>
              <${Icon} name=${showProfit ? 'eye' : 'eyeoff'} size=${14} /> ${showProfit ? 'ON' : 'OFF'}
            </button>
          </div>

          <!-- 顧客検索 -->
          <div class="space-y-3">
            <label class="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] ml-2">\u9867\u5ba2\u691c\u7d22</label>
            <div class="flex items-center gap-2">
              <div class="flex-1 flex items-center bg-white border-2 border-transparent rounded-2xl px-4 py-2 focus-within:border-blue-500 transition-colors">
                <input type="text" value=${searchQuery} onInput=${e => handleSearch(e.target.value)}
                  onKeyDown=${e => { if (e.key === 'Enter' && searchResults.length === 1) handleSelectCustomer(searchResults[0]); }}
                  placeholder="\u9867\u5ba2\u540d\u3067\u691c\u7d22..."
                  class="flex-1 bg-transparent border-none text-sm focus:ring-0 text-slate-700 placeholder-slate-400" />
              </div>
              <button onClick=${() => searchResults.length === 1 && handleSelectCustomer(searchResults[0])} disabled=${!searchQuery.trim()}
                class="p-3 bg-blue-600 text-white rounded-2xl hover:bg-blue-700 disabled:bg-slate-300 transition-colors">
                <${Icon} name="search" size=${16} />
              </button>
            </div>
            ${isDropdownOpen && searchResults.length > 0 && html`
            <div class="bg-white border border-slate-200 rounded-2xl shadow-lg z-50 max-h-64 overflow-y-auto">
              ${searchResults.map((r, i) => html`
                <button key=${i} onClick=${() => handleSelectCustomer(r)}
                  class="w-full px-4 py-3 text-left hover:bg-blue-50 border-b border-slate-100 last:border-b-0 transition-colors group">
                  <div class="font-black text-slate-800 text-sm group-hover:text-blue-600">${r.customerName}</div>
                  <div class="text-xs text-slate-500 mt-1">${r.branchName}${r.leaseCompany ? ' \u2022 ' + r.leaseCompany : ''}</div>
                </button>`)}
            </div>`}
          </div>
        </div>
      </header>

      ${isLoading && !rawData && html`<${LoadingScreen} />`}
      ${loadError && html`
      <div class="bg-rose-50 border border-rose-200 rounded-3xl p-8 mb-8 flex items-center gap-4">
        <${Icon} name="alert" size=${24} cls="text-rose-500 flex-shrink-0" />
        <div>
          <h3 class="font-black text-rose-800 mb-1">\u30c7\u30fc\u30bf\u8aad\u307f\u8fbc\u307f\u30a8\u30e9\u30fc</h3>
          <p class="text-sm text-rose-600">${loadError}</p>
        </div>
      </div>`}

      ${rawData && !isLoading && html`
      <div class="space-y-4 md:space-y-8 animate-fade-in-up">
        <!-- Breadcrumb -->
        <div class="flex items-center gap-1 md:gap-2 text-xs md:text-sm font-bold no-print flex-wrap">
          ${isCustomerSearchMode ? html`
            <button onClick=${() => { setCustomerViewMode('orderer'); handleBreadcrumb('branch'); }} class="flex items-center gap-1 transition-colors text-slate-400 hover:text-slate-600"><${Icon} name="building" size=${16} /> \u90e8\u5e97\u4e00\u89a7</button>
            <${Icon} name="chevron" size=${14} cls="text-slate-300" />
            <button onClick=${() => handleBreadcrumb('second')} class="text-slate-400 hover:text-slate-600">${activeView.branchName}</button>
            <${Icon} name="chevron" size=${14} cls="text-slate-300" />
            <span class="text-blue-600">${activeView.secondName}</span>
          ` : isBranchProductMode ? html`
            <button onClick=${() => { setCustomerViewMode('orderer'); handleBreadcrumb('branch'); }} class="flex items-center gap-1 text-slate-400 hover:text-slate-600"><${Icon} name="building" size=${16} /> \u90e8\u5e97\u4e00\u89a7</button>
            <${Icon} name="chevron" size=${14} cls="text-slate-300" />
            <span class="text-blue-600">${activeView.branchName} \u54c1\u756a\u5225</span>
          ` : html`
            <button onClick=${() => handleBreadcrumb('branch')} class=${'flex items-center gap-1 transition-colors ' + (!activeView.branchName ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600')}><${Icon} name="building" size=${16} /> \u90e8\u5e97\u4e00\u89a7</button>
            ${activeView.branchName && html`
              <${Icon} name="chevron" size=${14} cls="text-slate-300" />
              <button onClick=${() => handleBreadcrumb('second')} class=${'flex items-center gap-1 transition-colors ' + (!activeView.secondName ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600')}>${activeView.branchName}</button>`}
            ${activeView.secondName && html`
              <${Icon} name="chevron" size=${14} cls="text-slate-300" />
              <button onClick=${() => handleBreadcrumb('third')} class=${'flex items-center gap-1 transition-colors ' + (!activeView.thirdName ? 'text-blue-600' : 'text-slate-400 hover:text-slate-600')}>${activeView.secondName}</button>`}
            ${activeView.thirdName && html`
              <${Icon} name="chevron" size=${14} cls="text-slate-300" />
              <span class="text-blue-600">${activeView.thirdName}</span>`}
          `}
        </div>

        <!-- 階層切替 + チェック -->
        ${!isCustomerSearchMode && !isProductMode && html`
        <div class="flex flex-wrap items-center gap-2 md:gap-4 no-print">
          <div class="flex items-center gap-1 bg-slate-100 rounded-2xl p-1">
            ${[['orderer_first', '\u90e8\u7f72\u2192\u62c5\u5f53\u8005\u2192\u9867\u5ba2'], ['customer_first', '\u90e8\u7f72\u2192\u9867\u5ba2\u2192\u62c5\u5f53\u8005']].map(([v, label]) => html`
              <button key=${v} onClick=${() => setHierarchyOrder(v)}
                class=${'flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-black ' + (hierarchyOrder===v ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-200')}>
                ${label}
              </button>`)}
          </div>
          <div class="flex items-center gap-2 ml-4">
            <button onClick=${() => setCheckedItems(new Set(currentTableData.map(d => d.name)))}
              class="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 text-xs font-black transition-colors">
              <${Icon} name="checksquare" size=${14} /> \u5168\u30c1\u30a7\u30c3\u30af
            </button>
            <button onClick=${() => setCheckedItems(new Set())}
              class="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-slate-100 text-slate-600 hover:bg-slate-200 text-xs font-black transition-colors">
              <${Icon} name="square" size=${14} /> \u5168\u89e3\u9664
            </button>
          </div>
        </div>`}

        <${DataTable}
          data=${currentTableData} years=${years} totalRow=${totalRow}
          activeView=${activeView} isLeafLevel=${isLeafLevel} isProductMode=${isProductMode} isCustomerSearchMode=${isCustomerSearchMode}
          checkedItems=${checkedItems} onCheck=${name => setCheckedItems(p => { const n = new Set(p); n.has(name) ? n.delete(name) : n.add(name); return n; })}
          onDrillDown=${handleDrillDown} levelInfo=${levelInfo} showProfit=${showProfit}
          fmtAmt=${fmtAmt} amountUnit=${amountUnit} onShowProducts=${handleShowProducts}
        />
      </div>`}
    </main>

    ${isConfigOpen && html`<${SettingsModal} gasUrl=${GAS_URL} onClose=${() => setIsConfigOpen(false)} onRefresh=${() => { setIsConfigOpen(false); loadData(true); }} />`}
  </div>`;
};

render(html`<${App} />`, document.getElementById('app'));
