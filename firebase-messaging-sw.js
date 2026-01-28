importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

/* Firebase configuration */
firebase.initializeApp({
  apiKey: "AIzaSyDZWcwwfmK7vh4J-IhF1vSZonQJ-M6Rp1U",
  authDomain: "mentora-edge-v2.firebaseapp.com",
  projectId: "mentora-edge-v2",
  storageBucket: "mentora-edge-v2.appspot.com",
  messagingSenderId: "50060226110",
  appId: "1:50060226110:web:15d89fdc433f9f70876b6f"
});

/* Initialize messaging */
const messaging = firebase.messaging();

/* Handle background notifications */
messaging.onBackgroundMessage((payload) => {
  console.log("[Service Worker] Background message received:", payload);

  const notificationTitle = payload.notification?.title || "Mentora Edge";
  const notificationOptions = {
    body: payload.notification?.body || "New update available",
    icon: "/icons/android/android-launchericon-192-192.png",
    badge: "/icons/android/android-launchericon-96-96.png",
    data: {
      url: "/" // where app opens on click
    }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

/* Handle notification click */
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url || "/")
  );
});