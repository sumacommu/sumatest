const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc } = require('firebase/firestore');
require('dotenv').config();

const app = express();

// Firebase初期化
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// Express設定
app.use(express.static(__dirname));
app.use(session({ secret: 'your-secret-key', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

// Google認証
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://sumatest.vercel.app/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const userRef = doc(db, 'users', profile.id);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      console.log(`新規ユーザー作成: ${profile.id}`);
      await setDoc(userRef, {
        displayName: profile.displayName,
        email: profile.emails[0].value,
        photoUrl: profile.photos[0].value,
        createdAt: new Date().toISOString(),
        matchCount: 0,
        reportCount: 0,
        validReportCount: 0,
        penalty: false
      });
      console.log(`ユーザー作成完了: ${profile.id}`);
    }
    return done(null, profile);
  } catch (error) {
    console.error('認証エラー:', error.message, error.stack);
    return done(error);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const userSnap = await getDoc(doc(db, 'users', id));
    if (!userSnap.exists()) {
      console.error(`ユーザー見つからず: ${id}`);
      return done(new Error('ユーザーが見つかりません'));
    }
    done(null, userSnap.data());
  } catch (error) {
    console.error('deserializeUserエラー:', error.message, error.stack);
    done(error);
  }
});

// ルート
app.get('/', async (req, res) => {
  try {
    if (req.user) {
      const userData = req.user;
      res.send(`
        <h1>こんにちは、${userData.displayName}さん！</h1>
        <img src="${userData.photoUrl}" alt="プロフィール画像" width="50">
      `);
    } else {
      res.send('<a href="/auth/google">Googleでログイン</a>');
    }
  } catch (error) {
    console.error('ルートエラー:', error.message, error.stack);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => {
  console.log('コールバック成功、リダイレクト');
  res.redirect('/');
});

app.listen(3000, () => console.log('サーバー起動: http://localhost:3000'));