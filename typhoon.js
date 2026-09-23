// 台風情報：気象庁の台風情報JSON（現在の勢力・予想進路・暴風域/強風域）
import { loadLeaflet } from './radar.js?v=1.6.0';

const BASE = 'https://www.jma.go.jp/bosai/typhoon/data';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jst = (iso, opt) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', ...opt });
// 「25日21時」のような短い表記
const shortJst = (iso) => {
  const d = new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', day: 'numeric', hour: 'numeric', hour12: false });
  const m = /(\d+)\D+(\d+)/.exec(d);
  return m ? `${m[1]}日${m[2]}時` : iso;
};

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const partEn = (it) => (typeof it.part === 'string' ? it.part : it.part?.en || '');

// 発生中の台風をすべて取得する（ない場合は空配列）
export async function fetchTyphoons() {
  const list = await getJSON(`${BASE}/targetTc.json`).catch(() => []);
  const tcs = Array.isArray(list) ? list : [];
  const out = [];
  for (const tc of tcs) {
    try {
      const [spec, fc] = await Promise.all([
        getJSON(`${BASE}/${tc.tropicalCyclone}/specifications.json`),
        getJSON(`${BASE}/${tc.tropicalCyclone}/forecast.json`),
      ]);
      const title = spec.find((x) => partEn(x) === 'title') || {};
      const specByHour = new Map();
      for (const s of spec) if (typeof s.advancedHours === 'number') specByHour.set(s.advancedHours, s);
      const steps = fc
        .filter((f) => typeof f.advancedHours === 'number')
        .map((f) => {
          const s = specByHour.get(f.advancedHours) || {};
          return {
            hours: f.advancedHours,
            time: f.validtime?.JST || s.validtime?.JST || '',
            center: f.center,
            circle: f.probabilityCircle?.radius || null,
            gale: f.galeWarningArea || null,
            storm: f.stormWarningArea || null,
            category: s.category?.jp || '',
            scale: s.scale && s.scale !== '-' ? s.scale : '',
            intensity: s.intensity && s.intensity !== '-' ? s.intensity : '',
            pressure: s.pressure || null,
            windMax: s.maximumWind?.sustained?.['m/s'] || null,
            windGust: s.maximumWind?.gust?.['m/s'] || null,
            course: s.course || '',
            speed: s.speed?.['km/h'] || null,
            location: s.location || '',
            galeRanges: s.galeWarning || [],
            stormRanges: s.stormWarning || [],
          };
        })
        .sort((a, b) => a.hours - b.hours);
      const track = fc.find((f) => f.track)?.track || null;
      out.push({
        id: tc.tropicalCyclone,
        number: title.typhoonNumber || tc.typhoonNumber,
        name: title.name?.jp || '',
        nameEn: title.name?.en || '',
        issue: title.issue?.JST || tc.issue,
        now: steps[0] || null,
        steps,
        track,
      });
    } catch (e) { console.warn('台風情報の取得に失敗', tc, e); }
  }
  return { list: out, t: Date.now() };
}

export function typhoonTitle(t) {
  const n = Number(t.number);
  const num = Number.isFinite(n) ? `台風${n % 100}号` : '台風';
  return t.name ? `${num}（${t.name}）` : num;
}

const fmtSpeed = (s) => (s.speed ? `${s.course || ''} ${s.speed}km/h` : s.course || '―');

function summaryRows(t) {
  const n = t.now || {};
  const gale = (n.galeRanges || []).map((g) => `${g.area}${g.range?.km ? ` ${g.range.km}km` : ''}`).join('・');
  const storm = (n.stormRanges || []).map((g) => `${g.area}${g.range?.km ? ` ${g.range.km}km` : ''}`).join('・');
  return [
    ['階級', [n.scale, n.intensity, n.category].filter(Boolean).join('・') || '―'],
    ['中心気圧', n.pressure ? `${n.pressure}hPa` : '―'],
    ['最大風速', n.windMax ? `${n.windMax}m/s` : '―'],
    ['最大瞬間風速', n.windGust ? `${n.windGust}m/s` : '―'],
    ['進行方向・速さ', fmtSpeed(n)],
    ['中心位置', n.location || '―'],
    ['暴風域', storm || 'なし'],
    ['強風域', gale || 'なし'],
  ];
}

export class Typhoon {
  constructor(panel) {
    this.panel = panel;
    this.data = null;
    this.maps = [];
    this.place = null;
  }

  setPlace(place) { this.place = place; }

  open(place, data) {
    if (place) this.place = place;
    if (data) this.data = data;
    if (!this.opening) {
      this.opening = this.render().catch((e) => {
        console.error(e);
        this.panel.innerHTML = `<div class="card"><p class="error">台風情報を表示できませんでした：${esc(e.message)}</p></div>`;
      }).finally(() => { this.opening = null; });
    }
    return this.opening;
  }

  async render() {
    if (!this.data) {
      this.panel.innerHTML = '<div class="card"><div class="skel"></div><div class="skel short"></div></div>';
      return;
    }
    const list = this.data.list || [];
    if (!list.length) {
      this.panel.innerHTML = '<div class="card"><p>現在、発生している台風はありません。</p><p class="muted small">台風が発生すると、ここに現在の勢力と予想進路が表示されます。出典：気象庁</p></div>';
      this.maps = [];
      return;
    }
    this.panel.innerHTML = list.map((t, i) => `<article class="card flush typhoon">
      <header class="ty-head">
        <div>
          <h2>🌀 ${esc(typhoonTitle(t))}</h2>
          <div class="muted small">${t.issue ? `${esc(jst(t.issue))} 発表` : ''}${t.nameEn ? `／${esc(t.nameEn)}` : ''}</div>
        </div>
        ${t.now?.category ? `<span class="ty-badge">${esc(t.now.category)}</span>` : ''}
      </header>
      <div class="ty-map" id="tyMap${i}"><div class="radar-msg">地図を読み込み中…</div></div>
      <dl class="ty-spec">${summaryRows(t).map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <h3 class="ty-sub">予想の進路</h3>
      <div class="ty-scroll"><table class="ty-table">
        <tr><th>日時</th>${t.steps.map((s) => `<th>${s.time ? esc(shortJst(s.time)) : '―'}</th>`).join('')}</tr>
        <tr><th>いつ</th>${t.steps.map((s) => `<td>${s.hours === 0 ? '現在' : `${s.hours}時間後`}</td>`).join('')}</tr>
        <tr><th>階級</th>${t.steps.map((s) => `<td>${esc([s.scale, s.intensity, s.category].filter(Boolean).join(' ') || '―')}</td>`).join('')}</tr>
        <tr><th>中心気圧</th>${t.steps.map((s) => `<td>${s.pressure ? `${s.pressure}hPa` : '―'}</td>`).join('')}</tr>
        <tr><th>最大風速</th>${t.steps.map((s) => `<td>${s.windMax ? `${s.windMax}m/s` : '―'}</td>`).join('')}</tr>
        <tr><th>最大瞬間</th>${t.steps.map((s) => `<td>${s.windGust ? `${s.windGust}m/s` : '―'}</td>`).join('')}</tr>
        <tr><th>予報円半径</th>${t.steps.map((s) => `<td>${s.circle ? `${Math.round(s.circle / 1000)}km` : '―'}</td>`).join('')}</tr>
      </table></div>
      <p class="pad small muted">白い円は予報円（台風の中心が入る可能性が高い範囲）、赤い円は暴風域、黄色い円は強風域です。青い点は表示中の地点です。出典：気象庁、地理院タイル</p>
    </article>`).join('');

    const L = await loadLeaflet();
    this.maps = [];
    list.forEach((t, i) => {
      const el = this.panel.querySelector(`#tyMap${i}`);
      if (!el) return;
      el.innerHTML = '';
      const map = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 2, maxZoom: 10 });
      L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
        maxNativeZoom: 18, className: 'base-tiles',
      }).addTo(map);
      map.attributionControl.setPrefix(false);
      const bounds = [];

      // これまでの経路
      const past = [...(t.track?.preTyphoon || []), ...(t.track?.typhoon || [])];
      if (past.length > 1) {
        L.polyline(past, { color: '#ffffff', weight: 2, opacity: 0.8, dashArray: '4 4' }).addTo(map);
        for (const c of past) bounds.push(c);
      }

      // 予想の中心を結ぶ線
      const centers = t.steps.filter((s) => s.center).map((s) => s.center);
      if (centers.length > 1) L.polyline(centers, { color: '#ff5a4e', weight: 3 }).addTo(map);

      let i2 = 0;
      for (const s of t.steps) {
        if (!s.center) continue;
        bounds.push(s.center);
        if (s.circle) {
          L.circle(s.center, { radius: s.circle, color: '#fff', weight: 2, fillColor: '#fff', fillOpacity: 0.12 }).addTo(map);
          bounds.push([s.center[0] + s.circle / 111000, s.center[1]], [s.center[0] - s.circle / 111000, s.center[1]]);
        }
        if (s.storm?.center) L.circle(s.storm.center, { radius: s.storm.radius, color: '#ff2d2d', weight: 2, fillColor: '#ff2d2d', fillOpacity: 0.22 }).addTo(map);
        if (s.gale?.center) L.circle(s.gale.center, { radius: s.gale.radius, color: '#ffd400', weight: 2, fillColor: '#ffd400', fillOpacity: 0.14 }).addTo(map);
        // 中心の点と、その下にずらした時刻ラベル（ラベル同士が重なりにくいよう上下交互に）
        L.circleMarker(s.center, { radius: 4, weight: 2, color: '#fff', fillColor: s.hours === 0 ? '#ff3b30' : '#ff8a65', fillOpacity: 1 }).addTo(map);
        const label = s.hours === 0 ? '現在' : s.time ? shortJst(s.time) : `${s.hours}h`;
        const below = i2 % 2 === 1;
        L.marker(s.center, {
          icon: L.divIcon({ className: 'ty-pin', html: `<span class="${s.hours === 0 ? 'now' : ''}">${label}</span>`, iconSize: [58, 18], iconAnchor: [29, below ? -6 : 24] }),
        }).addTo(map);
        i2 += 1;
      }

      // 表示中の地点
      if (this.place) {
        L.circleMarker([this.place.lat, this.place.lon], { radius: 6, weight: 3, color: '#fff', fillColor: '#2f6fe0', fillOpacity: 1 })
          .addTo(map).bindTooltip(this.place.areaName || this.place.name);
        bounds.push([this.place.lat, this.place.lon]);
      }
      if (bounds.length) map.fitBounds(L.latLngBounds(bounds).pad(0.15));
      this.maps.push(map);
    });
  }

  resize() { for (const m of this.maps) m.invalidateSize(); }
}
