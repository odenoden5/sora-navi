// 雨雲レーダー：気象庁の実況（過去1時間）＋ 降水ナウキャスト（1時間先まで5分毎）
// ＋ 降水短時間予報（15時間先まで1時間毎）を1本のタイムラインで表示する。
// 地図は Leaflet（レーダータブを開いた時に読み込む）＋ 地理院タイル。

const TILE = 'https://www.jma.go.jp/bosai/jmatile/data';
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
const FRAMES_TTL = 5 * 60e3;
const PAST_MIN = 60; // 実況は過去60分

// 降水強度の凡例（気象庁の配色）
const SCALE = [
  ['#F2F2FF', '〜1'], ['#A0D2FF', '1'], ['#218CFF', '5'], ['#0041FF', '10'],
  ['#FAF500', '20'], ['#FF9900', '30'], ['#FF2800', '50'], ['#B40068', '80〜'],
];

// "20260921062000"(UTC) → Date
const utc = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)));
const jst = (d, opt) => d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', ...opt });

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export async function fetchFrames() {
  const [n1, n2, rs] = await Promise.all([
    getJSON(`${TILE}/nowc/targetTimes_N1.json`),
    getJSON(`${TILE}/nowc/targetTimes_N2.json`),
    getJSON(`${TILE}/rasrf/targetTimes.json`).catch(() => []),
  ]);
  const has = (t, el) => (t.elements || []).includes(el);

  // 実況（過去）
  const past = n1.filter((t) => has(t, 'hrpns')).sort((a, b) => a.validtime.localeCompare(b.validtime));
  if (!past.length) throw new Error('レーダーの観測データがありません');
  const nowTime = utc(past[past.length - 1].validtime);
  const frames = past
    .filter((t) => nowTime - utc(t.validtime) <= PAST_MIN * 60e3)
    .map((t) => ({ time: utc(t.validtime), kind: 'past', url: `${TILE}/nowc/${t.basetime}/none/${t.validtime}/surf/hrpns/{z}/{x}/{y}.png` }));
  frames[frames.length - 1].kind = 'now';

  // 降水ナウキャスト（〜1時間先、5分毎）
  for (const t of n2.filter((x) => has(x, 'hrpns')).sort((a, b) => a.validtime.localeCompare(b.validtime))) {
    const time = utc(t.validtime);
    if (time > nowTime) frames.push({ time, kind: 'nowcast', url: `${TILE}/nowc/${t.basetime}/none/${t.validtime}/surf/hrpns/{z}/{x}/{y}.png` });
  }

  // 降水短時間予報（1時間毎）：速報版(immed, 〜6時間)の最新 → 通常版(none, 〜15時間)の最新 の順に採用
  const groups = new Map();
  for (const t of rs.filter((x) => has(x, 'rasrf'))) {
    const k = `${t.basetime}|${t.member}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const latest = (member) => [...groups.entries()]
    .filter(([k, v]) => k.endsWith(`|${member}`) && v.length > 1)
    .sort((a, b) => b[0].localeCompare(a[0]))[0]?.[1] || [];
  let last = frames[frames.length - 1].time;
  for (const group of [latest('immed'), latest('none')]) {
    for (const t of group.sort((a, b) => a.validtime.localeCompare(b.validtime))) {
      const time = utc(t.validtime);
      if (time - last < 30 * 60e3) continue;
      frames.push({ time, kind: 'rasrf', url: `${TILE}/rasrf/${t.basetime}/${t.member}/${t.validtime}/surf/rasrf/{z}/{x}/{y}.png` });
      last = time;
    }
  }
  return { frames, nowIndex: frames.findIndex((f) => f.kind === 'now'), t: Date.now() };
}

let leafletPromise;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletPromise) {
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = `${LEAFLET}leaflet.min.css`;
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = `${LEAFLET}leaflet.min.js`;
      s.onload = () => resolve(window.L);
      s.onerror = () => { leafletPromise = null; reject(new Error('地図を読み込めませんでした（通信状況を確認してください）')); };
      document.head.appendChild(s);
    });
  }
  return leafletPromise;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class Radar {
  constructor(panel) {
    this.panel = panel;
    this.data = null;
    this.index = 0;
    this.layers = new Map();
    this.timer = null;
    this.place = null;
  }

  async open(place) {
    this.place = place;
    if (!this.map) {
      this.panel.innerHTML = `<div class="card flush radar">
        <div class="radar-map" id="radarMap"><div class="radar-msg">地図を読み込み中…</div></div>
        <div class="radar-ctrl">
          <div class="radar-time"><span class="rkind" id="rKind"></span><b id="rTime">--:--</b><span class="muted small" id="rRel"></span></div>
          <div class="radar-row">
            <button class="round-btn" id="rPlay" aria-label="再生">▶</button>
            <input type="range" id="rSlider" min="0" max="0" value="0" aria-label="表示する時刻">
            <button class="chip" id="rNow">現在</button>
          </div>
          <div class="radar-scale small muted"><span id="rStart"></span><span>現在</span><span id="rEnd"></span></div>
        </div>
        <div class="radar-legend">${SCALE.map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('')}<span class="muted">mm/h</span></div>
        <p class="pad small muted">実況は5分毎、1時間先までは5分毎の予測（降水ナウキャスト）、その先は1時間毎の予測（降水短時間予報・1時間雨量）です。予測は先ほど精度が下がります。出典：気象庁、地理院タイル</p>
      </div>`;
      try {
        await this.initMap();
      } catch (e) {
        this.panel.querySelector('#radarMap').innerHTML = `<div class="radar-msg error">${esc(e.message)}</div>`;
        return;
      }
      this.bindControls();
    } else {
      this.map.invalidateSize();
      this.setPlace(place);
    }
    await this.refresh(false);
  }

  async initMap() {
    const L = await loadLeaflet();
    const el = this.panel.querySelector('#radarMap');
    el.innerHTML = '';
    this.map = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 4, maxZoom: 13 })
      .setView([this.place.lat, this.place.lon], 8);
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a>',
      maxNativeZoom: 18, className: 'base-tiles',
    }).addTo(this.map);
    this.map.attributionControl.addAttribution('<a href="https://www.jma.go.jp/bosai/nowc/" target="_blank" rel="noopener">気象庁</a>');
    this.map.attributionControl.setPrefix(false);
    this.marker = L.circleMarker([this.place.lat, this.place.lon], {
      radius: 7, weight: 3, color: '#fff', fillColor: '#e53935', fillOpacity: 1, pane: 'markerPane',
    }).addTo(this.map);
  }

  bindControls() {
    const $ = (s) => this.panel.querySelector(s);
    $('#rSlider').addEventListener('input', (e) => { this.stop(); this.show(Number(e.target.value)); });
    $('#rPlay').addEventListener('click', () => (this.timer ? this.stop() : this.play()));
    $('#rNow').addEventListener('click', () => { this.stop(); if (this.data) this.show(this.data.nowIndex); this.map.setView([this.place.lat, this.place.lon], Math.max(this.map.getZoom(), 8)); });
  }

  setPlace(place) {
    this.place = place;
    if (!this.map) return;
    this.map.setView([place.lat, place.lon], this.map.getZoom());
    this.marker.setLatLng([place.lat, place.lon]);
  }

  async refresh(force) {
    if (!this.map) return;
    if (!force && this.data && Date.now() - this.data.t < FRAMES_TTL) return;
    try {
      const prevRel = this.data ? this.index - this.data.nowIndex : 0;
      this.data = await fetchFrames();
      for (const l of this.layers.values()) this.map.removeLayer(l);
      this.layers.clear();
      const f = this.data.frames;
      const $ = (s) => this.panel.querySelector(s);
      const slider = $('#rSlider');
      slider.max = f.length - 1;
      const pct = (this.data.nowIndex / (f.length - 1 || 1)) * 100;
      slider.style.setProperty('--now', `${pct}%`);
      $('#rStart').textContent = jst(f[0].time, { hour: '2-digit', minute: '2-digit' });
      $('#rEnd').textContent = `${Math.round((f[f.length - 1].time - f[this.data.nowIndex].time) / 3600e3)}時間後`;
      this.show(Math.min(f.length - 1, Math.max(0, this.data.nowIndex + prevRel)));
    } catch (e) {
      console.warn(e);
      if (!this.data) this.panel.querySelector('#rTime').textContent = 'レーダー情報を取得できませんでした';
    }
  }

  layer(i) {
    const f = this.data.frames[i];
    if (!f) return null;
    let l = this.layers.get(f.url);
    if (!l) {
      l = window.L.tileLayer(f.url, { opacity: 0, maxNativeZoom: 10, minNativeZoom: 4, zIndex: 10, className: 'rain-tiles' });
      l.loaded = false;
      l.on('load', () => { l.loaded = true; });
      l.on('loading', () => { l.loaded = false; });
      this.layers.set(f.url, l);
      l.addTo(this.map);
    }
    return l;
  }

  show(i) {
    const f = this.data.frames;
    this.index = i;
    // 表示中のコマと前後だけ地図に載せる（先読み）。それ以外は外して通信量を抑える
    const keep = new Set();
    for (let k = i - 1; k <= i + 2; k++) if (f[k]) keep.add(f[k].url);
    for (const [url, l] of this.layers) if (!keep.has(url)) { this.map.removeLayer(l); this.layers.delete(url); }
    for (let k = i - 1; k <= i + 2; k++) { const l = this.layer(k); if (l) l.setOpacity(k === i ? 0.75 : 0); }

    const fr = f[i];
    const $ = (s) => this.panel.querySelector(s);
    $('#rSlider').value = i;
    $('#rTime').textContent = jst(fr.time, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const kind = { past: ['実況', 'past'], now: ['実況（最新）', 'now'], nowcast: ['予測', 'fc'], rasrf: ['予測（1時間雨量）', 'fc'] }[fr.kind];
    const k = $('#rKind');
    k.textContent = kind[0];
    k.className = `rkind ${kind[1]}`;
    const min = Math.round((fr.time - f[this.data.nowIndex].time) / 60e3);
    $('#rRel').textContent = min === 0 ? '' : min < 0 ? `${-min}分前` : min < 60 ? `${min}分後` : `約${Math.round(min / 60)}時間後`;
  }

  play() {
    if (!this.data) return;
    this.panel.querySelector('#rPlay').textContent = '❚❚';
    if (this.index >= this.data.frames.length - 1) this.show(0);
    let waits = 0;
    this.timer = setInterval(() => {
      const f = this.data.frames;
      const next = this.index >= f.length - 1 ? 0 : this.index + 1;
      const l = this.layer(next);
      if (l && !l.loaded && waits++ < 4) return; // 次のコマの読み込みを少し待つ
      waits = 0;
      this.show(next);
    }, 600);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    const b = this.panel.querySelector('#rPlay');
    if (b) b.textContent = '▶';
  }
}
