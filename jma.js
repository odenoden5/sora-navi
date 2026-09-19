// 気象庁（防災情報JSON）からの警報・注意報、地震情報の取得と整形
// ※気象庁のJSONは非公式仕様のため、構造変更があった場合はこのファイルだけを直せばよいようにしている。

const BASE = 'https://www.jma.go.jp/bosai';

// 警報・注意報コード表（2026年5月からの新しい防災気象情報体系「r8」）
// level: 20=注意報 30=警報 40=危険警報 50=特別警報
export const WARNING_CODES = {
  '10': ['大雨注意報', 20, 'レベル2'], '12': ['大雪注意報', 20], '13': ['風雪注意報', 20], '14': ['雷注意報', 20],
  '15': ['強風注意報', 20], '16': ['波浪注意報', 20], '17': ['融雪注意報', 20], '19': ['高潮注意報', 20, 'レベル2'],
  '20': ['濃霧注意報', 20], '21': ['乾燥注意報', 20], '22': ['なだれ注意報', 20], '23': ['低温注意報', 20],
  '24': ['霜注意報', 20], '25': ['着氷注意報', 20], '26': ['着雪注意報', 20], '29': ['土砂災害注意報', 20, 'レベル2'],
  '02': ['暴風雪警報', 30], '03': ['大雨警報', 30, 'レベル3'], '05': ['暴風警報', 30], '06': ['大雪警報', 30],
  '07': ['波浪警報', 30], '08': ['高潮警報', 30, 'レベル3'], '09': ['土砂災害警報', 30, 'レベル3'],
  '43': ['大雨危険警報', 40, 'レベル4'], '48': ['高潮危険警報', 40, 'レベル4'], '49': ['土砂災害危険警報', 40, 'レベル4'],
  '32': ['暴風雪特別警報', 50], '33': ['大雨特別警報', 50, 'レベル5'], '35': ['暴風特別警報', 50],
  '36': ['大雪特別警報', 50], '37': ['波浪特別警報', 50], '38': ['高潮特別警報', 50, 'レベル5'],
  '39': ['土砂災害特別警報', 50, 'レベル5'],
};

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

// ---- 地域コード表（area.json）: 1週間ローカルに保存 ----
let areaPromise;
export function loadAreas() {
  if (!areaPromise) {
    areaPromise = (async () => {
      try {
        const c = JSON.parse(localStorage.getItem('jmaArea') || 'null');
        if (c && Date.now() - c.t < 7 * 864e5) return c.d;
      } catch {}
      const d = await getJSON(`${BASE}/common/const/area.json`);
      const slim = { offices: {}, class10s: {}, class15s: {}, class20s: {} };
      for (const k of Object.keys(slim)) for (const [code, v] of Object.entries(d[k])) slim[k][code] = { name: v.name, parent: v.parent };
      try { localStorage.setItem('jmaArea', JSON.stringify({ t: Date.now(), d: slim })); } catch {}
      return slim;
    })().catch((e) => { areaPromise = null; throw e; });
  }
  return areaPromise;
}

// 市区町村コード(5桁) → 気象庁の市町村等区域コード(7桁)と府県予報区コード
export async function resolveArea(muniCd) {
  const A = await loadAreas();
  const c20 = A.class20s;
  let code = `${muniCd}00`;
  if (!c20[code]) code = Object.keys(c20).find((k) => k.startsWith(muniCd)); // 分割された市町村
  if (!code) {
    // 政令指定都市の区 → 市全体のコード（同じ都道府県内で直前のコード）
    const target = `${muniCd}00`;
    code = Object.keys(c20).filter((k) => k.slice(0, 2) === muniCd.slice(0, 2) && k <= target).sort().pop();
  }
  if (!code) return null;
  const c15 = A.class15s[c20[code].parent];
  const c10 = c15 && A.class10s[c15.parent];
  const office = c10 && c10.parent;
  return { class20: code, name: c20[code].name, office };
}

// ---- 警報・注意報 ----
export async function fetchWarnings(office, class20) {
  const data = await getJSON(`${BASE}/warning/data/r8/${office}.json`);
  const reports = Array.isArray(data) ? data : [data];
  const items = new Map();
  let latest = '';
  const headlines = new Set();
  let publishingOffice = '';
  for (const r of reports) {
    publishingOffice = r.publishingOffice || publishingOffice;
    const area = (r.warning?.class20Items || []).find((a) => a.areaCode === class20);
    if (!area) continue;
    if (r.reportDatetime > latest) latest = r.reportDatetime;
    for (const k of area.kinds || []) {
      if (!k.code || k.status === '解除') continue;
      const def = WARNING_CODES[k.code] || [`不明な情報（コード${k.code}）`, 20];
      const prev = items.get(k.code);
      if (prev && prev.reportDatetime > r.reportDatetime) continue;
      items.set(k.code, { code: k.code, name: def[0], level: def[1], lv: def[2] || '', status: k.status, reportDatetime: r.reportDatetime });
      if (r.headlineText) headlines.add(r.headlineText);
    }
  }
  return {
    reportDatetime: latest,
    publishingOffice,
    headlines: [...headlines],
    items: [...items.values()].sort((a, b) => b.level - a.level || a.code.localeCompare(b.code)),
  };
}

export function warningPageUrl(class20) {
  return `https://www.jma.go.jp/bosai/warning/#area_type=class20s&area_code=${class20}&lang=ja`;
}

// ---- 地震情報 ----
const SHINDO_RANK = { '1': 1, '2': 2, '3': 3, '4': 4, '5-': 5, '5+': 6, '6-': 7, '6+': 8, '7': 9 };
export const shindoRank = (s) => SHINDO_RANK[s] || 0;
export const shindoLabel = (s) => ({ '5-': '5弱', '5+': '5強', '6-': '6弱', '6+': '6強' }[s] || s || '―');

// "+32.3+129.7-10000/" → 深さ(km)
function depthKm(cod) {
  const m = /^[+-][\d.]+[+-][\d.]+([+-]\d+)?/.exec(cod || '');
  if (!m || m[1] == null) return null;
  return Math.abs(Number(m[1])) / 1000;
}

export async function fetchQuakes(limit = 10) {
  const list = await getJSON(`${BASE}/quake/data/list.json`);
  // 同じ地震(eid)の複数の電文をまとめる：震源のある最新電文 + 最大震度
  const groups = new Map();
  for (const q of list) {
    if (!groups.has(q.eid)) groups.set(q.eid, []);
    groups.get(q.eid).push(q);
  }
  const quakes = [];
  for (const qs of groups.values()) {
    qs.sort((a, b) => b.ctt.localeCompare(a.ctt));
    const withEpi = qs.find((q) => q.anm) || qs[0];
    const withInt = qs.find((q) => q.int && q.int.length) || null;
    const maxi = qs.map((q) => q.maxi).filter(Boolean).sort((a, b) => shindoRank(b) - shindoRank(a))[0] || '';
    quakes.push({
      eid: withEpi.eid,
      at: withEpi.at,
      place: withEpi.anm || '（震源調査中）',
      mag: withEpi.mag && withEpi.mag !== 'Ｍ不明' ? withEpi.mag : '',
      depth: depthKm(withEpi.cod),
      maxi,
      int: withInt ? withInt.int : [],
      json: withEpi.json,
      title: withEpi.ttl,
    });
    if (quakes.length >= limit) break;
  }
  quakes.sort((a, b) => b.at.localeCompare(a.at));
  // 津波の有無：詳細電文のコメントを取得
  await Promise.all(quakes.map(async (q) => {
    try {
      const d = await getJSON(`${BASE}/quake/data/${q.json}`);
      q.tsunami = d.Body?.Comments?.ForecastComment?.Text || '';
    } catch { q.tsunami = ''; }
  }));
  return quakes;
}

// 指定地点(7桁コード)・都道府県の震度を探す
export function localIntensity(q, class20) {
  if (!class20) return null;
  const pref = q.int.find((p) => p.code === class20.slice(0, 2));
  if (!pref) return null;
  const city = (pref.city || []).find((c) => c.code === class20);
  return { pref: pref.maxi, city: city ? city.maxi : null };
}

// ---- 動作確認用のダミーデータ（URLに ?demo=1 を付けると使用）----
export function demoWarnings() {
  const t = new Date().toISOString();
  return {
    reportDatetime: t,
    publishingOffice: '（ダミー）',
    headlines: ['【動作確認用のダミーデータです】土砂災害や河川の増水に警戒してください。'],
    items: [
      { code: '43', name: '大雨危険警報', level: 40, lv: 'レベル4', status: '発表', reportDatetime: t },
      { code: '05', name: '暴風警報', level: 30, status: '継続', reportDatetime: t },
      { code: '14', name: '雷注意報', level: 20, status: '継続', reportDatetime: t },
    ],
  };
}
export function demoQuake(class20) {
  const at = new Date(Date.now() - 10 * 60e3);
  const iso = new Date(at.getTime() + 9 * 3600e3).toISOString().slice(0, 19) + '+09:00';
  return {
    eid: 'demo', at: iso, place: '（ダミー）埼玉県北部', mag: '5.6', depth: 10, maxi: '5-',
    int: [{ code: (class20 || '11').slice(0, 2), maxi: '5-', city: [{ code: class20, maxi: '4' }] }],
    tsunami: 'この地震による津波の心配はありません。（ダミー）', title: '震源・震度情報',
  };
}
