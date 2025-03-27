const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, collection, query, where, getDocs, addDoc, updateDoc } = require('firebase/firestore');
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
app.use(express.urlencoded({ extended: true })); // POST用
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7日有効
}));
app.use(passport.initialize());
app.use(passport.session());

// Google認証
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://sumatest.vercel.app/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  console.log('Google認証開始:', { clientID: process.env.GOOGLE_CLIENT_ID, callbackURL: 'https://sumatest.vercel.app/auth/google/callback' });
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
        penalty: false,
        rating: 1500 // 初期レート
      });
      console.log(`ユーザー作成完了: ${profile.id}`);
    }
    console.log('プロフィール取得成功:', profile.id);
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
    const userData = userSnap.data();
    userData.id = id; // IDを追加
    done(null, userData);
  } catch (error) {
    console.error('deserializeUserエラー:', error.message, error.stack);
    done(error);
  }
});

// ルート（トップページ）
app.get('/', async (req, res) => {
  try {
    if (req.user) {
      const userData = req.user;
      res.send(`
        <html>
          <body>
            <h1>こんにちは、${userData.displayName}さん！</h1>
            <img src="${userData.photoUrl}" alt="プロフィール画像" width="50">
            <p><a href="/solo">タイマン用</a></p>
            <p><a href="/team">チーム用</a></p>
            <p><a href="/logout">ログアウト</a></p>
          </body>
        </html>
      `);
    } else {
      res.send(`
        <html>
          <body>
            <h1>スマブラマッチング</h1>
            <p><a href="/solo">タイマン用</a></p>
            <p><a href="/team">チーム用</a></p>
            <p><a href="/auth/google">Googleでログイン</a></p>
          </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('ルートエラー:', error.message, error.stack);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

// Google認証ルート
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/' }), (req, res) => {
  console.log('コールバック成功、リダイレクト');
  res.redirect('/');
});

// ログアウトルート
app.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      console.error('ログアウトエラー:', err);
      return res.status(500).send('ログアウトに失敗しました');
    }
    req.session.destroy((err) => {
      if (err) {
        console.error('セッション破棄エラー:', err);
        return res.status(500).send('セッション破棄に失敗しました');
      }
      console.log('ログアウト成功');
      res.redirect('/');
    });
  });
});

// タイマン用ページ
app.get('/solo', async (req, res) => {
  try {
    const matchesRef = collection(db, 'matches');
    const waitingQuery = query(matchesRef, where('type', '==', 'solo'), where('status', '==', 'waiting'));
    const waitingSnapshot = await getDocs(waitingQuery);
    const waitingCount = waitingSnapshot.size;

    let html = `
      <html>
        <body>
          <h1>タイマン用ページ</h1>
          <p>待機中: ${waitingCount}人</p>
    `;
    if (req.user) {
      const rating = req.user.rating || 1500;
      html += `
        <form action="/solo/match" method="POST">
          <label>専用部屋ID（任意）: <input type="text" name="roomId"></label>
          <button type="submit">マッチング開始</button>
        </form>
        <p>現在のレート: ${rating}</p>
      `;
    } else {
      html += `<p>マッチングするには<a href="/auth/google">ログイン</a>してください</p>`;
    }
    html += `<p><a href="/">戻る</a></p></body></html>`;
    res.send(html);
  } catch (error) {
    console.error('タイマン用ページエラー:', error.message, error.stack);
    res.status(500).send('エラーが発生しました');
  }
});

// タイマン用マッチング処理
app.post('/solo/match', async (req, res) => {
  if (!req.user || !req.user.id) {
    console.error('ユーザー情報が不正:', req.user);
    return res.redirect('/solo');
  }
  const userId = req.user.id;
  const userRating = req.user.rating || 1500;
  const roomId = req.body.roomId || ''; // 専用部屋ID

  try {
    const matchesRef = collection(db, 'matches');
    const waitingQuery = query(
      matchesRef,
      where('type', '==', 'solo'),
      where('status', '==', 'waiting'),
      where('userId', '!=', userId)
    );
    const waitingSnapshot = await getDocs(waitingQuery);

    let matched = false;
    for (const docSnap of waitingSnapshot.docs) {
      const opponentData = docSnap.data();
      const opponentRef = doc(db, 'users', opponentData.userId);
      const opponentSnap = await getDoc(opponentRef);
      const opponentRating = opponentSnap.exists() ? (opponentSnap.data().rating || 1500) : 1500;
      if (Math.abs(userRating - opponentRating) <= 200) {
        await updateDoc(docSnap.ref, { 
          status: 'matched', 
          opponentId: userId,
          opponentRoomId: roomId // 自分のIDを相手に渡す
        });
        await addDoc(matchesRef, {
          userId: userId,
          type: 'solo',
          status: 'matched',
          opponentId: opponentData.userId,
          roomId: roomId, // 自分のIDを保存
          opponentRoomId: opponentData.roomId || '', // 相手のID
          timestamp: new Date().toISOString()
        });
        matched = true;
        res.send(`
          <html>
            <body>
              <h1>マッチング成立！</h1>
              <p>相手が見つかりました！レート: ${opponentRating}</p>
              <p>相手の専用部屋ID: ${opponentData.roomId || '未設定'}</p>
              <p>あなたの専用部屋ID: ${roomId || '未設定'}</p>
              <p><a href="/solo">戻る</a></p>
            </body>
          </html>
        `);
        break;
      }
    }

    if (!matched) {
      await addDoc(matchesRef, {
        userId: userId,
        type: 'solo',
        status: 'waiting',
        roomId: roomId, // 待機時にID保存
        timestamp: new Date().toISOString()
      });
      res.send(`
        <html>
          <body>
            <h1>マッチング待機中</h1>
            <p>相手を待っています... あなたのレート: ${userRating}</p>
            <p>専用部屋ID: ${roomId || '未設定'}</p>
            <p><a href="/solo">更新</a></p>
            <p><a href="/">戻る</a></p>
          </body>
        </html>
      `);
    }
  } catch (error) {
    console.error('マッチングエラー:', error.message, error.stack);
    res.send(`
      <html>
        <body>
          <h1>マッチングに失敗しました</h1>
          <p>エラー: ${error.message}</p>
          <p><a href="/solo">戻る</a></p>
        </body>
      </html>
    `);
  }
});

// チーム用ページ（仮）
app.get('/team', async (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>チーム用ページ</h1>
        <p>準備中です</p>
        <p><a href="/">戻る</a></p>
      </body>
    </html>
  `);
});

app.listen(3000, () => console.log('サーバー起動: http://localhost:3000'));