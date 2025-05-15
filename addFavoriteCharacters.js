const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, updateDoc, doc } = require('firebase/firestore');

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

async function addFavoriteCharacters() {
  const usersRef = collection(db, 'users');
  const usersSnapshot = await getDocs(usersRef);
  for (const userDoc of usersSnapshot.docs) {
    await updateDoc(doc(db, 'users', userDoc.id), {
      favoriteCharacters: []
    });
    console.log(`Updated user ${userDoc.id}`);
  }
  console.log('All users updated');
}

addFavoriteCharacters().then(() => process.exit());