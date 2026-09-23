// 気象庁アメダスの実況（最寄り観測所の日照時間・積雪深など）

const BASE = 'https://www.jma.go.jp/bosai/amedas';

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// 観測所一覧（緯度経度つき）。1週間ローカルに保存する
let tablePromise;
function loadTable() {
  if (!tablePromise) {
    tablePromise = (async () => {
      try {
        const c = JSON.parse(localStorage.getItem('amedasTable') || 'null');
        if (c && Date.now() - c.t < 7 * 864e5) return c.d;
      } catch {}
      const raw = await getJSON(`${BASE}/const/amedastable.json`);
      const d = {};
      for (const [id, v] of Object.entries(raw)) {
        d[id] = { name: v.kjName, lat: v.lat[0] + v.lat[1] / 60, lon: v.lon[0] + v.lon[1] / 60 };
      }
      try { localStorage.setItem('amedasTable', JSON.stringify({ t: Date.now(), d })); } catch {}
      return d;
    })().catch((e) => { tablePromise = null; throw e; });
  }
  return tablePromise;
}

const num = (v) => (Array.isArray(v) ? v[0] : null);

// 指定地点の最寄り観測所の実況を返す
export async function fetchObservation(lat, lon) {
  const [table, timeText] = await Promise.all([
    loadTable(),
    fetch(`${BASE}/data/latest_time.txt`, { cache: 'no-cache' }).then((r) => r.text()),
  ]);
  const iso = timeText.trim();
  const stamp = iso.replace(/[-:T]/g, '').slice(0, 14);
  const map = await getJSON(`${BASE}/data/map/${stamp}.json`);

  // 距離の近い順に、データのある観測所を探す（日照・積雪は観測所によって無い）
  const near = Object.keys(map)
    .filter((id) => table[id])
    .map((id) => {
      const s = table[id];
      const dx = (s.lon - lon) * Math.cos((lat * Math.PI) / 180);
      const dy = s.lat - lat;
      return { id, name: s.name, dist: Math.sqrt(dx * dx + dy * dy) * 111 };
    })
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 40);

  const base = near[0];
  const pick = (key) => {
    const hit = near.find((s) => num(map[s.id][key]) != null);
    return hit ? { value: num(map[hit.id][key]), station: hit.name, dist: hit.dist } : null;
  };
  return {
    time: iso,
    station: base?.name || '',
    dist: base?.dist ?? null,
    temp: base ? num(map[base.id].temp) : null,
    sun1h: pick('sun1h'),   // 直近1時間の日照時間（時間）
    snow: pick('snow'),     // 積雪深（cm）※冬季・観測所のみ
    precipitation24h: base ? num(map[base.id].precipitation24h) : null,
  };
}
