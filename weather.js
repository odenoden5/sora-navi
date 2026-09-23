// Open-Meteo からの予報取得と、画面表示用データへの整形

const HOURLY = [
  'weather_code', 'temperature_2m', 'precipitation_probability', 'precipitation',
  'relative_humidity_2m', 'wind_speed_10m', 'wind_direction_10m', 'is_day',
  'snow_depth', 'sunshine_duration', 'uv_index', 'apparent_temperature',
];
const DAILY = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max',
  'precipitation_sum', 'wind_speed_10m_max', 'wind_direction_10m_dominant',
  'sunshine_duration', 'snowfall_sum', 'uv_index_max',
];

export async function fetchForecast(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: HOURLY.join(','),
    daily: DAILY.join(','),
    timezone: 'Asia/Tokyo',
    wind_speed_unit: 'ms',
    forecast_days: '16',
    past_days: '1',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
  if (!res.ok) throw new Error(`天気予報の取得に失敗しました (${res.status})`);
  return res.json();
}

// WMO天気コード → [日本語, 絵文字(予備), アイコン名(昼), アイコン名(夜), 空の種類]
// アイコン名は Meteocons (@bybas/weather-icons, MIT) のファイル名。'*' は -day / -night に置き換える
const WMO = {
  0: ['快晴', '☀️', 'clear-*', 'clear'], 1: ['晴れ', '🌤️', 'partly-cloudy-*', 'clear'],
  2: ['晴れ時々くもり', '⛅', 'partly-cloudy-*', 'partly'], 3: ['くもり', '☁️', 'overcast-*', 'cloudy'],
  45: ['霧', '🌫️', 'fog-*', 'cloudy'], 48: ['霧（着氷）', '🌫️', 'fog-*', 'cloudy'],
  51: ['弱い霧雨', '🌦️', 'partly-cloudy-*-drizzle', 'rain'], 53: ['霧雨', '🌦️', 'drizzle', 'rain'], 55: ['強い霧雨', '🌧️', 'drizzle', 'rain'],
  56: ['着氷性の霧雨', '🌧️', 'sleet', 'rain'], 57: ['強い着氷性の霧雨', '🌧️', 'sleet', 'rain'],
  61: ['小雨', '🌧️', 'partly-cloudy-*-rain', 'rain'], 63: ['雨', '🌧️', 'rain', 'rain'], 65: ['強い雨', '🌧️', 'rain', 'storm'],
  66: ['着氷性の雨', '🌧️', 'sleet', 'rain'], 67: ['強い着氷性の雨', '🌧️', 'sleet', 'rain'],
  71: ['小雪', '🌨️', 'partly-cloudy-*-snow', 'snow'], 73: ['雪', '🌨️', 'snow', 'snow'], 75: ['大雪', '❄️', 'snow', 'snow'], 77: ['霧雪', '🌨️', 'snow', 'snow'],
  80: ['にわか雨', '🌦️', 'partly-cloudy-*-rain', 'rain'], 81: ['強いにわか雨', '🌧️', 'rain', 'rain'], 82: ['激しいにわか雨', '⛈️', 'thunderstorms-rain', 'storm'],
  85: ['にわか雪', '🌨️', 'partly-cloudy-*-snow', 'snow'], 86: ['強いにわか雪', '❄️', 'snow', 'snow'],
  95: ['雷雨', '⛈️', 'thunderstorms-*-rain', 'storm'], 96: ['ひょうを伴う雷雨', '⛈️', 'hail', 'storm'], 99: ['激しいひょうを伴う雷雨', '⛈️', 'hail', 'storm'],
};

export function wmo(code, isDay = 1) {
  const e = WMO[code] || ['不明', '❔', 'not-available', 'cloudy'];
  const icon = e[2].replace('*', isDay ? 'day' : 'night');
  let sky = e[3];
  if (!isDay) sky = sky === 'clear' || sky === 'partly' ? 'night' : sky === 'snow' ? 'night-snow' : 'night-cloudy';
  return { label: e[0], emoji: e[1], icon, sky };
}

const DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
export const windDir = (deg) => (deg == null ? '―' : DIRS[Math.round(deg / 22.5) % 16]);

// 日本時間の「今」を 'YYYY-MM-DD' と時(0-23)で返す
export function jstNow() {
  const s = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).format(new Date());
  return { date: s.slice(0, 10), hour: Number(s.slice(11, 13)) };
}

export function isUmbrella(pop, mm, s) {
  return (pop ?? 0) >= s.umbrellaPop || (mm ?? 0) >= s.umbrellaMm;
}

// 連続する時刻を「15時〜21時」の範囲にまとめる（hours は昇順の時）
export function hourRanges(hours) {
  const out = [];
  for (const h of hours) {
    const last = out[out.length - 1];
    if (last && last[1] === h) last[1] = h + 1;
    else out.push([h, h + 1]);
  }
  return out.map(([a, b]) => `${a}時〜${b}時`);
}

export function buildModel(raw, settings) {
  const now = jstNow();
  const H = raw.hourly;
  const hourly = H.time.map((t, i) => ({
    date: t.slice(0, 10),
    hour: Number(t.slice(11, 13)),
    code: H.weather_code[i],
    temp: H.temperature_2m[i],
    pop: H.precipitation_probability[i],
    mm: H.precipitation[i],
    rh: H.relative_humidity_2m[i],
    ws: H.wind_speed_10m[i],
    wd: H.wind_direction_10m[i],
    isDay: H.is_day[i],
    snow: H.snow_depth[i] == null ? null : H.snow_depth[i] * 100, // m → cm
    sun: H.sunshine_duration[i], // 秒
    uv: H.uv_index[i],
    feels: H.apparent_temperature[i],
  }));
  for (const h of hourly) h.umbrella = isUmbrella(h.pop, h.mm, settings);

  const byDate = new Map();
  for (const h of hourly) {
    if (!byDate.has(h.date)) byDate.set(h.date, []);
    byDate.get(h.date).push(h);
  }

  const D = raw.daily;
  const daily = D.time.map((date, i) => ({
    date,
    code: D.weather_code[i],
    tmax: D.temperature_2m_max[i],
    tmin: D.temperature_2m_min[i],
    pop: D.precipitation_probability_max[i],
    mm: D.precipitation_sum[i],
    ws: D.wind_speed_10m_max[i],
    wd: D.wind_direction_10m_dominant[i],
    sunH: D.sunshine_duration[i] == null ? null : D.sunshine_duration[i] / 3600,
    snowfall: D.snowfall_sum[i],
    uv: D.uv_index_max[i],
  }));
  for (const d of daily) d.umbrella = (d.pop ?? 0) >= settings.umbrellaPop || (d.mm ?? 0) >= 1;

  const summarize = (date) => {
    const hs = byDate.get(date) || [];
    if (!hs.length) return null;
    let max = hs[0], min = hs[0];
    for (const h of hs) {
      if (h.temp > max.temp) max = h;
      if (h.temp < min.temp) min = h;
    }
    const blocks = [0, 6, 12, 18].map((s) => {
      const b = hs.filter((h) => h.hour >= s && h.hour < s + 6);
      return { label: `${s}-${s + 6}`, pop: b.length ? Math.max(...b.map((h) => h.pop ?? 0)) : null, past: date === now.date && s + 6 <= now.hour };
    });
    const upcoming = date === now.date ? hs.filter((h) => h.hour >= now.hour) : hs;
    const umbrellaHours = upcoming.filter((h) => h.umbrella).map((h) => h.hour);
    const d = daily.find((x) => x.date === date) || {};
    const rhs = hs.map((h) => h.rh);
    return {
      date,
      code: d.code ?? hs[12]?.code,
      max: { temp: max.temp, hour: max.hour },
      min: { temp: min.temp, hour: min.hour },
      blocks,
      umbrella: hourRanges(umbrellaHours),
      mm: hs.reduce((a, h) => a + (h.mm ?? 0), 0),
      sunH: d.sunH,
      snow: Math.max(...hs.map((h) => h.snow ?? 0)),
      snowfall: d.snowfall,
      uv: d.uv,
      feelsMax: Math.max(...hs.map((h) => h.feels ?? -99)),
      feelsMin: Math.min(...hs.map((h) => h.feels ?? 99)),
      rhMin: Math.min(...rhs),
      rhMax: Math.max(...rhs),
      ws: Math.max(...hs.map((h) => h.ws ?? 0)),
      wd: d.wd,
    };
  };

  const addDays = (date, n) => {
    const t = new Date(`${date}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  const yesterday = summarize(addDays(now.date, -1));
  const today = summarize(now.date);
  const tomorrow = summarize(addDays(now.date, 1));
  if (today && yesterday) { today.maxDiff = today.max.temp - yesterday.max.temp; today.minDiff = today.min.temp - yesterday.min.temp; }
  if (tomorrow && today) { tomorrow.maxDiff = tomorrow.max.temp - today.max.temp; tomorrow.minDiff = tomorrow.min.temp - today.min.temp; }

  const startIdx = hourly.findIndex((h) => h.date === now.date && h.hour === now.hour);
  const next48 = hourly.slice(Math.max(0, startIdx), Math.max(0, startIdx) + 48);
  const current = hourly[startIdx] || next48[0];

  return {
    now,
    current,
    today,
    tomorrow,
    hourly: next48,
    daily: daily.filter((d) => d.date >= now.date),
  };
}
