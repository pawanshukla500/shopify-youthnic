// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDpVy2GG4lCF6YUssk00qlwgeK6Cqe4xQQ",
  authDomain: "shopify-134b9.firebaseapp.com",
  databaseURL: "https://shopify-134b9-default-rtdb.firebaseio.com",
  projectId: "shopify-134b9",
  storageBucket: "shopify-134b9.firebasestorage.app",
  messagingSenderId: "937847166333",
  appId: "1:937847166333:web:deb24337bd5fa1d3da2814",
  measurementId: "G-JGW7Z2788F"
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
export const analytics = typeof window !== 'undefined' ? getAnalytics(app) : null;
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
