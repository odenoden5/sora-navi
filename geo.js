// 地点：プリセット、検索（国土地理院）、逆ジオコーディング、保存

export const PRESETS = [
  { id: 'kumagaya', name: '熊谷市', pref: '埼玉県', lat: 36.1473, lon: 139.3886, muniCd: '11202' },
  { id: 'minato', name: '港区', pref: '東京都', lat: 35.6581, lon: 139.7516, muniCd: '13103' },
  { id: 'toshima', name: '豊島区', pref: '東京都', lat: 35.7263, lon: 139.7166, muniCd: '13116' },
];

// 国土地理院 住所検索API
export async function searchPlaces(q) {
  const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error('検索に失敗しました');
  const feats = await res.json();
  const seen = new Set();
  const out = [];
  for (const f of feats) {
    const title = f.properties?.title;
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const [lon, lat] = f.geometry.coordinates;
    out.push({ title, lat, lon });
    if (out.length >= 15) break;
  }
  return out;
}

// 国土地理院 逆ジオコーダ：緯度経度 → 市区町村コード
export async function reverseMuni(lat, lon) {
  const res = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lon}`);
  if (!res.ok) throw new Error('位置の特定に失敗しました');
  const j = await res.json();
  return j.results?.muniCd || null;
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('この端末では現在地を取得できません'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => reject(new Error('現在地を取得できませんでした（位置情報の許可を確認してください）')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  });
}

// ---- localStorage（使えない環境でも動くように try/catch）----
export function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
export function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export function addRecent(place) {
  if (PRESETS.some((p) => p.id === place.id)) return;
  const list = load('recent', []).filter((p) => p.id !== place.id);
  list.unshift(place);
  save('recent', list.slice(0, 5));
}
