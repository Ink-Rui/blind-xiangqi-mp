/**
 * 盲下象棋 · 离线缓存
 * 静态资源 cache-first；页面与配置 network-first，保证更新能及时生效。
 * 修改缓存清单或策略时请同步提升 VERSION。
 */
const VERSION = 'blind-xiangqi-v3';
const ASSETS = [
  './index.html',
  './assets/style.css',
  './assets/app.js',
  './assets/engine.js',
  './assets/net.js',
  './assets/rules.js',
  './assets/stats.js',
  './manifest.webmanifest',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // 逐个缓存，单个资源失败不影响整体安装
    await Promise.all(ASSETS.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 页面导航与配置：先取网络，断网时回落缓存
  const networkFirst = req.mode === 'navigate' || url.pathname.endsWith('/assets/config.js');
  if (networkFirst) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put(req, fresh.clone());
        return fresh;
      } catch (err) {
        const cache = await caches.open(VERSION);
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const fallback = await cache.match('./index.html');
          if (fallback) return fallback;
        }
        throw err;
      }
    })());
    return;
  }

  // 其余静态资源：先给缓存，同时在后台拉取新版本回填（下次加载即生效）
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req);
    const network = fetch(req)
      .then((fresh) => {
        if (fresh.ok) cache.put(req, fresh.clone());
        return fresh;
      })
      .catch(() => null);
    if (hit) {
      network.catch(() => {});
      return hit;
    }
    const fresh = await network;
    if (fresh) return fresh;
    throw new Error('offline');
  })());
});
