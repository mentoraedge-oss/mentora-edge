// js/firebase.js
import { getMessaging } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const recaptchaEnterpriseSiteKey = "6Le1a0AtAAAAAAEm0g4kB2t8UK-3pdbR2UUrwFvEU";

const firebaseConfig = {
  apiKey: "AIzaSyDZWCwwfmK7vh4J-IhF1vSZonQJ-M6Rp1U",
  authDomain: "mentora-edge-v2.firebaseapp.com",
  projectId: "mentora-edge-v2",
  storageBucket: "mentora-edge-v2.firebasestorage.app",
  messagingSenderId: "50060226110",
  appId: "1:50060226110:web:15d89fdc433f9f70876b6f"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);

// Use Firebase's debug provider only on local development hosts.
if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(globalThis.location?.hostname)) {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

// Initialize App Check before any Firebase services are created.
export const appCheck = initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(recaptchaEnterpriseSiteKey),
  isTokenAutoRefreshEnabled: true
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const messaging = getMessaging(app);
