// アプリ本体をキャッシュしてオフラインでも起動できるようにする。
// 気象データ（外部API）はキャッシュせず、アプリ側で前回データを保存して表示する。
const VERSION = 'v1.5.0';
const SHELL = [
  './', 'index.html', 'style.css?v=1.5.0', 'app.js?v=1.5.0', 'weather.js?v=1.5.0', 'jma.js?v=1.5.0',
  'geo.js?v=1.5.0', 'radar.js?v=1.5.0', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同一オリジンのファイル：ネット優先（ブラウザのHTTPキャッシュも使わず最新を確認）、失敗したらキャッシュ
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match(e.request, { ignoreSearch: true }))),
  );
});
