import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyD-xdOu25CmwRSaIvzZ8lUqiZ0o7YYztmU",
  authDomain: "my-baby-tracker-fdb2a.firebaseapp.com",
  projectId: "my-baby-tracker-fdb2a",
  storageBucket: "my-baby-tracker-fdb2a.firebasestorage.app",
  messagingSenderId: "328155700066",
  appId: "1:328155700066:web:d013d4d53df22b1906aa3b",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);