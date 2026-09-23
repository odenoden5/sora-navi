// 服装のめやす：最高・最低気温と、雨・風・雪などから「何を着ればよいか」を組み立てる

const LEVELS = [
  { min: 33, icon: '🥵', title: '半袖＋日よけ', wear: 'ノースリーブや半袖など、できるだけ涼しい服装' },
  { min: 28, icon: '👕', title: '半袖', wear: '半袖のシャツやTシャツ' },
  { min: 25, icon: '👕', title: '半袖', wear: '半袖。朝晩は薄手の羽織りがあると安心' },
  { min: 22, icon: '👚', title: '半袖〜薄手の長袖', wear: '半袖か、薄手の長袖シャツ' },
  { min: 19, icon: '🧥', title: '長袖シャツ', wear: '長袖のシャツやカットソー' },
  { min: 16, icon: '🧥', title: '長袖＋羽織り', wear: '長袖に、カーディガンや薄手のジャケット' },
  { min: 12, icon: '🧥', title: 'ジャケット', wear: 'ジャケットやパーカーなど、しっかりした上着' },
  { min: 8, icon: '🧣', title: 'コート', wear: '薄手のコート。中は重ね着で調節' },
  { min: 4, icon: '🧣', title: '厚手のコート', wear: '厚手のコートにマフラー' },
  { min: -99, icon: '🧤', title: 'ダウン・防寒', wear: 'ダウンなどの防寒着に、手袋・マフラー・ニット帽' },
];

// day: buildModel の today / tomorrow
export function clothing(day) {
  if (!day) return null;
  const hi = day.feelsMax > -90 ? Math.max(day.max.temp, day.feelsMax - 2) : day.max.temp;
  const lv = LEVELS.find((l) => hi >= l.min);
  const tips = [];

  const gap = day.max.temp - day.min.temp;
  if (gap >= 10) tips.push(`日中と朝晩の気温差が${Math.round(gap)}℃。脱ぎ着しやすい重ね着がおすすめ`);
  else if (day.min.temp <= 12 && day.max.temp >= 20) tips.push('朝晩は冷えるので、羽織るものを1枚');

  if (day.feelsMax >= day.max.temp + 2 && day.max.temp >= 28) tips.push('蒸し暑く感じます。汗を吸いやすい服が快適');
  if (day.max.temp >= 30) tips.push('熱中症に注意。帽子と水分を忘れずに');
  if (day.min.temp <= 3) tips.push('路面の凍結に注意。滑りにくい靴で');

  if (day.umbrella.length) tips.push('雨に備えて、傘とぬれてもよい靴を');
  if ((day.mm ?? 0) >= 10) tips.push('雨が強い時間あり。レインコートや防水の上着が安心');
  if ((day.snowfall ?? 0) > 0) tips.push('雪の予想。防水で滑りにくい靴、手袋を');
  if ((day.ws ?? 0) >= 8) tips.push(`風が強い予想（最大${Math.round(day.ws)}m/s）。風を通しにくい上着を`);
  if ((day.uv ?? 0) >= 6) tips.push(`紫外線が強め（UV指数${Math.round(day.uv)}）。日焼け止めやサングラスを`);
  if ((day.rhMax ?? 0) <= 40 && day.max.temp <= 20) tips.push('空気が乾いています。のどや肌の乾燥対策を');

  return { icon: lv.icon, title: lv.title, wear: lv.wear, tips: tips.slice(0, 3) };
}
