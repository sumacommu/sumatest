const { getFirestore, collection, getDocs, updateDoc } = require('firebase/firestore');
const { initializeApp } = require('firebase/app');
require('dotenv').config();

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function migrateRatings() {
  const usersRef = collection(db, 'users');
  const usersSnapshot = await getDocs(usersRef);
  
  for (const userDoc of usersSnapshot.docs) {
    const userData = userDoc.data();
    if (userData.rating !== undefined) {
      await updateDoc(userDoc.ref, {
        soloRating: userData.rating,
        teamRating: 1500,
        rating: null // フィールドを削除する代わりにnullを設定（クライアントSDKでは削除が直接できない）
      });
      console.log(`ユーザー ${userDoc.id} のレーティングを移行しました`);
    }
  }
  console.log('移行完了');
  process.exit(0);
}

migrateRatings().catch(console.error);