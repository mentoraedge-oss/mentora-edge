// js/firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
export const auth = getAuth(app);
export const db = getFirestore(app);
