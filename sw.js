const CACHE_NAME = "mentora-edge-v1";

const ASSETS_TO_CACHE = [
  "/",
  "/index.html",
  "/login.html",
  "/signup.html",
  "/dashboard.html",
  "/admin.html",
  "/manifest.json",
  "/favicon.ico",
  "/icons/android/android-launchericon-192-192.png"
];

// Install
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activate
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
});

// Fetch
self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});