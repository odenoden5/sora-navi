// ファイルを更新したら、ここと index.html・sw.js の「1.4.0」をそろえて上げる（古いキャッシュ対策）
import { fetchForecast, buildModel, wmo, windDir, jstNow } from './weather.js?v=1.4.0';
import {
  resolveArea, fetchWarnings, fetchQuakes, localIntensity, warningPageUrl,
  shindoRank, shindoLabel, demoWarnings, demoQuake,
} from './jma.js?v=1.4.0';
import { PRESETS, searchPlaces, reverseMuni, currentPosition, load, save, addRecent } from './geo.js?v=1.4.0';
import { Radar } from './radar.js?v=1.4.0';

export const APP_VERSION = '1.4.0';

const $ = (s) => document.querySelector(s);
window.__appVersion = APP_VERSION;
$('#appVersion').textContent = APP_VERSION;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEMO = new URLSearchParams(location.search).has('demo');

const WEATHER_TTL = 30 * 60e3;
const ALERT_TTL = 3 * 60e3;

const state = {
  place: load('lastPlace', PRESETS[0]),
  settings: { umbrellaPop: 50, umbrellaMm: 0.5, ...load('settings', {}) },
  tab: load('tab', 'days'),
  weather: null, // { raw, t, stale }
  warn: null, // { data, t, stale } | { error }
  quakes: null, // { list, t, stale } | { error }
  holidays: {},
};

// ---------- 共通フォーマット ----------
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const dow = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
const md = (date) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const dayClass = (date) => (state.holidays[date] || dow(date) === 0 ? 'sun' : dow(date) === 6 ? 'sat' : '');
const r1 = (v) => (v == null ? '―' : Math.round(v));
const f1 = (v) => (v == null ? '―' : (Math.round(v * 10) / 10).toFixed(1));
const hm = (t) => new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const dt = (iso) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const tempClass = (t) => (t >= 35 ? 't-hot35' : t >= 30 ? 't-hot30' : t < 0 ? 't-cold' : '');
const diff = (d) => (d == null || Math.round(d) === 0 ? '<span class="diff">±0</span>' : `<span class="diff ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${Math.round(d)}</span>`);
const arrow = (deg) => (deg == null ? '' : `<span class="arrow" style="transform:rotate(${deg + 180}deg)" aria-hidden="true">↑</span>`);
const wind = (ws, wd) => `${arrow(wd)}${windDir(wd)} ${f1(ws)}m/s`;

// ---------- 地点 ----------
function placeId(p) { return p.id || `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`; }

async function ensureArea(p) {
  if (p.class20 && p.office) return p;
  try {
    const muniCd = p.muniCd || (await reverseMuni(p.lat, p.lon));
    const a = muniCd && (await resolveArea(muniCd));
    if (a) Object.assign(p, { muniCd, class20: a.class20, office: a.office, areaName: a.name });
  } catch (e) { console.warn(e); }
  return p;
}

function setPlace(p) {
  state.place = p;
  save('lastPlace', p);
  state.weather = null;
  state.warn = null;
  radar.setPlace(p);
  renderChips();
  renderAll();
  refreshAll(true);
}

function renderChips() {
  const cur = placeId(state.place);
  const recent = load('recent', []);
  const chip = (p, label) => `<button class="chip ${placeId(p) === cur ? 'active' : ''}" data-id="${esc(placeId(p))}">${esc(label || p.short || p.name)}</button>`;
  $('#chips').innerHTML = [
    ...PRESETS.map((p) => chip(p)),
    ...recent.filter((p) => !PRESETS.some((q) => q.id === p.id)).map((p) => chip(p)),
    `<button class="chip ghost ${cur === 'here' ? 'active' : ''}" data-act="here">📍 現在地</button>`,
    '<button class="chip ghost" data-act="search">🔍 検索</button>',
  ].join('');
}

$('#chips').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'search') { $('#searchDialog').showModal(); $('#searchInput').focus(); return; }
  if (b.dataset.act === 'here') {
    b.textContent = '📍 取得中…';
    try {
      const pos = await currentPosition();
      const p = await ensureArea({ id: 'here', name: '現在地', ...pos });
      p.name = p.areaName ? `現在地（${p.areaName}）` : '現在地';
      p.short = '📍 現在地';
      setPlace(p);
    } catch (err) { alert(err.message); renderChips(); }
    return;
  }
  const id = b.dataset.id;
  const p = PRESETS.find((x) => x.id === id) || load('recent', []).find((x) => x.id === id);
  if (p) setPlace({ ...p });
});

// ---------- 検索 ----------
$('#btnSearch').addEventListener('click', () => { $('#searchDialog').showModal(); $('#searchInput').focus(); });
$('#searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  const ul = $('#searchResults');
  if (!q) return;
  ul.innerHTML = '<li class="muted">検索中…</li>';
  try {
    const rs = await searchPlaces(q);
    ul.innerHTML = rs.length
      ? rs.map((r, i) => `<li><button class="list-btn" data-i="${i}">${esc(r.title)}</button></li>`).join('')
      : '<li class="muted">見つかりませんでした。市区町村名で試してください。</li>';
    ul.onclick = async (ev) => {
      const btn = ev.target.closest('button[data-i]');
      if (!btn) return;
      const r = rs[Number(btn.dataset.i)];
      btn.textContent = '読み込み中…';
      const p = await ensureArea({ id: `${r.lat.toFixed(3)},${r.lon.toFixed(3)}`, name: r.title, lat: r.lat, lon: r.lon });
      p.short = p.areaName && p.areaName.length < r.title.length ? p.areaName : r.title;
      addRecent(p);
      $('#searchDialog').close();
      setPlace(p);
    };
  } catch (err) {
    ul.innerHTML = `<li class="error">${esc(err.message)}</li>`;
  }
});

// ---------- 設定 ----------
$('#btnSettings').addEventListener('click', () => {
  $('#setPop').value = state.settings.umbrellaPop;
  $('#setMm').value = state.settings.umbrellaMm;
  $('#settingsDialog').showModal();
});
$('#settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pop = Number($('#setPop').value), mm = Number($('#setMm').value);
  if (Number.isFinite(pop)) state.settings.umbrellaPop = Math.min(100, Math.max(0, pop));
  if (Number.isFinite(mm)) state.settings.umbrellaMm = Math.max(0, mm);
  save('settings', state.settings);
  $('#settingsDialog').close();
  renderAll();
});
$('#btnClearRecent').addEventListener('click', () => { save('recent', []); renderChips(); $('#settingsDialog').close(); });

// ---------- タブ ----------
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) showTab(b.dataset.tab);
});
function showTab(tab) {
  state.tab = tab;
  save('tab', tab);
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.id !== `tab-${tab}`; });
  if (tab === 'radar') radar.open(state.place);
  else radar.stop();
}

const radar = new Radar($('#tab-radar'));

// ---------- データ取得 ----------
async function loadWeather(force) {
  const p = state.place, key = `wx:${placeId(p)}`;
  if (!force && state.weather && !state.weather.stale && Date.now() - state.weather.t < WEATHER_TTL) return;
  try {
    const raw = await fetchForecast(p.lat, p.lon);
    if (p !== state.place) return;
    state.weather = { raw, t: Date.now() };
    save(key, state.weather);
  } catch (e) {
    const c = load(key, null);
    state.weather = c ? { ...c, stale: true } : { error: e.message };
  }
}

async function loadWarnings(force) {
  if (!force && state.warn?.t && !state.warn.stale && Date.now() - state.warn.t < ALERT_TTL) return;
  const p = await ensureArea(state.place);
  if (p !== state.place) return;
  save('lastPlace', p);
  const key = `warn:${p.class20}`;
  if (DEMO) { state.warn = { data: demoWarnings(), t: Date.now() }; return; }
  if (!p.office) { state.warn = { error: 'この地点の警報・注意報の区域を特定できませんでした' }; return; }
  try {
    state.warn = { data: await fetchWarnings(p.office, p.class20), t: Date.now() };
    save(key, state.warn);
  } catch (e) {
    const c = load(key, null);
    state.warn = c ? { ...c, stale: true } : { error: '警報・注意報を取得できませんでした' };
  }
}

async function loadQuakes(force) {
  if (!force && state.quakes?.t && !state.quakes.stale && Date.now() - state.quakes.t < ALERT_TTL) return;
  try {
    const list = await fetchQuakes(10);
    if (DEMO) list.unshift(demoQuake(state.place.class20));
    state.quakes = { list, t: Date.now() };
    save('quakes', state.quakes);
  } catch (e) {
    const c = load('quakes', null);
    state.quakes = c ? { ...c, stale: true } : { error: '地震情報を取得できませんでした' };
  }
}

async function loadHolidays() {
  const c = load('holidays', null);
  if (c && Date.now() - c.t < 30 * 864e5) { state.holidays = c.d; return; }
  try {
    const d = await (await fetch('https://holidays-jp.github.io/api/v1/date.json')).json();
    state.holidays = d;
    save('holidays', { t: Date.now(), d });
  } catch { if (c) state.holidays = c.d; }
}

let refreshing = false;
async function refreshAll(force = false) {
  if (refreshing) return;
  refreshing = true;
  $('#btnRefresh').classList.add('spin');
  try {
    await Promise.all([
      loadWeather(force).then(renderWeather),
      loadWarnings(force).then(renderWarnings),
      loadQuakes(force).then(renderQuakes),
      state.tab === 'radar' ? radar.refresh(force) : null,
    ]);
  } finally {
    refreshing = false;
    $('#btnRefresh').classList.remove('spin');
    renderStatus();
  }
}

$('#btnRefresh').addEventListener('click', () => refreshAll(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAll(false); });
setInterval(() => { if (!document.hidden) refreshAll(false); }, 60e3);
window.addEventListener('online', () => refreshAll(true));
window.addEventListener('offline', renderStatus);

// ---------- 描画 ----------
function renderAll() {
  $('#placeName').textContent = state.place.name;
  renderWeather();
  renderWarnings();
  renderQuakes();
  renderStatus();
}

function renderStatus() {
  const w = state.weather;
  $('#updatedAt').textContent = w?.t ? `${hm(w.t)} 更新` : w?.error ? '更新できませんでした' : '読み込み中…';
  const stale = [w, state.warn, state.quakes].filter((x) => x?.stale);
  const off = $('#offline');
  if (!navigator.onLine || stale.length) {
    const t = Math.min(...stale.map((x) => x.t).filter(Boolean), w?.t || Infinity);
    off.hidden = false;
    off.textContent = `⚠ オフラインまたは通信エラーのため、${Number.isFinite(t) ? dt(t) : '以前'} 時点の情報を表示しています`;
  } else off.hidden = true;
}

const skeleton = '<div class="skel"></div><div class="skel short"></div><div class="skel"></div>';

function renderWeather() {
  const w = state.weather;
  if (!w || (!w.raw && !w.error)) {
    $('#hero').innerHTML = skeleton;
    for (const id of ['days', 'hourly', 'weekly']) $(`#tab-${id}`).innerHTML = `<div class="card">${skeleton}</div>`;
    return;
  }
  if (w.error) {
    $('#hero').innerHTML = `<p class="error">${esc(w.error)}</p>`;
    for (const id of ['days', 'hourly', 'weekly']) $(`#tab-${id}`).innerHTML = '';
    return;
  }
  let m;
  try { m = buildModel(w.raw, state.settings); } catch (e) {
    console.error(e);
    $('#hero').innerHTML = '<p class="error">天気データを表示できませんでした</p>';
    return;
  }
  renderHero(m);
  renderDays(m);
  renderHourly(m);
  renderWeekly(m);
}

// 天気アイコン（Meteocons）。anim=true はアニメーション版。読めない時は絵文字で代用
const ICON_BASE = 'https://cdn.jsdelivr.net/npm/@bybas/weather-icons@2.0.0/';
function wxImg(name, { anim = false, size = 32, alt = '', fallback = '', cls = '' } = {}) {
  const src = anim ? `${ICON_BASE}production/fill/all/${name}.svg` : `${ICON_BASE}design/fill/export/wi_${name}.svg`;
  return `<img class="wx ${cls}" src="${src}" width="${size}" height="${size}" alt="${esc(alt)}" decoding="async" onerror="this.replaceWith(document.createTextNode('${fallback}'))">`;
}
const wxIcon = (x, opt = {}) => wxImg(x.icon, { ...opt, alt: x.label, fallback: x.emoji });

function umbrellaLine(day, labelPrefix) {
  if (!day) return '';
  return day.umbrella.length
    ? `<div class="umbrella yes">${wxImg('umbrella', { anim: true, size: 44, fallback: '☂' })}<div><b>${labelPrefix}傘が必要</b><div class="u-times">${day.umbrella.join('、')}</div></div></div>`
    : `<div class="umbrella no">${wxImg('umbrella', { size: 36, fallback: '🌂', cls: 'dim' })}<div>${labelPrefix}傘は<b>不要</b>です</div></div>`;
}

function maxMin(day) {
  return `<div class="maxmin">
    <div class="mm max"><span class="lbl">最高</span><span class="val ${tempClass(day.max.temp)}">${r1(day.max.temp)}<small>℃</small></span>${diff(day.maxDiff)}<span class="when">${day.max.hour}時頃</span></div>
    <div class="mm min"><span class="lbl">最低</span><span class="val ${day.min.temp < 0 ? 't-cold' : ''}">${r1(day.min.temp)}<small>℃</small></span>${diff(day.minDiff)}<span class="when">${day.min.hour}時頃</span></div>
  </div>`;
}

function renderHero(m) {
  const c = m.current, t = m.today;
  const x = wmo(c.code, c.isDay);
  document.body.dataset.sky = x.sky;
  const sky = getComputedStyle(document.body).getPropertyValue('--sky-a').trim();
  if (sky) document.querySelector('meta[name=theme-color]')?.setAttribute('content', sky);
  const hl = (label, v, cls) => `<span class="hl-item"><span class="hl-lbl">${label}</span><b class="${cls}">${r1(v.temp)}°</b><small>${v.hour}時頃</small></span>`;
  $('#hero').innerHTML = `
    <div class="hero-main">
      <div class="hero-icon">${wxIcon(x, { anim: true, size: 150 })}</div>
      <div class="now-temp">${f1(c.temp)}<span class="deg">°</span></div>
      <div class="now-label">${esc(x.label)}</div>
      ${t ? `<div class="hl">${hl('最高', t.max, tempClass(t.max.temp))}${hl('最低', t.min, t.min.temp < 0 ? 't-cold' : '')}</div>` : ''}
    </div>
    <dl class="stats glass">
      <div>${wxImg('umbrella', { size: 30 })}<dt>降水確率</dt><dd>${r1(c.pop)}<small>%</small></dd></div>
      <div>${wxImg('raindrops', { size: 30 })}<dt>降水量</dt><dd>${f1(c.mm)}<small>mm</small></dd></div>
      <div>${wxImg('humidity', { size: 30 })}<dt>湿度</dt><dd>${r1(c.rh)}<small>%</small></dd></div>
      <div>${wxImg('wind', { size: 30 })}<dt>${arrow(c.wd)}${windDir(c.wd)}</dt><dd>${f1(c.ws)}<small>m/s</small></dd></div>
    </dl>
    ${umbrellaLine(t, 'この後、')}
    <button class="link-btn" data-goto="radar">雨雲レーダーで見る <span aria-hidden="true">›</span></button>`;
}

$('#hero').addEventListener('click', (e) => {
  if (!e.target.closest('[data-goto=radar]')) return;
  showTab('radar');
  $('.tabs').scrollIntoView({ behavior: 'smooth' });
});

function dayCard(day, title) {
  if (!day) return '';
  const x = wmo(day.code, 1);
  return `<article class="card day">
    <header class="day-head">
      <h2>${title} <span class="muted small ${dayClass(day.date)}">${md(day.date)}(${WEEK[dow(day.date)]})</span></h2>
      <div class="day-wx">${wxIcon(x, { anim: true, size: 64 })}<span>${esc(x.label)}</span></div>
    </header>
    ${maxMin(day)}
    ${umbrellaLine(day, '')}
    <table class="pop-table">
      <caption>降水確率</caption>
      <tr>${day.blocks.map((b) => `<th>${b.label}時</th>`).join('')}</tr>
      <tr>${day.blocks.map((b) => `<td class="${b.past ? 'past' : b.pop >= state.settings.umbrellaPop ? 'wet' : ''}">${b.past ? '―' : `${r1(b.pop)}%`}</td>`).join('')}</tr>
    </table>
    <dl class="stats compact">
      <div><dt>降水量</dt><dd>${f1(day.mm)}mm</dd></div>
      <div><dt>湿度</dt><dd>${day.rhMin}〜${day.rhMax}%</dd></div>
      <div><dt>最大風速</dt><dd>${wind(day.ws, day.wd)}</dd></div>
    </dl>
  </article>`;
}

function renderDays(m) {
  $('#tab-days').innerHTML = dayCard(m.today, '今日') + dayCard(m.tomorrow, '明日');
}

function renderHourly(m) {
  const hs = m.hourly;
  if (!hs.length) { $('#tab-hourly').innerHTML = ''; return; }
  const W = 56, H = 130, n = hs.length;
  const temps = hs.map((h) => h.temp);
  const tMax = Math.max(...temps), tMin = Math.min(...temps);
  const y = (t) => 26 + (1 - (t - tMin) / (tMax - tMin || 1)) * 56;
  const mmMax = Math.max(5, ...hs.map((h) => h.mm ?? 0));
  const pts = hs.map((h, i) => `${i * W + W / 2},${y(h.temp).toFixed(1)}`).join(' ');
  const isMark = (h, kind) => {
    const d = h.date === m.today?.date ? m.today : h.date === m.tomorrow?.date ? m.tomorrow : null;
    return d && d[kind].hour === h.hour;
  };
  const bars = hs.map((h, i) => {
    const bh = Math.min(1, (h.mm ?? 0) / mmMax) * 36;
    return bh > 0 ? `<rect class="bar" x="${i * W + 12}" y="${H - bh}" width="${W - 24}" height="${bh}" rx="2"/>` : '';
  }).join('');
  const labels = hs.map((h, i) => {
    const cx = i * W + W / 2, cy = y(h.temp);
    const mx = isMark(h, 'max'), mn = isMark(h, 'min');
    return `${mx || mn ? `<circle class="${mx ? 'pt-max' : 'pt-min'}" cx="${cx}" cy="${cy}" r="5"/><text class="mark ${mx ? 'max' : 'min'}" x="${cx}" y="${mx ? cy - 20 : cy + 30}">${mx ? '最高' : '最低'}</text>` : `<circle class="pt" cx="${cx}" cy="${cy}" r="2.5"/>`}
      <text class="tl ${tempClass(h.temp)}" x="${cx}" y="${cy - 9}">${f1(h.temp)}</text>`;
  }).join('');
  const svg = `<svg class="hchart" width="${n * W}" height="${H}" viewBox="0 0 ${n * W} ${H}" role="img" aria-label="気温と降水量のグラフ">
    ${bars}<polyline class="line" points="${pts}"/>${labels}</svg>`;

  const col = (h) => {
    const x = wmo(h.code, h.isDay);
    const newDay = h.hour === 0;
    return `<div class="hcol ${h.umbrella ? 'wet' : ''} ${newDay ? 'newday' : ''}">
      <div class="hdate ${dayClass(h.date)}">${newDay || h === hs[0] ? `${md(h.date)}(${WEEK[dow(h.date)]})` : ''}</div>
      <div class="htime">${h.hour}時</div>
      <div class="hicon" title="${esc(x.label)}">${wxIcon(x, { size: 40 })}</div>
    </div>`;
  };
  const row = (label, f) => `<div class="hrow"><div class="hlabel">${label}</div>${hs.map((h) => `<div class="hcell ${h.umbrella ? 'wet' : ''}">${f(h)}</div>`).join('')}</div>`;

  $('#tab-hourly').innerHTML = `<div class="card flush">
    <p class="legend small"><span class="lg wet"></span>傘が必要な時間 <span class="lg bar"></span>降水量 <span class="lg pmax"></span>最高 <span class="lg pmin"></span>最低</p>
    <div class="hscroll">
      <div class="hrow top"><div class="hlabel"></div>${hs.map(col).join('')}</div>
      <div class="hrow"><div class="hlabel">気温<br>℃</div><div class="hsvg">${svg}</div></div>
      ${row('傘', (h) => (h.umbrella ? '☂' : ''))}
      ${row('降水確率', (h) => `${r1(h.pop)}%`)}
      ${row('降水量', (h) => `${f1(h.mm)}`)}
      ${row('湿度', (h) => `${r1(h.rh)}%`)}
      ${row('風向', (h) => `${arrow(h.wd)}<span class="small">${windDir(h.wd)}</span>`)}
      ${row('風速', (h) => `${f1(h.ws)}`)}
    </div>
    <p class="muted small pad">降水量はmm、風速はm/s。横にスクロールできます。</p>
  </div>`;
}

function renderWeekly(m) {
  const ds = m.daily;
  const hi = Math.max(...ds.map((d) => d.tmax)), lo = Math.min(...ds.map((d) => d.tmin));
  const pct = (t) => ((t - lo) / (hi - lo || 1)) * 100;
  $('#tab-weekly').innerHTML = `<div class="card flush"><ul class="week">
    ${ds.map((d, i) => {
      const x = wmo(d.code, 1);
      const hol = state.holidays[d.date];
      return `<li class="wrow ${d.umbrella ? 'wet' : ''}">
        <div class="wdate ${dayClass(d.date)}">${i === 0 ? '今日' : i === 1 ? '明日' : md(d.date)}<span>(${WEEK[dow(d.date)]})</span>${hol ? `<em title="${esc(hol)}">祝</em>` : ''}</div>
        <div class="wicon" title="${esc(x.label)}">${wxIcon(x, { size: 40 })}</div>
        <div class="wtemp">
          <span class="tmin">${r1(d.tmin)}°</span>
          <span class="tbar"><i style="left:${pct(d.tmin)}%;right:${100 - pct(d.tmax)}%"></i></span>
          <span class="tmax ${tempClass(d.tmax)}">${r1(d.tmax)}°</span>
        </div>
        <div class="wpop">${d.umbrella ? '☂' : ''}${r1(d.pop)}%<small>${f1(d.mm)}mm</small></div>
        <div class="wwind small">${arrow(d.wd)}${f1(d.ws)}</div>
      </li>`;
    }).join('')}
  </ul><p class="muted small pad">左から：日付・天気・最低/最高気温・降水確率(☂=傘が必要)と降水量・最大風速(m/s)。先の日ほど予報の精度は下がります。</p></div>`;
}

// ---------- 警報・注意報 ----------
const LEVEL_CLASS = { 50: 'lv-special', 40: 'lv-danger', 30: 'lv-warning', 20: 'lv-advisory' };
const LEVEL_NAME = { 50: '特別警報', 40: '危険警報', 30: '警報', 20: '注意報' };

function renderWarnings() {
  const b = $('#warnBanner');
  const w = state.warn;
  b.hidden = false;
  if (!w) { b.className = 'warn-banner none'; b.innerHTML = '<span class="muted">警報・注意報を確認中…</span>'; return; }
  if (w.error) { b.className = 'warn-banner none'; b.innerHTML = `<span class="muted">${esc(w.error)}</span>`; return; }
  const items = w.data.items;
  if (!items.length) {
    b.className = 'warn-banner none';
    b.innerHTML = '<span>✓ 現在、警報・注意報はありません</span><span class="chev">›</span>';
  } else {
    const top = items[0].level;
    const names = items.map((i) => i.name);
    b.className = `warn-banner ${LEVEL_CLASS[top]}`;
    b.innerHTML = `<span class="wb-kind">${LEVEL_NAME[top]}</span><span class="wb-text">${esc(names.slice(0, 3).join('・'))}${names.length > 3 ? ` ほか${names.length - 3}件` : ''} 発表中</span><span class="chev">›</span>`;
  }
}

$('#warnBanner').addEventListener('click', () => {
  const w = state.warn;
  const p = state.place;
  let html = '';
  if (w?.data) {
    const d = w.data;
    html += `<p class="muted small">${esc(p.areaName || p.name)}（${esc(d.publishingOffice)}発表${d.reportDatetime ? `・${dt(d.reportDatetime)}` : ''}）</p>`;
    html += d.items.length
      ? `<ul class="warn-list">${d.items.map((i) => `<li class="${LEVEL_CLASS[i.level]}">
          <span class="wl-badge">${i.lv ? esc(i.lv.replace('レベル', 'Lv')) : LEVEL_NAME[i.level]}</span>
          <span class="wl-name">${esc(i.name)}</span>
          <span class="wl-status">${esc(i.status)}<br><small>${dt(i.reportDatetime)}</small></span></li>`).join('')}</ul>`
      : '<p>現在、発表中の警報・注意報はありません。</p>';
    if (d.items.length && d.headlines.length) html += d.headlines.map((h) => `<p class="headline">${esc(h)}</p>`).join('');
  } else html += `<p>${esc(w?.error || '読み込み中です')}</p>`;
  if (p.class20) html += `<p><a class="primary-btn link" href="${warningPageUrl(p.class20)}" target="_blank" rel="noopener">気象庁で今後の推移・詳細を見る</a></p>`;
  $('#warnDetail').innerHTML = html;
  $('#warnDialog').showModal();
});

// ---------- 地震 ----------
function shindoBadge(s) {
  return `<span class="shindo s${esc(s || 'x').replace('+', 'p').replace('-', 'm')}">${s ? `震度${shindoLabel(s)}` : '震度―'}</span>`;
}

function renderQuakes() {
  const q = state.quakes;
  const panel = $('#tab-quake');
  const alertEl = $('#quakeAlert');
  if (!q) { panel.innerHTML = `<div class="card">${skeleton}</div>`; alertEl.hidden = true; return; }
  if (q.error) { panel.innerHTML = `<div class="card"><p class="error">${esc(q.error)}</p></div>`; alertEl.hidden = true; return; }
  const p = state.place;
  const prefName = p.name.match(/^(.{2,3}?[都道府県])/)?.[1] || PRESETS.find((x) => x.muniCd === p.muniCd)?.pref || '地元';

  // 直近1時間以内に震度3以上 → 画面上部に通知
  const recent = q.list.find((x) => Date.now() - new Date(x.at).getTime() < 3600e3 && shindoRank(x.maxi) >= 3);
  if (recent) {
    alertEl.hidden = false;
    alertEl.innerHTML = `<button class="qa-btn"><b>地震情報</b> ${hm(recent.at)}頃 ${esc(recent.place)} ${shindoBadge(recent.maxi)}${recent.mag ? ` M${esc(recent.mag)}` : ''}<br><small>${esc(recent.tsunami || '')}</small></button>`;
    alertEl.querySelector('button').onclick = () => { showTab('quake'); scrollTo({ top: $('.tabs').offsetTop - 8, behavior: 'smooth' }); };
  } else alertEl.hidden = true;

  panel.innerHTML = `<div class="card flush"><ul class="quakes">${q.list.map((e) => {
    const li = localIntensity(e, p.class20);
    const tsunamiWarn = e.tsunami && !/心配はありません|影響はありません/.test(e.tsunami);
    return `<li class="quake">
      <div class="q-left">${shindoBadge(e.maxi)}</div>
      <div class="q-main">
        <div class="q-time">${dt(e.at)}頃</div>
        <div class="q-place">${esc(e.place)}</div>
        <div class="q-meta">${e.mag ? `M${esc(e.mag)}` : 'M―'}・深さ ${e.depth == null ? '―' : e.depth === 0 ? 'ごく浅い' : `約${e.depth}km`}</div>
        ${li ? `<div class="q-local">📍 ${esc(prefName)}の最大 ${shindoLabel(li.pref)}${li.city ? ` / ${esc(p.areaName || p.name)} ${shindoLabel(li.city)}` : ''}</div>` : ''}
        ${e.tsunami ? `<div class="q-tsunami ${tsunamiWarn ? 'warn' : ''}">${tsunamiWarn ? '🌊 ' : ''}${esc(e.tsunami)}</div>` : ''}
      </div>
    </li>`;
  }).join('')}</ul>
  <p class="pad small"><a href="https://www.jma.go.jp/bosai/map.html#contents=earthquake_map" target="_blank" rel="noopener">気象庁の地震情報ページ</a>　<span class="muted">${q.t ? `${hm(q.t)} 取得` : ''}</span></p></div>`;
}

// ---------- 起動 ----------
renderChips();
showTab(state.tab);
// 保存済みデータがあれば先に表示（高速表示・オフライン対応）
{
  const c = load(`wx:${placeId(state.place)}`, null);
  if (c) state.weather = { ...c, cached: true };
}
renderAll();
loadHolidays().then(() => { if (state.weather?.raw) renderWeather(); });
refreshAll(true);

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW登録失敗', e));
}
