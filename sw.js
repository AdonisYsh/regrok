/*
 * sw.js — offline support. Cache-first for the app shell: after one online
 * visit, regrok runs with zero network (matching was already local anyway).
 * Bump VERSION whenever any asset changes so returning visitors update.
 */
'use strict';

var VERSION = 'regrok-v1';
var ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'ai.js',
  'grok.js',
  'dissect.js',
  'worker.js',
  'manifest.webmanifest',
  'icon.svg',
  'vendor/onig.js',
  'vendor/onig.wasm',
  'vendor/patterns.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION)
      .then(function (c) { return c.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  // Only handle same-origin GETs; AI API calls pass straight through.
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        // only cache real, same-origin successes — a cached 404/opaque
        // response would break the app permanently for offline users
        if (res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      });
    })
  );
});
