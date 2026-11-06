/* Service worker: keeps the app shell and the activity list available offline.
   Lesson data is NEVER cached here: it lives in the app's own storage and the sync queue. */
var CACHE = 'stemmate-shell-v2';
var SHELL = ['/', '/index.html', '/app.js', '/stemmate-client.js', '/styles.css', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;               // API calls always go to the network
  e.respondWith(
    fetch(req).then(function (res) {                                // network first so updates arrive; cache is the fallback
      if (res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
      return res;
    }).catch(function () { return caches.match(req).then(function (hit) { return hit || caches.match('/index.html'); }); })
  );
});
