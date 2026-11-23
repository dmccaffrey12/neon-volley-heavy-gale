const CACHE_NAME = 'summer-heat-3d-v2';

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './vendor/three.module.min.js',
  './src/contracts.js',
  './src/physics3d.js',
  './src/playerRigs.js',
  './src/courtScene.js',
  './src/inputManager.js',
  './src/rallyEngine.js',
  './src/audioSynth.js',
  './src/main.js',
  './classic-2d/',
  './classic-2d/index.html',
  './classic-2d/game.js',
  './classic-2d/manifest.json',
];

function isCacheableResponse(response) {
  return Boolean(
    response &&
    response.status === 200 &&
    (response.type === 'basic' || response.type === 'default' || !response.type),
  );
}

function getOfflineFallback(request, reqUrl) {
  if (request.mode === 'navigate' || request.destination === 'document') {
    if (
      reqUrl &&
      typeof reqUrl.pathname === 'string' &&
      /(?:^|\/)classic-2d$/.test(reqUrl.pathname)
    ) {
      const redirectUrl = `${reqUrl.origin}${reqUrl.pathname}/${reqUrl.search || ''}`;
      if (typeof Response !== 'undefined' && typeof Response.redirect === 'function') {
        return Promise.resolve(Response.redirect(redirectUrl, 302));
      }
      return Promise.resolve(new Response(null, { status: 302, headers: { Location: redirectUrl } }));
    }
    const isClassic2D =
      reqUrl &&
      typeof reqUrl.pathname === 'string' &&
      /(?:^|\/)classic-2d(?:\/|$)/.test(reqUrl.pathname);
    const fallbackUrl = isClassic2D ? './classic-2d/index.html' : './index.html';
    return caches.match(fallbackUrl).then((matched) => {
      if (matched) {
        return matched;
      }
      return caches.match('./index.html').then(
        (rootMatched) => rootMatched || new Response('Offline', { status: 503, statusText: 'Offline' }),
      );
    });
  }
  return Promise.resolve(new Response('Offline', { status: 503, statusText: 'Offline' }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!request || request.method !== 'GET') {
    return;
  }

  if (request.headers && typeof request.headers.has === 'function' && request.headers.has('range')) {
    return;
  }

  let reqUrl;
  try {
    reqUrl = new URL(request.url, self.location ? self.location.href : undefined);
  } catch {
    return;
  }

  if (reqUrl.protocol !== 'http:' && reqUrl.protocol !== 'https:') {
    return;
  }

  if (self.location && self.location.origin && reqUrl.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cachedResponse) => {
      let cacheWritePromise = Promise.resolve();
      const networkUpdate = fetch(request).then((networkResponse) => {
        if (isCacheableResponse(networkResponse)) {
          const clone = networkResponse.clone();
          cacheWritePromise = caches
            .open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .catch(() => {});
        }
        return networkResponse;
      });

      if (cachedResponse) {
        const bgRevalidate = networkUpdate
          .then(() => cacheWritePromise)
          .catch(() => undefined);
        if (typeof event.waitUntil === 'function') {
          event.waitUntil(bgRevalidate);
        }
        return cachedResponse;
      }

      return networkUpdate
        .then((resp) => {
          if (typeof event.waitUntil === 'function') {
            event.waitUntil(cacheWritePromise);
          }
          return resp;
        })
        .catch(() => getOfflineFallback(request, reqUrl));
    }),
  );
});
