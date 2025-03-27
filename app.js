const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, collection, query, where, getDocs, addDoc, updateDoc, deleteDoc } = require('firebase/firestore');
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
app.use(express.static('public'));

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

// マッチング状態チェック用ルート
app.get('/solo/check', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/solo');
  }
  const userId = req.user.id;
  const matchesRef = collection(db, 'matches');
  const userMatchQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'matched'));
  const userMatchSnapshot = await getDocs(userMatchQuery);

  if (!userMatchSnapshot.empty) {
    const matchData = userMatchSnapshot.docs[0].data();
    const opponentRef = doc(db, 'users', matchData.opponentId);
    const opponentSnap = await getDoc(opponentRef);
    const opponentName = opponentSnap.data().displayName || '不明';
    const opponentRating = opponentSnap.data().rating || 1500;
    res.send(`
      <html>
        <body>
          <h1>マッチング成立！</h1>
          <p>相手: ${opponentName} (レート: ${opponentRating})</p>
          <p>相手の専用部屋ID: ${matchData.opponentRoomId || '未設定'}</p>
          <p><a href="/solo">戻る</a></p>
        </body>
      </html>
    `);
  } else {
    const waitingQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'waiting'));
    const waitingSnapshot = await getDocs(waitingQuery);
    const roomId = waitingSnapshot.empty ? '' : waitingSnapshot.docs[0].data().roomId;
    res.send(`
      <html>
        <body>
          <h1>マッチング待機中</h1>
          <p>相手を待っています... あなたのレート: ${req.user.rating || 1500}</p>
          <form action="/solo/update" method="POST">
            <label>専用部屋ID: <input type="text" name="roomId" value="${roomId}"></label>
            <button type="submit">IDを設定して更新</button>
          </form>
          <p><a href="/solo/cancel">キャンセル</a></p>
        </body>
      </html>
    `);
  }
});

// 待機キャンセルルート
app.get('/solo/cancel', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/solo');
  }
  const userId = req.user.id;
  const matchesRef = collection(db, 'matches');
  const waitingQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'waiting'));
  const waitingSnapshot = await getDocs(waitingQuery);

  try {
    waitingSnapshot.forEach(async (docSnap) => {
      await deleteDoc(docSnap.ref);
    });
    res.redirect('/solo');
  } catch (error) {
    console.error('キャンセルエラー:', error.message, error.stack);
    res.send(`
      <html>
        <body>
          <h1>キャンセルに失敗しました</h1>
          <p>エラー: ${error.message}</p>
          <p><a href="/solo">戻る</a></p>
        </body>
      </html>
    `);
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
      if (Math.abs(userRating - opponentRating) <= 200 && opponentData.roomId) {
        const matchId = docSnap.id; // 待機側のドキュメントIDを使用
        await updateDoc(docSnap.ref, { 
          status: 'matched', 
          opponentId: userId
        });
        const newMatchDoc = await addDoc(matchesRef, {
          userId: userId,
          type: 'solo',
          status: 'matched',
          opponentId: opponentData.userId,
          roomId: '',
          opponentRoomId: opponentData.roomId,
          timestamp: new Date().toISOString()
        });
        matched = true;
        res.redirect(`/solo/setup/${newMatchDoc.id}`); // 新しいマッチIDでリダイレクト
        break;
      }
    }

    if (!matched) {
      await addDoc(matchesRef, {
        userId: userId,
        type: 'solo',
        status: 'waiting',
        roomId: '',
        timestamp: new Date().toISOString()
      });
      res.redirect('/solo/check');
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

// セットアップ画面
app.get('/solo/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  if (!userId) {
    return res.redirect('/solo');
  }

  const matchRef = doc(db, 'matches', matchId);
  const matchSnap = await getDoc(matchRef);
  if (!matchSnap.exists() || (matchSnap.data().userId !== userId && matchSnap.data().opponentId !== userId)) {
    return res.send('マッチが見つかりません');
  }

  const matchData = matchSnap.data();
  const opponentId = matchData.userId === userId ? matchData.opponentId : matchData.userId;
  const opponentRef = doc(db, 'users', opponentId);
  const opponentSnap = await getDoc(opponentRef);
  const opponentName = opponentSnap.data().displayName || '不明';
  const opponentRating = opponentSnap.data().rating || 1500;

  res.send(`
    <html>
      <body>
        <h1>マッチング成立！</h1>
        <p>相手: ${opponentName} (レート: ${opponentRating})</p>
        <p>相手の専用部屋ID: ${matchData.opponentRoomId || '未設定'}</p>
        <h2>キャラクター選択</h2>
        <form action="/solo/setup/${matchId}" method="POST">
          <button type="submit" name="character" value="mario"><img src="/characters/mario.png" width="64" height="64">マリオ</button>
          <button type="submit" name="character" value="link"><img src="/characters/link.png" width="64" height="64">リンク</button>
          <button type="submit" name="character" value="mii_fighter"><img src="/characters/mii_fighter.png" width="64" height="64">Miiファイター</button>
          <!-- 他のキャラを追加 -->
        </form>
        <p><a href="/solo">戻る</a></p>
      </body>
    </html>
  `);
});

// キャラ選択処理
app.post('/solo/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  if (!userId) {
    return res.redirect('/solo');
  }
  const character = req.body.character;

  const matchRef = doc(db, 'matches', matchId);
  const matchSnap = await getDoc(matchRef);
  if (!matchSnap.exists() || (matchSnap.data().userId !== userId && matchSnap.data().opponentId !== userId)) {
    return res.send('マッチが見つかりません');
  }

  if (character === 'mii_fighter') {
    res.send(`
      <html>
        <body>
          <h1>Miiファイター設定</h1>
          <form action="/solo/setup/${matchId}/mii" method="POST">
            <label>技番号（例: 1233）: <input type="text" name="miiMoves" maxlength="4"></label>
            <button type="submit">設定</button>
          </form>
          <p><a href="/solo/setup/${matchId}">戻る</a></p>
        </body>
      </html>
    `);
  } else {
    await updateDoc(matchRef, { character: character });
    res.redirect(`/solo/stage/${matchId}`);
  }
});

// ID更新処理
app.post('/solo/update', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/solo');
  }
  const userId = req.user.id;
  const roomId = req.body.roomId || '';

  try {
    const matchesRef = collection(db, 'matches');
    const waitingQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'waiting'));
    const waitingSnapshot = await getDocs(waitingQuery);

    if (!waitingSnapshot.empty) {
      const docSnap = waitingSnapshot.docs[0];
      await updateDoc(docSnap.ref, { roomId: roomId });
    }
    res.redirect('/solo/check');
  } catch (error) {
    console.error('ID更新エラー:', error.message, error.stack);
    res.send(`
      <html>
        <body>
          <h1>ID更新に失敗しました</h1>
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