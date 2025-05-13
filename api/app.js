const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { createClient } = require('redis');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, collection, query, where, addDoc, updateDoc, deleteDoc, getDocs } = require('firebase/firestore');
const admin = require('firebase-admin');
const sharp = require('sharp');
const EventEmitter = require('events');
require('dotenv').config();

const app = express();

// 環境変数チェック
const requiredEnvVars = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_STORAGE_BUCKET'
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`エラー: 環境変数 ${envVar} が設定されていません`);
    process.exit(1);
  }
}

// Firebase Admin SDK初期化
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL
  }),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

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

console.log('環境変数チェック:', {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: {
    connectTimeout: 20000,
    keepAlive: 10000,
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
  }
});
redisClient.on('error', (err) => console.error('Redisエラー:', err));
redisClient.on('connect', () => console.log('Redisに接続成功'));
redisClient.on('ready', () => console.log('Redis準備完了'));
redisClient.connect().catch(console.error);

class CustomRedisStore extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.prefix = 'sess:';
  }

  async get(key, cb) {
    try {
      const fullKey = this.prefix + key;
      console.log('Redis get開始:', fullKey);
      const data = await this.client.get(fullKey);
      console.log('Redis get結果:', fullKey, data);
      cb(null, data ? JSON.parse(data) : null);
    } catch (err) {
      console.error('Redis getエラー:', err);
      cb(err);
    }
  }

  async set(key, sess, cb) {
    try {
      const fullKey = this.prefix + key;
      console.log('Redis set開始:', fullKey, sess);
      await this.client.set(fullKey, JSON.stringify(sess), { EX: 604800 });
      console.log('Redis set成功:', fullKey);
      cb(null);
    } catch (err) {
      console.error('Redis setエラー:', err);
      cb(err);
    }
  }

  async destroy(key, cb) {
    try {
      const fullKey = this.prefix + key;
      console.log('Redis destroy開始:', fullKey);
      await this.client.del(fullKey);
      console.log('Redis destroy成功:', fullKey);
      cb(null);
    } catch (err) {
      console.error('Redis destroyエラー:', err);
      cb(err);
    }
  }

  async regenerate(req, cb) {
    console.log('Regenerate開始:', req.sessionID);
    const oldSessionId = req.sessionID;
    req.session.destroy((err) => {
      if (err) {
        console.error('Regenerateエラー:', err);
        return cb(err);
      }
      console.log('Regenerate: 古いセッション削除:', oldSessionId);
      req.sessionStore.generate(req);
      console.log('Regenerate成功:', req.sessionID);
      cb(null);
    });
  }

  generate(req) {
    console.log('セッション生成開始');
    req.session = new session.Session(req);
    req.sessionID = req.session.id;
    console.log('セッション生成成功:', req.sessionID);
  }
}

const redisStore = new CustomRedisStore(redisClient);

app.use(express.json());
const fileUpload = require('express-fileupload');
app.use(fileUpload());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: redisStore,
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  name: 'connect.sid',
  cookie: { 
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax',
    path: '/'
  },
  rolling: true
}));
app.use((req, res, next) => {
  const cookieHeader = req.headers.cookie;
  console.log('受信クッキー:', cookieHeader);
  if (cookieHeader) {
    const cookies = cookieHeader.split('; ').reduce((acc, cookie) => {
      const [name, value] = cookie.split('=');
      acc[name] = value;
      return acc;
    }, {});
    const receivedSid = cookies['connect.sid'];
    if (receivedSid && receivedSid !== req.sessionID) {
      console.log('セッションIDをクッキーに同期:', receivedSid);
      req.sessionID = receivedSid.split('.')[0];
    }
  }
  console.log('セッションID:', req.sessionID);
  req.sessionStore.get(req.sessionID, (err, session) => {
    if (err) {
      console.error('セッション取得エラー:', err);
      return next();
    }
    if (session) {
      console.log('セッション手動ロード:', session);
      Object.assign(req.session, session);
    }
    console.log('Passport前: req.session:', req.session);
    next();
  });
});
app.use(passport.initialize());
app.use(passport.session());
app.use((req, res, next) => {
  console.log('Passport後: req.session:', req.session);
  console.log('Passport後: req.session.passport:', req.session.passport);
  next();
});

// Google認証ストラテジー
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://sumatest.vercel.app/api/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  console.log('Google認証開始:', profile.id);
  try {
    // firebase-admin の Firestore を使用
    const db = admin.firestore();
    const userRef = db.collection('users').doc(profile.id);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      const userData = {
        handleName: '',
        bio: '',
        profileImage: '/default.png',
        email: profile.emails[0].value,
        createdAt: new Date().toISOString(),
        matchCount: 0,
        reportCount: 0,
        validReportCount: 0,
        penalty: false,
        soloRating: 1500,
        teamRating: 1500, // 追加
        uploadCount: 0,
        lastUploadReset: new Date().toISOString()
      };
      await userRef.set(userData);
      console.log('新規ユーザー登録成功:', profile.id, userData);
    } else {
      console.log('既存ユーザー確認:', profile.id, userSnap.data());
    }
    console.log('認証成功:', profile.id);
    return done(null, profile);
  } catch (error) {
    console.error('認証エラー:', error.message, error.stack);
    return done(error);
  }
}));

passport.serializeUser((user, done) => {
  console.log('serializeUser:', user.id);
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  console.log('deserializeUser開始:', id);
  try {
    const db = admin.firestore();
    const userRef = db.collection('users').doc(id);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      console.error('ユーザーが見つかりません:', id);
      return done(null, false);
    }
    let userData = userSnap.data();
    // teamRating が存在しない場合、デフォルト値1500をセット
    if (!userData.teamRating) {
      await userRef.update({ teamRating: 1500 });
      userData.teamRating = 1500;
    }
    userData.id = id;
    console.log('deserializeUser成功:', userData);
    done(null, userData);
  } catch (error) {
    console.error('deserializeUserエラー:', error.message, error.stack);
    done(error);
  }
});

app.get('/api/auth/google', (req, res, next) => {
  const redirectTo = req.query.redirect || '/api/';
  console.log('認証開始、リダイレクト先:', redirectTo);
  passport.authenticate('google', { scope: ['profile', 'email'], state: redirectTo }, (err) => {
    if (err) {
      console.error('認証エラー:', err);
      return res.redirect('/api/');
    }
  })(req, res, next);
});

app.get('/api/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/api/' }), 
  (req, res) => {
    console.log('コールバック成功:', req.user.id);
    console.log('コールバック後: req.session:', req.session);
    console.log('コールバック後: セッションID:', req.sessionID);
    req.session.save((err) => {
      if (err) {
        console.error('セッション保存エラー:', err);
        return res.redirect('/api/');
      }
      console.log('セッション保存成功、クッキー更新:', req.sessionID);
      res.set('Set-Cookie', `connect.sid=${req.sessionID}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`);
      const redirectTo = req.query.state || '/api/';
      res.status(302).set('Location', redirectTo).end();
    });
  }
);

// ルートパスを/api/にリダイレクト
app.get('/', (req, res) => {
  res.redirect('/api/');
});

app.get('/api/', async (req, res) => {
  console.log('ルートアクセス、req.session:', req.session);
  console.log('ルートアクセス、req.user:', req.user);
  if (req.user) {
    const userData = req.user;
    // 初回ログインならプロフィール設定へリダイレクト
    if (!userData.handleName) {
      return res.redirect(`/api/user/${userData.id}`);
    }
    res.send(`
      <html>
        <head>
          <style>
            .container { max-width: 800px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif; }
            img { max-width: 64px; max-height: 64px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>スマブラマッチング</h1>
            <p>こんにちは、${userData.handleName}さん！</p>
            <img src="${userData.profileImage}" alt="プロフィール画像">
            <p><a href="/api/user/${userData.id}">マイページ</a></p>
            <p><a href="/api/solo">タイマン用</a></p>
            <p><a href="/api/team">チーム用</a></p>
            <p><a href="/api/logout">ログアウト</a></p>
          </div>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <head>
          <style>
            .container { max-width: 800px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>スマブラマッチング</h1>
            <p><a href="/api/solo">タイマン用</a></p>
            <p><a href="/api/team">チーム用</a></p>
            <p><a href="/api/auth/google?redirect=/api/">Googleでログイン</a></p>
          </div>
        </body>
      </html>
    `);
  }
});

app.get('/api/logout', (req, res) => {
  if (req.user) {
    req.logout((err) => {
      if (err) {
        console.error('ログアウトエラー:', err);
        return res.redirect('/api/');
      }
      req.session.destroy((err) => {
        if (err) {
          console.error('セッション破棄エラー:', err);
          return res.redirect('/api/');
        }
        console.log('セッション破棄成功、クッキー削除');
        res.clearCookie('connect.sid', {
          path: '/',
          secure: process.env.NODE_ENV === 'production',
          httpOnly: true,
          sameSite: 'lax'
        });
        res.redirect('/api/');
      });
    });
  } else {
    res.redirect('/api/');
  }
});

// タイマン用ページ
app.get('/api/solo', async (req, res) => {
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
    const soloRating = req.user.soloRating || 1500;
    html += `
      <form action="/api/solo/match" method="POST">
        <button type="submit">マッチング開始</button>
      </form>
      <p>現在のレート: ${soloRating}</p>
    `;
  } else {
    html += `<p>マッチングするには<a href="/api/auth/google?redirect=/api/solo">ログイン</a>してください</p>`;
  }
  html += `<p><a href="/api/">戻る</a></p></body></html>`;
  res.send(html);
});

// マッチング状態チェック用ルート
app.get('/api/solo/check', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/api/solo');
  }
  const userId = req.user.id;
  const matchesRef = collection(db, 'matches');
  const userMatchQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'matched'));
  const userMatchSnapshot = await getDocs(userMatchQuery);

  if (!userMatchSnapshot.empty) {
    const matchData = userMatchSnapshot.docs[0].data();
    const matchId = userMatchSnapshot.docs[0].id;
    res.redirect(`/api/solo/setup/${matchId}`);
  } else {
    const waitingQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'waiting'));
    const waitingSnapshot = await getDocs(waitingQuery);
    const roomId = waitingSnapshot.empty ? '' : waitingSnapshot.docs[0].data().roomId;
    res.send(`
      <html>
        <body>
          <h1>マッチング待機中</h1>
          <p>相手を待っています... あなたのレート: ${req.user.soloRating || 1500}</p>
          <p>Switchで部屋を作成し、以下に部屋IDを入力してください。</p>
          <form action="/api/solo/update" method="POST">
            <label>Switch部屋ID: <input type="text" name="roomId" value="${roomId}" placeholder="例: ABC123"></label>
            <button type="submit">IDを更新</button>
          </form>
          <p><a href="/api/solo/cancel">キャンセル</a></p>
          <script>
            setInterval(() => {
              fetch('/api/solo/check/status')
                .then(response => response.json())
                .then(data => {
                  if (data.matched) {
                    window.location.href = '/api/solo/setup/' + data.matchId;
                  }
                })
                .catch(error => console.error('ポーリングエラー:', error));
            }, 2000);
          </script>
        </body>
      </html>
    `);
  }
});

// ポーリング用エンドポイント
app.get('/api/solo/check/status', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ matched: false });
  }
  const userId = req.user.id;
  const matchesRef = collection(db, 'matches');
  const userMatchQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'matched'));
  const userMatchSnapshot = await getDocs(userMatchQuery);

  if (!userMatchSnapshot.empty) {
    const matchId = userMatchSnapshot.docs[0].id;
    res.json({ matched: true, matchId });
  } else {
    res.json({ matched: false });
  }
});

// 待機キャンセルルート
app.get('/api/solo/cancel', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/api/solo');
  }
  const userId = req.user.id;
  const matchesRef = collection(db, 'matches');
  const waitingQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'waiting'));
  const waitingSnapshot = await getDocs(waitingQuery);

  try {
    waitingSnapshot.forEach(async (docSnap) => {
      await deleteDoc(docSnap.ref);
    });
    res.redirect('/api/solo');
  } catch (error) {
    console.error('キャンセルエラー:', error.message, error.stack);
    res.send(`
      <html>
        <body>
          <h1>キャンセルに失敗しました</h1>
          <p>エラー: ${error.message}</p>
          <p><a href="/api/solo">戻る</a></p>
        </body>
      </html>
    `);
  }
});

app.post('/api/solo/match', async (req, res) => {
  if (!req.user || !req.user.id) {
    console.error('ユーザー情報が不正:', req.user);
    return res.redirect('/api/solo');
  }
  const userId = req.user.id;
  const usersoloRating = req.user.soloRating || 1500;

  try {
    // firebase-admin の Firestore を使用
    const db = admin.firestore();
    const matchesRef = db.collection('matches');
    const waitingQuery = matchesRef
      .where('type', '==', 'solo')
      .where('status', '==', 'waiting')
      .where('userId', '!=', userId);
    const waitingSnapshot = await waitingQuery.get();

    let matched = false;
    for (const docSnap of waitingSnapshot.docs) {
      const guestData = docSnap.data();
      if (!guestData.roomId) continue;
      const guestRef = db.collection('users').doc(guestData.userId);
      const guestSnap = await guestRef.get();
      // exists() メソッドを exists プロパティに変更
      const guestsoloRating = guestSnap.exists ? (guestSnap.data().soloRating || 1500) : 1500;
      if (Math.abs(usersoloRating - guestsoloRating) <= 200) {
        await docSnap.ref.update({
          guestId: userId,
          status: 'matched',
          step: 'character_selection',
          timestamp: new Date().toISOString(),
          hostChoices: { wins: 0, losses: 0, matchResults: [null, null, null] },
          guestChoices: { wins: 0, losses: 0, matchResults: [null, null, null] }
        });
        console.log(`マッチ成立: matchId=${docSnap.id}, hostId=${guestData.userId}, guestId=${userId}`);
        matched = true;
        res.redirect(`/api/solo/setup/${docSnap.id}`);
        break;
      }
    }

    if (!matched) {
      const matchRef = await matchesRef.add({
        userId: userId,
        type: 'solo',
        status: 'waiting',
        roomId: '',
        timestamp: new Date().toISOString(),
        hostChoices: { wins: 0, losses: 0, matchResults: [null, null, null] },
        guestChoices: { wins: 0, losses: 0, matchResults: [null, null, null] }
      });
      console.log(`マッチ作成: matchId=${matchRef.id}, hostId=${userId}`);
      res.redirect('/api/solo/check');
    }
  } catch (error) {
    console.error('マッチングエラー:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.send(`
      <html>
        <body>
          <h1>マッチングに失敗しました</h1>
          <p>エラー: ${error.message}</p>
          <p><a href="/api/solo">戻る</a></p>
        </body>
      </html>
    `);
  }
});

// セットアップ画面
app.get('/api/solo/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;

  // ユーザー認証チェック
  if (!userId) {
    console.log('ユーザー未認証、リダイレクト:', matchId);
    return res.redirect('/api/solo');
  }

  try {
    // firebase-admin の Firestore を使用
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const matchSnap = await matchRef.get();

    // マッチの存在確認と権限チェック
    if (!matchSnap.exists || (matchSnap.data().userId !== userId && matchSnap.data().guestId !== userId)) {
      console.error(`マッチが見つかりません: matchId=${matchId}, userId=${userId}`);
      return res.send('マッチが見つかりません');
    }

    const matchData = matchSnap.data();
    const isHost = matchData.userId === userId;
    const hostId = matchData.userId;
    const guestId = matchData.guestId || '';

    // ホストとゲストの情報を取得
    const hostRef = db.collection('users').doc(hostId);
    const guestRef = db.collection('users').doc(guestId);
    const [hostSnap, guestSnap] = await Promise.all([hostRef.get(), guestRef.get()]);
    const hostName = hostSnap.data().handleName || '不明';
    const guestName = guestSnap.data().handleName || '不明';
    const hostsoloRating = hostSnap.data().soloRating || 1500;
    const guestsoloRating = guestSnap.data().soloRating || 1500;
    const hostProfileImage = hostSnap.data().profileImage || '/default.png';
    const guestProfileImage = guestSnap.data().profileImage || '/default.png';

    // マッチデータから選択情報を取得
    const hostChoices = matchData.hostChoices || { wins: 0, losses: 0 };
    const guestChoices = matchData.guestChoices || { wins: 0, losses: 0 };

    // キャラクターとステージの定義
    const allCharacters = Array.from({ length: 87 }, (_, i) => {
      const id = String(i + 1).padStart(2, '0');
      return { id, name: `キャラ${id}` };
    });
    const popularCharacters = [
      { id: '01', name: 'マリオ' },
      { id: '03', name: 'リンク' },
      { id: '54', name: '格闘Mii' },
      { id: '55', name: '剣術Mii' },
      { id: '56', name: '射撃Mii' }
    ];
    const stages = [
      { id: 'Random', name: 'ランダム' },
      { id: 'BattleField', name: '戦場' },
      { id: 'Final Destination', name: '終点' },
      { id: 'Hollow Bastion', name: 'ホロウバスティオン' },
      { id: 'Pokemon Stadium 2', name: 'ポケモンスタジアム2' },
      { id: 'Small Battlefield', name: '小戦場' },
      { id: 'Town and City', name: '村と街' },
      { id: 'Smashville', name: 'すま村' }
    ];
    const bannedStages = [...(hostChoices.bannedStages || []), ...(guestChoices.bannedStages || [])];

    // HTMLレスポンスを送信
    res.send(`
      <html>
        <head>
          <style>
            .overlay {
              display: none;
              position: fixed;
              top: 0;
              left: 0;
              width: 100%;
              height: 100%;
              background: rgba(0, 0, 0, 0.5);
              z-index: 1;
            }
            .popup {
              display: none;
              position: fixed;
              top: 20%;
              left: 20%;
              width: 60%;
              height: 60%;
              background: white;
              border: none;
              overflow: auto;
              z-index: 2;
            }
            .popup img {
              width: 64px;
              height: 64px;
              margin: 5px;
            }
            .section {
              margin: 20px 0;
            }
            #miiInput {
              display: none;
            }
            .char-btn {
              border: none;
              background: none;
              padding: 0;
              transition: opacity 0.3s, filter 0.3s;
            }
            .char-btn.char-normal {
              opacity: 1;
            }
            .char-btn.char-dim {
              opacity: 0.3;
            }
            .char-btn.char-dim-gray {
              opacity: 0.3;
              filter: grayscale(100%);
            }
            .char-btn.disabled {
              opacity: 0.5;
              pointer-events: none;
              cursor: not-allowed;
            }
            .select-char-btn.disabled {
              opacity: 0.5;
              pointer-events: none;
              cursor: not-allowed;
            }
            .stage-btn {
              opacity: 1.0;
              transition: opacity 0.3s, filter 0.3s, border 0.3s, background-color 0.3s;
              border: none;
              background: none;
              padding: 0;
              flex: 0 0 calc((100% - 10px) / 2);
              box-sizing: border-box;
            }
            .stage-btn.temporary {
              opacity: 0.3;
            }
            .stage-btn.counter {
              filter: grayscale(100%);
              opacity: 1.0;
            }
            .stage-btn.banned {
              filter: grayscale(100%);
              opacity: 0.3;
            }
            .stage-btn.confirmed {
              border: 2px solid red;
              background-color: rgba(255, 0, 0, 0.2);
              opacity: 1.0 !important;
              filter: none !important;
            }
            .result-btn {
              padding: 10px 20px;
              margin: 5px;
              cursor: pointer;
            }
            .result-btn.disabled {
              opacity: 0.5;
              pointer-events: none;
              cursor: not-allowed;
            }
            .match-container {
              max-width: 1000px;
              margin: 0 auto;
              padding: 20px;
              font-family: Arial, sans-serif;
            }
            .room-id {
              text-align: center;
              font-size: 1.5em;
              margin-bottom: 20px;
            }
            .player-table {
              display: flex;
              justify-content: space-between;
              margin-bottom: 20px;
              width: 100%;
            }
            .player-info {
              width: 45%;
              padding: 10px;
              border: 1px solid #ccc;
              border-radius: 5px;
              text-align: center;
            }
            .player-info img {
              width: 64px;
              height: 64px;
              margin: 5px;
            }
            .player-info h2 img {
              width: 32px;
              height: 32px;
              vertical-align: middle;
              margin-right: 8px;
            }
            .history-table {
              width: 100%;
              border-collapse: collapse;
              margin-bottom: 20px;
            }
            .history-table th, .history-table td {
              border: 1px solid #ccc;
              padding: 10px;
              text-align: center;
            }
            .history-table th {
              background-color: #f0f0f0;
            }
            .loser-char {
              opacity: 0.3;
              filter: grayscale(100%);
            }
            .stage-selection {
              margin-bottom: 20px;
            }
            .stage-container {
              display: flex;
              flex-wrap: wrap;
              gap: 10px;
              width: 100%;
              justify-content: space-between;
              box-sizing: border-box;
            }
            .stage-container img {
              width: 100%;
              height: auto;
            }
            .button-group {
              text-align: center;
            }
            .chat-container {
              margin: 20px 0;
              border: 1px solid #ccc;
              border-radius: 5px;
              padding: 10px;
            }
            .chat-log {
              max-height: 200px;
              overflow-y: auto;
              border-bottom: 1px solid #ccc;
              margin-bottom: 10px;
              padding: 10px;
            }
            .chat-message {
              margin: 5px 0;
            }
            .chat-message .sender {
              font-weight: bold;
              margin-right: 5px;
            }
            .chat-message .message-time {
              color: #888;
              font-size: 0.9em;
              margin-left: 5px;
            }
            .chat-input {
              width: 100%;
              margin-bottom: 10px;
            }
            .chat-input textarea {
              width: 100%;
              height: 50px;
              resize: none;
            }
            .chat-controls {
              display: flex;
              align-items: center;
              justify-content: flex-end;
            }
            .chat-controls button {
              width: 100px;
              margin-left: 10px;
            }
            .char-count {
              font-size: 0.9em;
              margin-left: 10px;
            }
            @media (max-width: 768px) {
              .player-table {
                flex-direction: column;
                align-items: center;
              }
              .player-info {
                width: 100%;
                margin-bottom: 10px;
              }
              .match-container {
                padding: 10px;
              }
              .stage-btn {
                flex: 0 0 calc((100% - 10px) / 2);
              }
              .chat-controls button {
                width: 80px;
              }                
            }
          </style>
          <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
          <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
          <script>
            var firebaseConfig = {
              apiKey: "${process.env.FIREBASE_API_KEY}",
              authDomain: "${process.env.FIREBASE_AUTH_DOMAIN}",
              projectId: "${process.env.FIREBASE_PROJECT_ID}",
              storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET}",
              messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
              appId: "${process.env.FIREBASE_APP_ID}",
              measurementId: "${process.env.FIREBASE_MEASUREMENT_ID}"
            };
            firebase.initializeApp(firebaseConfig);
            console.log('Firebase初期化完了');
            var db = firebase.firestore();

            var selectedChar = '';
            var selectedStages = [];
            var hostChoices = ${JSON.stringify(hostChoices)};
            var guestChoices = ${JSON.stringify(guestChoices)};
            var isHost = ${isHost};
            var hostName = '${hostName}';
            var guestName = '${guestName}';

            function selectCharacter(id, name) {
              selectedChar = id;
              const charPopup = document.getElementById('charPopup');
              const overlay = document.getElementById('overlay');
              const miiInput = document.getElementById('miiInput');
              if (charPopup) charPopup.style.display = 'none';
              if (overlay) overlay.style.display = 'none';
              if (miiInput) {
                miiInput.style.display = ['54', '55', '56'].includes(id) ? 'block' : 'none';
              }
              updateCharacterButtons();
            }

            function updateCharacterButtons() {
              var matchCount = (hostChoices.wins || 0) + (hostChoices.losses || 0);
              var bothCharsReady = hostChoices.characterReady && guestChoices.characterReady;

              document.querySelectorAll('.char-btn').forEach(btn => {
                btn.classList.remove('char-normal', 'char-dim', 'char-dim-gray', 'selected', 'disabled');

                if (matchCount === 0) {
                  if (!bothCharsReady) {
                    if (isHost) {
                      if (!hostChoices.character1 && !selectedChar) {
                        btn.classList.add('char-normal');
                      } else {
                        const isSelected = selectedChar ? btn.dataset.id === selectedChar : btn.dataset.id === hostChoices.character1;
                        btn.classList.toggle('char-normal', isSelected);
                        btn.classList.toggle('char-dim', !isSelected);
                      }
                    } else {
                      if (!guestChoices.character1 && !selectedChar) {
                        btn.classList.add('char-normal');
                      } else {
                        const isSelected = selectedChar ? btn.dataset.id === selectedChar : btn.dataset.id === guestChoices.character1;
                        btn.classList.toggle('char-normal', isSelected);
                        btn.classList.toggle('char-dim', !isSelected);
                      }
                    }
                  } else {
                    if (isHost) {
                      btn.classList.toggle('char-normal', btn.dataset.id === hostChoices.character1);
                      btn.classList.toggle('char-dim-gray', btn.dataset.id !== hostChoices.character1);
                    } else {
                      btn.classList.toggle('char-normal', btn.dataset.id === guestChoices.character1);
                      btn.classList.toggle('char-dim-gray', btn.dataset.id !== guestChoices.character1);
                    }
                  }
                } else if (hostChoices.wins >= 2 || guestChoices.wins >= 2) {
                  btn.classList.add('char-normal');
                } else {
                  if ((!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) || (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                    btn.classList.add('char-normal');
                  } else if (!hostChoices['character' + (matchCount + 1)] || !guestChoices['character' + (matchCount + 1)]) {
                    if (isHost && !hostChoices['character' + (matchCount + 1)]) {
                      if (!selectedChar) {
                        btn.classList.add('char-normal');
                      } else {
                        btn.classList.toggle('char-normal', btn.dataset.id === selectedChar);
                        btn.classList.toggle('char-dim', btn.dataset.id !== selectedChar);
                      }
                    } else if (!isHost && !guestChoices['character' + (matchCount + 1)]) {
                      if (!selectedChar) {
                        btn.classList.add('char-normal');
                      } else {
                        btn.classList.toggle('char-normal', btn.dataset.id === selectedChar);
                        btn.classList.toggle('char-dim', btn.dataset.id !== selectedChar);
                      }
                    } else {
                      if (isHost) {
                        btn.classList.toggle('char-normal', btn.dataset.id === hostChoices['character' + (matchCount + 1)]);
                        btn.classList.toggle('char-dim-gray', btn.dataset.id !== hostChoices['character' + (matchCount + 1)]);
                      } else {
                        btn.classList.toggle('char-normal', btn.dataset.id === guestChoices['character' + (matchCount + 1)]);
                        btn.classList.toggle('char-dim-gray', btn.dataset.id !== guestChoices['character' + (matchCount + 1)]);
                      }
                    }
                  } else {
                    if (isHost) {
                      btn.classList.toggle('char-normal', btn.dataset.id === hostChoices['character' + (matchCount + 1)]);
                      btn.classList.toggle('char-dim-gray', btn.dataset.id !== hostChoices['character' + (matchCount + 1)]);
                    } else {
                      btn.classList.toggle('char-normal', btn.dataset.id === guestChoices['character' + (matchCount + 1)]);
                      btn.classList.toggle('char-dim-gray', btn.dataset.id !== guestChoices['character' + (matchCount + 1)]);
                    }
                  }
                }
              });
            }

            function selectStage(id) {
              var matchCount = (hostChoices.wins || 0) + (hostChoices.losses || 0);
              var banned = [...(hostChoices.bannedStages || []), ...(guestChoices.bannedStages || [])];
              var isHostWinner = (hostChoices.wins || 0) > (guestChoices.wins || 0);

              if (matchCount === 0) {
                if (['Random'].includes(id)) {
                  if (isHost && (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0)) {
                    selectedStages = [id];
                  } else if (!isHost && hostChoices.bannedStages && (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                    if (selectedStages.includes(id)) {
                      selectedStages = selectedStages.filter(s => s !== id);
                    } else if (selectedStages.length < 2) {
                      selectedStages.push(id);
                    }
                  }
                } else if (banned.includes(id)) {
                  alert('そのステージは既に拒否されています。');
                  return;
                } else if (['Town and City', 'Smashville'].includes(id)) {
                  alert('そのステージを1戦目に選ぶことは出来ません。');
                  return;
                } else {
                  if (isHost && (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0)) {
                    selectedStages = [id];
                  } else if (!isHost && hostChoices.bannedStages && (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                    if (selectedStages.includes(id)) {
                      selectedStages = selectedStages.filter(s => s !== id);
                    } else if (selectedStages.length < 2) {
                      selectedStages.push(id);
                    }
                  }
                }
              } else {
                if (['Random'].includes(id)) {
                  if (isHost && !isHostWinner) {
                    alert('おまかせを選ぶことは出来ません。');
                    return;
                  } else if (!isHost && isHostWinner) {
                    alert('おまかせを選ぶことは出来ません。');
                    return;
                  }
                } else if (banned.includes(id)) {
                  alert('そのステージは既に拒否されています。');
                  return;
                }
                if (isHost) {
                  if (isHostWinner && (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0)) {
                    if (selectedStages.includes(id)) {
                      selectedStages = selectedStages.filter(s => s !== id);
                    } else if (selectedStages.length < 2) {
                      selectedStages.push(id);
                    }
                  } else if (!isHostWinner && guestChoices.bannedStages && guestChoices.bannedStages.length > 0) {
                    if (['Random'].includes(id)) {
                      alert('おまかせを選ぶことは出来ません。');
                      return;
                    } else {
                      selectedStages = [id];
                    }
                  }
                } else {
                  if (isHostWinner && hostChoices.bannedStages && hostChoices.bannedStages.length > 0) {
                    if (['Random'].includes(id)) {
                      alert('おまかせを選ぶことは出来ません。');
                      return;
                    } else {
                      selectedStages = [id];
                    }
                  } else if (!isHostWinner && (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                    if (selectedStages.includes(id)) {
                      selectedStages = selectedStages.filter(s => s !== id);
                    } else if (selectedStages.length < 2) {
                      selectedStages.push(id);
                    }
                  }
                }
              }
              updateStageButtons();
            }

            function updateStageButtons() {
              var matchCount = (hostChoices.wins || 0) + (hostChoices.losses || 0);
              var banned = [...(hostChoices.bannedStages || []), ...(guestChoices.bannedStages || [])];
              var isHostWinner = (hostChoices.wins || 0) > (guestChoices.wins || 0);

              document.querySelectorAll('.stage-btn').forEach(btn => {
                btn.classList.remove('temporary', 'banned', 'confirmed', 'counter');
                var id = btn.dataset.id;

                if (['Town and City', 'Smashville'].includes(id) && matchCount === 0) {
                  btn.classList.add('counter');
                }

                if (matchCount === 0) {
                  if (['Random'].includes(id)) {
                    if ((!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) || (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                      if (selectedStages.includes(id)) {
                        btn.classList.add('temporary');
                      }
                    }
                  } else if (banned.includes(id)) {
                    btn.classList.add('banned');
                  } else if (selectedStages.includes(id)) {
                    btn.classList.add('temporary');
                  }
                } else if (hostChoices.wins >= 2 || guestChoices.wins >= 2) {
                  // デフォルト
                } else if ((!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) || (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                  if (['Random'].includes(id)) {
                    if (isHost) {
                      if (!isHostWinner && ['Random'].includes(id)) {
                        btn.classList.add('counter');
                      } else if (selectedStages.includes(id)) {
                        btn.classList.add('temporary');
                      }
                    } else {
                      if (isHostWinner && ['Random'].includes(id)) {
                        btn.classList.add('counter');
                      } else if (selectedStages.includes(id)) {
                        btn.classList.add('temporary');
                      }
                    }
                  } else if (isHost) {
                    if (isHostWinner) {
                      if (banned.includes(id)) {
                        btn.classList.add('banned');
                      } else if (selectedStages.includes(id)) {
                        btn.classList.add('temporary');
                      }
                    } else {
                      if (['Random'].includes(id)) {
                        btn.classList.add('counter');
                      } else if (!selectedStages.length) {
                        if (banned.includes(id)) {
                          btn.classList.add('banned');
                        }
                      } else {
                        if (banned.includes(id)) {
                          btn.classList.add('banned');
                        } else if (!selectedStages.includes(id)) {
                          btn.classList.add('temporary');
                        }
                      }
                    }
                  } else {
                    if (!isHostWinner) {
                      if (banned.includes(id)) {
                        btn.classList.add('banned');
                      } else if (selectedStages.includes(id)) {
                        btn.classList.add('temporary');
                      }
                    } else {
                      if (['Random'].includes(id)) {
                        btn.classList.add('counter');
                      } else if (!selectedStages.length) {
                        if (banned.includes(id)) {
                          btn.classList.add('banned');
                        }
                      } else {
                        if (banned.includes(id)) {
                          btn.classList.add('banned');
                        } else if (!selectedStages.includes(id)) {
                          btn.classList.add('temporary');
                        }
                      }
                    }
                  }
                } else {
                  if (hostChoices.selectedStage === id || guestChoices.selectedStage === id) {
                    // デフォルト
                  } else {
                    btn.classList.add('banned');
                  }
                }
              });
            }

            async function saveSelections(matchId, result) {
              var data = {};
              var matchCount = (hostChoices.wins || 0) + (hostChoices.losses || 0);
              var isHostWinner = (hostChoices.wins || 0) > (guestChoices.wins || 0);

              const doc = await db.collection('matches').doc(matchId).get();
              if (doc.exists) {
                hostChoices = doc.data().hostChoices || { wins: 0, losses: 0 };
                guestChoices = doc.data().guestChoices || { wins: 0, losses: 0 };
              }

              if (result) {
                data.result = result;
                data.hostChoices = { ...hostChoices, bannedStages: [], selectedStage: '', characterReady: false };
                data.guestChoices = { ...guestChoices, bannedStages: [], selectedStage: '', characterReady: false };
                selectedStages = [];
                selectedChar = '';
              } else if (matchCount === 0) {
                if (!hostChoices['character' + (matchCount + 1)] || !guestChoices['character' + (matchCount + 1)]) {
                  if (selectedChar) {
                    if (['54', '55', '56'].includes(selectedChar)) {
                      const miiMoves = document.getElementById('miiMoves')?.value;
                      if (!miiMoves) {
                        alert('Miiの技番号を入力してください');
                        return;
                      }
                      if (!/^[1-3]{4}$/.test(miiMoves)) {
                        alert('Miiの技番号は1, 2, 3のみを使用した4桁の数字で入力してください（例：1111, 3223）');
                        return;
                      }
                    }
                    data.characterReady = true;
                    data['character' + (matchCount + 1)] = selectedChar;
                  }
                } else if ((!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) || (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                  if (isHost && (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0)) {
                    if (selectedStages.length > 0) {
                      data.bannedStages = selectedStages;
                    }
                  } else if (!isHost && hostChoices.bannedStages && (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                    if (selectedStages.length > 0) {
                      data.bannedStages = selectedStages;
                    }
                  }
                }
              } else if (hostChoices.wins >= 2 || guestChoices.wins >= 2) {
                return;
              } else {
                if ((!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) || (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                  if (isHost) {
                    if (isHostWinner && (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0)) {
                      if (selectedStages.length > 0) {
                        data.bannedStages = selectedStages;
                      }
                    } else if (!isHostWinner && guestChoices.bannedStages && guestChoices.bannedStages.length > 0) {
                      if (selectedStages.length > 0) {
                        data.bannedStages = selectedStages;
                        data.selectedStage = selectedStages[0];
                      }
                    }
                  } else {
                    if (isHostWinner && hostChoices.bannedStages && hostChoices.bannedStages.length > 0) {
                      if (selectedStages.length > 0) {
                        data.bannedStages = selectedStages;
                        data.selectedStage = selectedStages[0];
                      }
                    } else if (!isHostWinner && (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                      if (selectedStages.length > 0) {
                        data.bannedStages = selectedStages;
                      }
                    }
                  }
                } else if (!hostChoices['character' + (matchCount + 1)] || !guestChoices['character' + (matchCount + 1)]) {
                  if (selectedChar) {
                    if (['54', '55', '56'].includes(selectedChar)) {
                      const miiMoves = document.getElementById('miiMoves')?.value;
                      if (!miiMoves) {
                        alert('Miiの技番号を入力してください');
                        return;
                      }
                      if (!/^[1-3]{4}$/.test(miiMoves)) {
                        alert('Miiの技番号は1, 2, 3のみを使用した4桁の数字で入力してください（例：1111, 3223）');
                        return;
                      }
                    }
                    data.characterReady = true;
                    data['character' + (matchCount + 1)] = selectedChar;
                  }
                }
              }

              var miiMoves = ['54', '55', '56'].includes(selectedChar) ? document.getElementById('miiMoves')?.value : '';
              if (miiMoves) data['miiMoves' + (matchCount + 1)] = miiMoves;

              if (Object.keys(data).length === 0) {
                return;
              }

              try {
                var response = await fetch('/api/solo/setup/' + matchId, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(data)
                });
                if (!response.ok) {
                  alert('保存に失敗しました: ' + await response.text());
                  return;
                }
                selectedChar = '';
                selectedStages = [];
                updateCharacterButtons();
              } catch (error) {
                alert('ネットワークエラー: ' + error.message);
              }
            }

            async function sendMessage() {
              const messageInput = document.getElementById('messageInput');
              const message = messageInput.value.trim();
              if (!message) return;
              try {
                const response = await fetch('/api/solo/setup/${matchId}/message', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ message })
                });
                if (!response.ok) {
                  alert('メッセージ送信に失敗しました: ' + await response.text());
                  return;
                }
                messageInput.value = '';
                updateCharCount();
              } catch (error) {
                alert('ネットワークエラー: ' + error.message);
              }
            }

            function updateCharCount() {
              const messageInput = document.getElementById('messageInput');
              const charCount = document.getElementById('charCount');
              const length = messageInput.value.length;
              charCount.innerText = length + '/500';
              if (length > 500) {
                charCount.style.color = 'red';
                messageInput.value = messageInput.value.slice(0, 500);
                charCount.innerText = '500/500';
              } else {
                charCount.style.color = 'black';
              }
            }

            async function cancelMatch() {
              try {
                const response = await fetch('/api/solo/setup/${matchId}/cancel', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({})
                });
                if (!response.ok) {
                  alert('キャンセルリクエストに失敗しました: ' + await response.text());
                  return;
                }
              } catch (error) {
                alert('ネットワークエラー: ' + error.message);
              }
            }

            function updateMatchHistory() {
              const matchHistory = document.getElementById('matchHistory');
              if (!matchHistory) return;
              const matchCount = (hostChoices.wins || 0) + (hostChoices.losses || 0);
              const bothCharsReady = hostChoices.characterReady && guestChoices.characterReady;
              const matchResults = hostChoices.matchResults || [null, null, null];
              const isFinished = hostChoices.wins >= 2 || guestChoices.wins >= 2;
              let html = '';

              for (let i = 0; i < 3; i++) {
                if (((i === 2) && (isFinished)) || (i > matchCount && (i > 0 && matchResults[i - 1] === null))) continue;
                let hostChar = '00';
                let hostMoves = '';
                let guestChar = '00';
                let guestMoves = '';
                let hostClass = '';
                let guestClass = '';

                if (i === 0) {
                  if (!matchResults[0]) {
                    if (!bothCharsReady) {
                      hostChar = '00';
                      guestChar = '00';
                    } else {
                      hostChar = hostChoices.character1 || '00';
                      hostMoves = hostChoices.miiMoves1 || '';
                      guestChar = guestChoices.character1 || '00';
                      guestMoves = guestChoices.miiMoves1 || '';
                    }
                  } else {
                    hostChar = hostChoices.character1 || '00';
                    hostMoves = hostChoices.miiMoves1 || '';
                    guestChar = guestChoices.character1 || '00';
                    guestMoves = guestChoices.miiMoves1 || '';
                    hostClass = matchResults[0] === 'guestWin' ? 'loser-char' : '';
                    guestClass = matchResults[0] === 'hostWin' ? 'loser-char' : '';
                  }
                } else if (i === 1) {
                  if (!matchResults[1]) {
                    if ((!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) || (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                      hostChar = '00';
                      guestChar = '00';
                    } else {
                      hostChar = hostChoices.character2 || '00';
                      hostMoves = hostChoices.miiMoves2 || '';
                      guestChar = guestChoices.character2 || '00';
                      guestMoves = guestChoices.miiMoves2 || '';
                    }
                  } else {
                    hostChar = hostChoices.character2 || '00';
                    hostMoves = hostChoices.miiMoves2 || '';
                    guestChar = guestChoices.character2 || '00';
                    guestMoves = guestChoices.miiMoves2 || '';
                    hostClass = matchResults[1] === 'guestWin' ? 'loser-char' : '';
                    guestClass = matchResults[1] === 'hostWin' ? 'loser-char' : '';
                  }
                } else if (i === 2) {
                  if (!matchResults[2]) {
                    if ((!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) || (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                      hostChar = '00';
                      guestChar = '00';
                    } else {
                      hostChar = hostChoices.character3 || '00';
                      hostMoves = hostChoices.miiMoves3 || '';
                      guestChar = guestChoices.character3 || '00';
                      guestMoves = guestChoices.miiMoves3 || '';
                    }
                  } else {
                    hostChar = hostChoices.character3 || '00';
                    hostMoves = hostChoices.miiMoves3 || '';
                    guestChar = guestChoices.character3 || '00';
                    guestMoves = guestChoices.miiMoves3 || '';
                    hostClass = matchResults[2] === 'guestWin' ? 'loser-char' : '';
                    guestClass = matchResults[2] === 'hostWin' ? 'loser-char' : '';
                  }
                }

                html += '<tr>' +
                        '<td>' + (i + 1) + '戦目</td>' +
                        '<td><img src="/characters/' + hostChar + '.png" class="' + hostClass + '"> ' + hostMoves + '</td>' +
                        '<td><img src="/characters/' + guestChar + '.png" class="' + guestClass + '"> ' + guestMoves + '</td>' +
                        '</tr>';
              }

              matchHistory.innerHTML = html;
            }

            db.collection('matches').doc('${matchId}').onSnapshot(
              function (doc) {
                if (!doc.exists) {
                  return;
                }
                var data = doc.data();
                hostChoices = data.hostChoices || { wins: 0, losses: 0 };
                guestChoices = data.guestChoices || { wins: 0, losses: 0 };
                var matchCount = data.matchCount || (hostChoices.wins || 0) + (hostChoices.losses || 0);
                var isHostWinner = (hostChoices.wins || 0) > (guestChoices.wins || 0);
                var bothCharsReady = hostChoices.characterReady && guestChoices.characterReady;
                var isCancelled = data.isCancelled || false;

                if (matchCount > 0 && !hostChoices['character' + (matchCount + 1)] && hostChoices['character' + matchCount]) {
                  if (isHost) selectedChar = hostChoices['character' + matchCount];
                }
                if (matchCount > 0 && !guestChoices['character' + (matchCount + 1)] && guestChoices['character' + matchCount]) {
                  if (!isHost) selectedChar = guestChoices['character' + matchCount];
                }

                var guideText = '';
                var canSelectChar = false;
                var canSelectStage = false;
                var canSelectResult = false;

                if (isCancelled) {
                  guideText = 'このルームは対戦中止になりました';
                  canSelectChar = false;
                  canSelectStage = false;
                  canSelectResult = false;
                  document.querySelectorAll('.char-btn').forEach(btn => {
                    btn.classList.remove('char-normal', 'char-dim', 'char-dim-gray', 'selected');
                    btn.classList.add('char-normal');
                    btn.classList.add('disabled');
                    btn.style.pointerEvents = 'none';
                    btn.style.cursor = 'not-allowed';
                  });
                  document.querySelectorAll('.stage-btn').forEach(btn => {
                    btn.classList.remove('temporary', 'banned', 'confirmed', 'counter');
                    btn.classList.add('disabled');
                    btn.style.pointerEvents = 'none';
                    btn.style.cursor = 'not-allowed';
                  });
                } else if (matchCount === 0) {
                  if (!hostChoices['character' + (matchCount + 1)] || !guestChoices['character' + (matchCount + 1)]) {
                    guideText = 'キャラクターを選択してください（' + (isHost ? hostName : guestName) + '）';
                    canSelectChar = (isHost && !hostChoices['character' + (matchCount + 1)]) || (!isHost && !guestChoices['character' + (matchCount + 1)]);
                  } else if ((!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) || (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                    if (isHost) {
                      if (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) {
                        guideText = '拒否ステージを1つ選んでください（' + hostName + '）';
                        canSelectStage = true;
                      } else {
                        guideText = guestName + 'が拒否ステージを選んでいます...';
                      }
                    } else {
                      if (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) {
                        guideText = hostName + 'が拒否ステージを選んでいます...';
                      } else {
                        guideText = '拒否ステージを2つ選んでください（' + guestName + '）';
                        canSelectStage = true;
                      }
                    }
                  } else {
                    if (isHost) {
                      guideText = '表示されている残りのステージから選び、対戦を開始してください（' + hostName + '）';
                    } else {
                      guideText = 'ステージを「おまかせ」に設定し、対戦を開始してください（' + guestName + '）';
                    }
                    canSelectResult = true;
                  }
                } else if (hostChoices.wins >= 2 || guestChoices.wins >= 2) {
                  guideText = 'このルームの対戦は終了しました。';
                  canSelectResult = false;
                } else {
                  if ((!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) || (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
                    if (isHost) {
                      if (isHostWinner) {
                        if (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) {
                          guideText = '拒否ステージを2つ選んでください（' + hostName + '）';
                          canSelectStage = true;
                        } else {
                          guideText = guestName + 'が対戦するステージを選んでいます...';
                        }
                      } else {
                        if (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0) {
                          guideText = guestName + 'が拒否ステージを選んでいます...';
                        } else {
                          guideText = '対戦するステージを選んでください（' + hostName + '）';
                          canSelectStage = true;
                        }
                      }
                    } else {
                      if (isHostWinner) {
                        if (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0) {
                          guideText = hostName + 'が拒否ステージを選んでいます...';
                        } else {
                          guideText = '対戦するステージを選んでください（' + guestName + '）';
                          canSelectStage = true;
                        }
                      } else {
                        if (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0) {
                          guideText = '拒否ステージを2つ選んでください（' + guestName + '）';
                          canSelectStage = true;
                        } else {
                          guideText = hostName + 'が対戦するステージを選んでいます...';
                        }
                      }
                    }
                  } else if (!hostChoices['character' + (matchCount + 1)] || !guestChoices['character' + (matchCount + 1)]) {
                    if (isHost) {
                      if (isHostWinner) {
                        if (!hostChoices['character' + (matchCount + 1)]) {
                          guideText = 'キャラクターを選択してください（' + hostName + '）';
                          canSelectChar = true;
                        } else {
                          guideText = guestName + 'がキャラクターを選んでいます...';
                        }
                      } else {
                        if (!guestChoices['character' + (matchCount + 1)]) {
                          guideText = guestName + 'がキャラクターを選んでいます...';
                        } else {
                          guideText = 'キャラクターを選択してください（' + hostName + '）';
                          canSelectChar = true;
                        }
                      }
                    } else {
                      if (isHostWinner) {
                        if (!hostChoices['character' + (matchCount + 1)]) {
                          guideText = hostName + 'がキャラクターを選んでいます...';
                        } else {
                          guideText = 'キャラクターを選択してください（' + guestName + '）';
                          canSelectChar = true;
                        }
                      } else {
                        if (!guestChoices['character' + (matchCount + 1)]) {
                          guideText = 'キャラクターを選択してください（' + guestName + '）';
                          canSelectChar = true;
                        } else {
                          guideText = hostName + 'がキャラクターを選んでいます...';
                        }
                      }
                    }
                  } else {
                    if (isHost) {
                      if (isHostWinner) {
                        guideText = 'ステージを「おまかせ」に設定し、選んだキャラクターで対戦を始めてください（' + hostName + '）';
                      } else {
                        guideText = '選んだステージ、キャラクターで対戦を始めてください（' + hostName + '）';
                      }
                    } else {
                      if (isHostWinner) {
                        guideText = '選んだステージ、キャラクターで対戦を始めてください（' + guestName + '）';
                      } else {
                        guideText = 'ステージを「おまかせ」に設定し、選んだキャラクターで対戦を始めてください（' + guestName + '）';
                      }
                    }
                    canSelectResult = true;
                  }
                }

                document.getElementById('guide').innerText = guideText;
                document.querySelectorAll('.char-btn').forEach(btn => {
                  btn.classList.toggle('disabled', !canSelectChar);
                  btn.style.pointerEvents = canSelectChar ? 'auto' : 'none';
                  btn.style.cursor = canSelectChar ? 'auto' : 'not-allowed';
                });
                document.querySelectorAll('.select-char-btn').forEach(btn => {
                  btn.classList.toggle('disabled', !canSelectChar);
                  btn.style.pointerEvents = canSelectChar ? 'auto' : 'none';
                  btn.style.cursor = canSelectChar ? 'auto' : 'not-allowed';
                  btn.onclick = canSelectChar ? () => {
                    const charPopup = document.getElementById('charPopup');
                    const overlay = document.getElementById('overlay');
                    if (charPopup) charPopup.style.display = 'block';
                    if (overlay) overlay.style.display = 'block';
                  } : null;
                });
                document.querySelectorAll('.stage-btn').forEach(btn => {
                  btn.classList.toggle('disabled', !canSelectStage);
                  btn.style.pointerEvents = canSelectStage ? 'auto' : 'none';
                  btn.onclick = canSelectStage ? () => selectStage(btn.dataset.id) : null;
                });
                document.querySelectorAll('.result-btn').forEach(btn => {
                  btn.classList.toggle('disabled', !canSelectResult);
                  btn.style.cursor = canSelectResult ? 'auto' : 'not-allowed';
                });
                document.querySelectorAll('.confirm-btn').forEach(btn => {
                  btn.classList.toggle('disabled', !canSelectResult);
                  btn.style.cursor = canSelectResult ? 'auto' : 'not-allowed';
                });

                updateStageButtons();
                updateCharacterButtons();
                updateMatchHistory();
              }
            );

            db.collection('matches').doc('${matchId}').collection('messages')
              .orderBy('timestamp', 'asc')
              .onSnapshot((snapshot) => {
                const chatLog = document.getElementById('chatLog');
                chatLog.innerHTML = '';
                snapshot.forEach((doc) => {
                  const msg = doc.data();
                  const messageElement = document.createElement('div');
                  messageElement.className = 'chat-message';
                  messageElement.innerHTML = 
                    '<span class="sender">' + msg.handleName + ':</span>' + 
                    msg.message.replace(/\\n/g, '<br>') + 
                    '<span class="message-time">' + msg.time + '</span>';
                  chatLog.appendChild(messageElement);
                });
                chatLog.scrollTop = chatLog.scrollHeight;
              });
          </script>
        </head>
        <body>
          <div class="match-container">
            <div class="room-id">対戦部屋のID: ${matchData.roomId || '未設定'}</div>
            <div class="player-table">
              <div class="player-info">
                <h2><img src="${hostProfileImage}" alt="${hostName}のプロフィール画像"> ${hostName}</h2>
                <p>レート: ${hostsoloRating}</p>
                <p>よく使うキャラ:</p>
                ${popularCharacters.map(char => `
                  <img src="/characters/${char.id}.png" alt="${char.name}">
                `).join('')}
              </div>
              <div class="player-info">
                <h2><img src="${guestProfileImage}" alt="${guestName}のプロフィール画像"> ${guestName}</h2>
                <p>レート: ${guestsoloRating}</p>
                <p>よく使うキャラ:</p>
                ${popularCharacters.map(char => `
                  <img src="/characters/${char.id}.png" alt="${char.name}">
                `).join('')}
              </div>
            </div>
            <table class="history-table">
              <thead>
                <tr>
                  <th>試合</th>
                  <th>ホスト</th>
                  <th>ゲスト</th>
                </tr>
              </thead>
              <tbody id="matchHistory"></tbody>
            </table>
            <p id="guide"></p>
            <div class="section">
              <h2>キャラクター選択</h2>
              ${popularCharacters.map(char => `
                <button class="popular char-btn" data-id="${char.id}" onclick="selectCharacter('${char.id}', '${char.name}')">
                  <img src="/characters/${char.id}.png">
                </button>
              `).join('')}
              <button class="select-char-btn">全キャラから選ぶ</button>
              <div id="charPopup" class="popup">
                ${allCharacters.map(char => `
                  <button class="char-btn" data-id="${char.id}" onclick="selectCharacter('${char.id}', '${char.name}')">
                    <img src="/characters/${char.id}.png">
                  </button>
                `).join('')}
              </div>
            </div>
            <div class="section" id="miiInput">
              <h2>Miiファイター設定</h2>
              <label>技番号（例: 1233）: <input type="text" id="miiMoves" maxlength="4"></label>
            </div>
            <div class="section stage-selection">
              <div class="stage-container">
                ${stages.map(stage => `
                  <button class="stage-btn disabled ${bannedStages.includes(stage.id) ? 'banned' : ''} ${['Town and City', 'Smashville'].includes(stage.id) ? 'extra' : ''}" data-id="${stage.id}">
                    <img src="/stages/${stage.id}.png">
                  </button>
                `).join('')}
              </div>
            </div>
            <div class="button-group">
              <button onclick="saveSelections('${matchId}')">決定</button>
              <button class="result-btn" onclick="saveSelections('${matchId}', 'win')">勝ち</button>
              <button class="result-btn" onclick="saveSelections('${matchId}', 'lose')">負け</button>
              <button class="result-btn" onclick="cancelMatch()">対戦中止</button>
              <p><a href="/api/solo">戻る</a></p>
            </div>
            <div class="chat-container">
              <div class="chat-log" id="chatLog"></div>
              <div class="chat-input">
                <textarea id="messageInput" maxlength="500" oninput="updateCharCount()" placeholder="メッセージを入力..."></textarea>
              </div>
              <div class="chat-controls">
                <span id="charCount">0/500</span>
                <button onclick="sendMessage()">送信</button>
             </div>
            </div>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('セットアップ画面エラー:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.status(500).send('エラーが発生しました');
  }
});

app.post('/api/solo/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  const { character1, character2, character3, miiMoves1, miiMoves2, miiMoves3, bannedStages, result, characterReady, selectedStage } = req.body;

  console.log('POST /api/solo/setup/:matchId received:', { matchId, userId, body: req.body });

  try {
    // firebase-admin の Firestore を使用
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const matchSnap = await matchRef.get();
    if (!matchSnap.exists) return res.status(404).send('マッチが見つかりません');

    const matchData = matchSnap.data();
    const isHost = matchData.userId === userId;
    const choicesKey = isHost ? 'hostChoices' : 'guestChoices';
    const opponentChoicesKey = isHost ? 'guestChoices' : 'hostChoices';
    const updateData = {};

    async function updatesoloRatings(winnerId, loserId) {
      const winnerRef = db.collection('users').doc(winnerId);
      const loserRef = db.collection('users').doc(loserId);
      const [winnerSnap, loserSnap] = await Promise.all([winnerRef.get(), loserRef.get()]);
      const winnersoloRating = winnerSnap.data()?.soloRating || 1000;
      const losersoloRating = loserSnap.data()?.soloRating || 1000;
      const soloRatingDiff = losersoloRating - winnersoloRating;
      const winPoints = soloRatingDiff >= 400 ? 0 : Math.floor(16 + soloRatingDiff * 0.04);
      const losePoints = winPoints; // 絶対値一致
      await Promise.all([
        winnerRef.update({ soloRating: winnersoloRating + winPoints }),
        loserRef.update({ soloRating: losersoloRating - losePoints })
      ]);
      return { winPoints, losePoints };
    }

    if (result) {
      updateData[choicesKey] = { ...matchData[choicesKey], result };
      const opponentChoices = matchData[opponentChoicesKey];
      if (opponentChoices.result && (
        (result === 'win' && opponentChoices.result === 'lose') ||
        (result === 'lose' && opponentChoices.result === 'win')
      )) {
        const hostWins = matchData.hostChoices.wins || 0;
        const guestWins = matchData.guestChoices.wins || 0;
        const matchNumber = (matchData.matchCount || 0) + 1;
        const currentMatchResults = matchData.hostChoices.matchResults || [null, null, null];
        if (result === 'win' && isHost || result === 'lose' && !isHost) {
          currentMatchResults[matchNumber - 1] = 'hostWin';
          updateData.hostChoices = {
            ...matchData.hostChoices,
            wins: hostWins + 1,
            result: '',
            characterReady: false,
            bannedStages: [],
            selectedStage: '',
            matchResults: currentMatchResults
          };
          updateData.guestChoices = {
            ...matchData.guestChoices,
            losses: (matchData.guestChoices.losses || 0) + 1,
            result: '',
            characterReady: false,
            bannedStages: [],
            selectedStage: '',
            matchResults: currentMatchResults
          };
        } else {
          currentMatchResults[matchNumber - 1] = 'guestWin';
          updateData.guestChoices = {
            ...matchData.guestChoices,
            wins: guestWins + 1,
            result: '',
            characterReady: false,
            bannedStages: [],
            selectedStage: '',
            matchResults: currentMatchResults
          };
          updateData.hostChoices = {
            ...matchData.hostChoices,
            losses: (matchData.hostChoices.losses || 0) + 1,
            result: '',
            characterReady: false,
            bannedStages: [],
            selectedStage: '',
            matchResults: currentMatchResults
          };
        }
        updateData.matchCount = matchNumber;
        if (updateData.hostChoices.wins >= 2 || updateData.guestChoices.wins >= 2) {
          updateData.status = 'finished';
          const winnerId = updateData.hostChoices.wins >= 2 ? matchData.userId : matchData.guestId;
          const loserId = updateData.hostChoices.wins >= 2 ? matchData.guestId : matchData.userId;
          const { winPoints, losePoints } = await updatesoloRatings(winnerId, loserId);
          updateData.soloRatingChanges = {
            [winnerId]: winPoints,
            [loserId]: -losePoints
          };
        }
      }
    } else {
      const matchCount = matchData.hostChoices.wins + matchData.hostChoices.losses;
      updateData[choicesKey] = { ...matchData[choicesKey] };
      if (characterReady) updateData[choicesKey].characterReady = true;
      if (character1 !== undefined) {
        console.log(`Saving character1 for ${choicesKey}:`, character1);
        updateData[choicesKey].character1 = character1;
      }
      if (character2 !== undefined) {
        console.log(`Saving character2 for ${choicesKey}:`, character2);
        updateData[choicesKey].character2 = character2;
      }
      if (character3 !== undefined) {
        console.log(`Saving character3 for ${choicesKey}:`, character3);
        updateData[choicesKey].character3 = character3;
      }
      if (miiMoves1 !== undefined) updateData[choicesKey].miiMoves1 = miiMoves1;
      if (miiMoves2 !== undefined) updateData[choicesKey].miiMoves2 = miiMoves2;
      if (miiMoves3 !== undefined) updateData[choicesKey].miiMoves3 = miiMoves3;
      if (bannedStages) {
        console.log(`Saving bannedStages for ${choicesKey}:`, bannedStages);
        updateData[choicesKey].bannedStages = bannedStages;
      }
      if (selectedStage) {
        console.log(`Saving selectedStage for ${choicesKey}:`, selectedStage);
        updateData[choicesKey].selectedStage = selectedStage;
        updateData.selectedStage = selectedStage;
      }
    }

    await matchRef.update(updateData);
    console.log('マッチデータ更新成功:', { matchId, updateData });
    res.send('OK');
  } catch (error) {
    console.error('マッチデータ更新エラー:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.status(500).send(`エラー: ${error.message}`);
  }
});

app.post('/api/solo/setup/:matchId/message', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  const { message } = req.body;

  if (!userId) {
    return res.status(401).send('認証が必要です');
  }
  if (!message || typeof message !== 'string') {
    return res.status(400).send('メッセージが必要です');
  }
  if (message.length > 500) {
    return res.status(400).send('メッセージは500文字以内にしてください');
  }

  try {
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const userLimitRef = matchRef.collection('userLimits').doc(userId);
    const messagesRef = matchRef.collection('messages');

    // マッチの存在確認
    const matchSnap = await matchRef.get();
    if (!matchSnap.exists || (matchSnap.data().userId !== userId && matchSnap.data().guestId !== userId)) {
      return res.status(403).send('このマッチにアクセスする権限がありません');
    }

    // ルーム全体の制限チェック
    const matchData = matchSnap.data();
    const totalMessages = matchData.totalMessages || 0;
    const totalChars = matchData.totalChars || 0;
    if (totalMessages >= 100) {
      return res.status(400).send('このルームのメッセージ回数上限（100回）に達しました');
    }
    if (totalChars + message.length > 10000) {
      return res.status(400).send('このルームの文字数上限（10,000文字）に達しました');
    }

    // ユーザーごとの制限チェック
    const userLimitSnap = await userLimitRef.get();
    let userLimitData = userLimitSnap.exists ? userLimitSnap.data() : { messageCount: 0, lastReset: null, totalChars: 0 };
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);

    if (!userLimitData.lastReset || new Date(userLimitData.lastReset) < oneMinuteAgo) {
      userLimitData = { messageCount: 0, lastReset: now.toISOString(), totalChars: userLimitData.totalChars };
    }
    if (userLimitData.messageCount >= 10) {
      return res.status(400).send('1分間の送信回数上限（10回）に達しました。しばらくお待ちください');
    }

    // JSTで送信時間（hh:mm）を生成
    const jstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);

    // メッセージ保存
    const userSnap = await db.collection('users').doc(userId).get();
    const handleName = userSnap.data()?.handleName || '不明';
    await messagesRef.add({
      userId,
      handleName,
      message,
      timestamp: now.toISOString(),
      time: jstTime
    });

    // 制限データの更新
    await userLimitRef.set({
      messageCount: userLimitData.messageCount + 1,
      lastReset: userLimitData.lastReset,
      totalChars: userLimitData.totalChars + message.length
    }, { merge: true });

    await matchRef.update({
      totalMessages: totalMessages + 1,
      totalChars: totalChars + message.length
    });

    res.send('OK');
  } catch (error) {
    console.error('メッセージ送信エラー:', {
      message: error.message,
      stack: error.stack,
      code: error.code || 'N/A'
    });
    res.status(500).send(`エラー: ${error.message}`);
  }
});

app.post('/api/solo/setup/:matchId/cancel', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;

  if (!userId) {
    return res.status(401).send('認証が必要です');
  }

  try {
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const matchSnap = await matchRef.get();

    if (!matchSnap.exists) {
      return res.status(404).send('マッチが見つかりません');
    }

    const matchData = matchSnap.data();
    const isHost = matchData.userId === userId;
    const isGuest = matchData.guestId === userId;

    if (!isHost && !isGuest) {
      return res.status(403).send('このマッチにアクセスする権限がありません');
    }

    // 既にキャンセル済みの場合は何もしない
    if (matchData.isCancelled) {
      return res.send('OK');
    }

    // キャンセルリクエストを更新
    const updateData = {};
    if (isHost) {
      updateData['hostChoices.cancelRequested'] = true;
    } else {
      updateData['guestChoices.cancelRequested'] = true;
    }

    // 両者がキャンセルリクエストした場合、キャンセル状態に
    const otherCancelRequested = isHost ? matchData.guestChoices?.cancelRequested : matchData.hostChoices?.cancelRequested;
    if (otherCancelRequested) {
      updateData.isCancelled = true;
    }

    await matchRef.update(updateData);
    res.send('OK');
  } catch (error) {
    console.error('キャンセルエラー:', {
      message: error.message,
      stack: error.stack,
      code: error.code || 'N/A'
    });
    res.status(500).send(`エラー: ${error.message}`);
  }
});

// ID更新処理
app.post('/api/solo/update', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/api/solo');
  }
  const userId = req.user.id;
  const roomId = req.body.roomId || '';

  try {
    // firebase-admin の Firestore を使用
    const db = admin.firestore();
    const matchesRef = db.collection('matches');
    const waitingQuery = matchesRef
      .where('userId', '==', userId)
      .where('status', '==', 'waiting');
    const waitingSnapshot = await waitingQuery.get();

    if (!waitingSnapshot.empty) {
      const docSnap = waitingSnapshot.docs[0];
      await docSnap.ref.update({ roomId: roomId });
      console.log('部屋ID更新成功:', { userId, roomId });
    }
    res.redirect('/api/solo/check');
  } catch (error) {
    console.error('ID更新エラー:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.send(`
      <html>
        <body>
          <h1>ID更新に失敗しました</h1>
          <p>エラー: ${error.message}</p>
          <p><a href="/api/solo">戻る</a></p>
        </body>
      </html>
    `);
  }
});

// ユーザーページ
app.get('/api/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const currentUser = req.user;

  try {
    const db = admin.firestore();
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).send(`
        <html><body>
          <h1>ユーザーが見つかりません</h1>
          <p><a href="/api/">ホームに戻る</a></p>
        </body></html>
      `);
    }

    const userData = userSnap.data();
    // 既存ユーザー向けデフォルト値
    userData.handleName = userData.handleName || '';
    userData.bio = userData.bio || '';
    userData.profileImage = userData.profileImage || '/default.png';
    userData.uploadCount = userData.uploadCount || 0;
    userData.lastUploadReset = userData.lastUploadReset || new Date().toISOString();

    const isOwnProfile = currentUser && currentUser.id === userId;
    const isNewUser = isOwnProfile && !userData.handleName;

    if (isNewUser || !userData.handleName) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="ja">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>プロフィール設定</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .error { color: red; }
            img { max-width: 64px; max-height: 64px; }
            label { display: block; margin: 10px 0; }
            input, textarea { width: 100%; max-width: 300px; }
            button { margin-top: 10px; }
          </style>
        </head>
        <body>
          <h1>プロフィール設定</h1>
          <form id="profileForm" enctype="multipart/form-data">
            <label>
              ハンドルネーム（10文字まで）:
              <input type="text" name="handleName" value="${userData.handleName || ''}" maxlength="10" required>
            </label>
            <label>
              自己紹介（1000文字まで）:
              <textarea name="bio" maxlength="1000">${userData.bio || ''}</textarea>
            </label>
            <label>
              プロフィール画像（64x64、PNG/JPEG、1MB以下、1日5回まで）:
              <input type="file" name="profileImage" accept="image/png,image/jpeg">
              <img src="${userData.profileImage || '/default.png'}" alt="プロフィール画像" id="profileImageDisplay">
            </label>
            <div id="error" class="error"></div>
            <button type="submit">保存</button>
          </form>
    
          <script>
            const form = document.getElementById('profileForm');
            const profileImageInput = document.querySelector('input[name="profileImage"]');
            const profileImageDisplay = document.getElementById('profileImageDisplay');
            const errorDiv = document.getElementById('error');
    
            profileImageInput.addEventListener('change', (e) => {
              const file = e.target.files[0];
              if (file) {
                if (!['image/png', 'image/jpeg'].includes(file.type)) {
                  errorDiv.textContent = 'PNGまたはJPEG形式の画像を選択してください';
                  profileImageInput.value = '';
                  profileImageDisplay.src = '${userData.profileImage || '/default.png'}';
                  return;
                }
                if (file.size > 1 * 1024 * 1024) {
                  errorDiv.textContent = '画像サイズは1MB以下にしてください';
                  profileImageInput.value = '';
                  profileImageDisplay.src = '${userData.profileImage || '/default.png'}';
                  return;
                }
                const reader = new FileReader();
                reader.onload = (event) => {
                  const img = new Image();
                  img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = 64;
                    canvas.height = 64;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, 64, 64);
                    profileImageDisplay.src = canvas.toDataURL('image/png');
                  };
                  img.src = event.target.result;
                };
                reader.readAsDataURL(file);
              } else {
                profileImageDisplay.src = '${userData.profileImage || '/default.png'}';
              }
            });
    
            form.addEventListener('submit', async (e) => {
              e.preventDefault();
              const formData = new FormData(form);
              try {
                const response = await fetch('/api/user/${userId}/update', {
                  method: 'POST',
                  body: formData
                });
                if (response.ok) {
                  window.location.href = '/api/user/${userId}';
                } else {
                  const errorText = await response.text();
                  errorDiv.textContent = errorText;
                }
              } catch (error) {
                errorDiv.textContent = 'エラーが発生しました';
              }
            });
          </script>
        </body>
        </html>
      `);
    }

    // マッチング履歴の取得
    const matchesRef = db.collection('matches');
    const userMatchesQuery = matchesRef
      .where('status', '==', 'finished')
      .where('userId', 'in', [userId, userId]); // ホストまたはゲスト
    const matchesSnapshot = await userMatchesQuery.get();
    let matchHistory = '';
    matchesSnapshot.forEach(doc => {
      const match = doc.data();
      const isHost = match.userId === userId;
      const opponentId = isHost ? match.guestId : match.userId;
      const result = isHost
        ? match.hostChoices.wins >= 2 ? '勝利' : '敗北'
        : match.guestChoices.wins >= 2 ? '勝利' : '敗北';
      matchHistory += `
        <tr>
          <td>${opponentId}</td>
          <td>${result}</td>
          <td>${new Date(match.timestamp).toLocaleString()}</td>
        </tr>
      `;
    });

    res.send(`
      <html>
        <head>
          <style>
            .container { max-width: 800px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif; }
            img { max-width: 64px; max-height: 64px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #ccc; padding: 10px; text-align: left; }
            .error { color: red; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>${userData.handleName || '未設定'}のプロフィール</h1>
            <img src="${userData.profileImage}" alt="プロフィール画像">
            <p>自己紹介: ${userData.bio || '未設定'}</p>
            <p>レート: ${userData.soloRating}</p>
            ${isOwnProfile ? `
              <p><a href="/api/user/${userId}/edit">プロフィールを編集</a></p>
              <p><a href="/api/logout">ログアウト</a></p>
            ` : ''}
            <h2>マッチング履歴</h2>
            <table>
              <thead>
                <tr>
                  <th>対戦相手</th>
                  <th>結果</th>
                  <th>日時</th>
                </tr>
              </thead>
              <tbody>
                ${matchHistory || '<tr><td colspan="3">履歴がありません</td></tr>'}
              </tbody>
            </table>
            <p><a href="/api/">ホームに戻る</a></p>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('ユーザーページエラー:', error);
    res.status(500).send(`
      <html><body>
        <h1>エラーが発生しました</h1>
        <p>${error.message}</p>
        <p><a href="/api/">ホームに戻る</a></p>
      </body></html>
    `);
  }
});

// プロフィール編集ページ
app.get('/api/user/:userId/edit', async (req, res) => {
  const { userId } = req.params;
  const currentUser = req.user;

  if (!currentUser || currentUser.id !== userId) {
    return res.status(403).send('権限がありません');
  }

  try {
    const db = admin.firestore();
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).send('ユーザーが見つかりません');
    }

    const userData = userSnap.data();

    res.send(`
      <!DOCTYPE html>
      <html lang="ja">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>プロフィール編集</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .error { color: red; }
          img { max-width: 64px; max-height: 64px; }
          label { display: block; margin: 10px 0; }
          input, textarea { width: 100%; max-width: 300px; }
          button { margin-top: 10px; }
        </style>
      </head>
      <body>
        <h1>プロフィール編集</h1>
        <form id="profileForm" enctype="multipart/form-data">
          <label>
            ハンドルネーム（10文字まで）:
            <input type="text" name="handleName" value="${userData.handleName || ''}" maxlength="10" required>
          </label>
          <label>
            自己紹介（1000文字まで）:
            <textarea name="bio" maxlength="1000">${userData.bio || ''}</textarea>
          </label>
          <label>
            プロフィール画像（64x64、PNG/JPEG、1MB以下、1日5回まで）:
            <input type="file" name="profileImage" accept="image/png,image/jpeg">
            <img src="${userData.profileImage || '/default.png'}" alt="プロフィール画像" id="profileImageDisplay">
          </label>
          <div id="error" class="error"></div>
          <button type="submit">保存</button>
        </form>
        <a href="/api/user/${userId}">戻る</a>

        <script>
          const form = document.getElementById('profileForm');
          const profileImageInput = document.querySelector('input[name="profileImage"]');
          const profileImageDisplay = document.getElementById('profileImageDisplay');
          const errorDiv = document.getElementById('error');

          profileImageInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
              if (!['image/png', 'image/jpeg'].includes(file.type)) {
                errorDiv.textContent = 'PNGまたはJPEG形式の画像を選択してください';
                profileImageInput.value = '';
                profileImageDisplay.src = '${userData.profileImage || '/default.png'}';
                return;
              }
              if (file.size > 1 * 1024 * 1024) {
                errorDiv.textContent = '画像サイズは1MB以下にしてください';
                profileImageInput.value = '';
                profileImageDisplay.src = '${userData.profileImage || '/default.png'}';
                return;
              }
              const reader = new FileReader();
              reader.onload = (event) => {
                const img = new Image();
                img.onload = () => {
                  const canvas = document.createElement('canvas');
                  canvas.width = 64;
                  canvas.height = 64;
                  const ctx = canvas.getContext('2d');
                  ctx.drawImage(img, 0, 0, 64, 64);
                  profileImageDisplay.src = canvas.toDataURL('image/png');
                };
                img.src = event.target.result;
              };
              reader.readAsDataURL(file);
            } else {
              profileImageDisplay.src = '${userData.profileImage || '/default.png'}';
            }
          });

          form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(form);
            try {
              const response = await fetch('/api/user/${userId}/update', {
                method: 'POST',
                body: formData
              });
              if (response.ok) {
                window.location.href = '/api/user/${userId}';
              } else {
                const errorText = await response.text();
                errorDiv.textContent = errorText;
              }
            } catch (error) {
              errorDiv.textContent = 'エラーが発生しました';
            }
          });
        </script>
      </body>
      </html>
    `);
  } catch (error) {
    console.error('プロフィール編集ページエラー:', error);
    res.status(500).send('エラーが発生しました');
  }
});

// プロフィール更新
app.post('/api/user/:userId/update', async (req, res) => {
  const { userId } = req.params;
  const currentUser = req.user;

  // 認証状態のログ
  console.log('プロフィール更新リクエスト:', {
    userId,
    currentUser: currentUser ? { id: currentUser.id, handleName: currentUser.handleName } : null,
    sessionID: req.sessionID,
    session: req.session,
    body: {
      handleName: req.body.handleName,
      bio: req.body.bio,
      hasProfileImage: !!req.files?.profileImage
    }
  });

  if (!currentUser) {
    console.error('認証エラー: ユーザーが認証されていません');
    return res.status(401).send('認証が必要です。ログインしてください。');
  }

  if (currentUser.id !== userId) {
    console.error('権限エラー: ユーザーIDが一致しません', {
      requestedUserId: userId,
      authenticatedUserId: currentUser.id
    });
    return res.status(403).send('自分のプロフィールのみ編集可能です');
  }

  try {
    // firebase-admin の Firestore を使用
    const db = admin.firestore();
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).send('ユーザーが見つかりません');
    }

    const userData = userSnap.data();
    const handleName = (req.body.handleName || '').trim();
    const bio = (req.body.bio || '').trim();
    const profileImage = req.files?.profileImage;

    // バリデーション
    if (!handleName) {
      return res.status(400).send('ハンドルネームは必須です');
    }

    // 画像フォーマットおよびサイズ制限
    if (profileImage) {
      if (!['image/png', 'image/jpeg'].includes(profileImage.mimetype)) {
        return res.status(400).send('PNGまたはJPEG形式の画像をアップロードしてください');
      }
      if (profileImage.size > 1 * 1024 * 1024) {
        return res.status(400).send('画像サイズは1MB以下にしてください');
      }
    }

    // アップロード制限チェック
    const now = new Date();
    const lastReset = new Date(userData.lastUploadReset || now);
    if (lastReset.toDateString() !== now.toDateString()) {
      await userRef.update({ uploadCount: 0, lastUploadReset: now.toISOString() });
      userData.uploadCount = 0;
    }
    if (profileImage && userData.uploadCount >= 5) {
      return res.status(400).send('1日のアップロード上限（5回）に達しました');
    }

    const updateData = {
      handleName: handleName.slice(0, 10),
      bio: bio.slice(0, 1000)
    };

    if (profileImage) {
      const bucket = admin.storage().bucket();
      const fileName = `profile_images/${userId}_${Date.now()}.png`;
      const file = bucket.file(fileName);

      // 画像リサイズ
      const buffer = await sharp(profileImage.data)
        .resize(64, 64, { fit: 'cover' })
        .png()
        .toBuffer();

      try {
        await file.save(buffer, {
          metadata: {
            contentType: 'image/png',
            metadata: {
              firebaseStorageDownloadTokens: Date.now()
            }
          },
          public: true
        });
        const [url] = await file.getSignedUrl({
          action: 'read',
          expires: '03-09-2491'
        });
        updateData.profileImage = url;
        updateData.uploadCount = (userData.uploadCount || 0) + 1;
      } catch (storageError) {
        console.error('Firebase Storageエラー:', {
          message: storageError.message,
          code: storageError.code,
          stack: storageError.stack
        });
        return res.status(500).send('画像アップロードに失敗しました');
      }
    }

    console.log('プロフィール更新データ:', updateData);
    await userRef.update(updateData);
    console.log('プロフィール更新成功:', { userId, updateData });
    res.send('OK');
  } catch (error) {
    console.error('プロフィール更新エラー:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.status(500).send(`エラー: ${error.message}`);
  }
});

// チーム用ページ（仮）
app.get('/api/team', async (req, res) => {
  const matchesRef = collection(db, 'matches');
  const waitingQuery = query(matchesRef, where('type', '==', 'team'), where('status', '==', 'waiting'));
  const waitingSnapshot = await getDocs(waitingQuery);
  const waitingCount = waitingSnapshot.size;

  let html = `
    <html>
      <head>
        <style>
          .container { max-width: 800px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>チーム用ページ</h1>
          <p>待機中のチーム: ${waitingCount}</p>
  `;
  if (req.user) {
    const teamRating = req.user.teamRating || 1500;
    html += `
      <form action="/api/team/match" method="POST">
        <button type="submit">マッチング開始</button>
      </form>
      <p>現在のチームレート: ${teamRating}</p>
    `;
  } else {
    html += `<p>マッチングするには<a href="/api/auth/google?redirect=/api/team">ログイン</a>してください</p>`;
  }
  html += `
          <p><a href="/api/">ホームに戻る</a></p>
        </div>
      </body>
    </html>`;
  res.send(html);
});

app.post('/api/team/match', async (req, res) => {
  if (!req.user || !req.user.id) {
    console.error('ユーザー情報が不正:', req.user);
    return res.redirect('/api/team');
  }
  const userId = req.user.id;
  const userTeamRating = req.user.teamRating || 1500;

  try {
    const db = admin.firestore();
    const matchesRef = db.collection('matches');
    const waitingQuery = matchesRef
      .where('type', '==', 'team')
      .where('status', '==', 'waiting')
      .where('userId', '!=', userId);
    const waitingSnapshot = await waitingQuery.get();

    let matched = false;
    for (const docSnap of waitingSnapshot.docs) {
      const guestData = docSnap.data();
      if (!guestData.roomId) continue;
      const guestRef = db.collection('users').doc(guestData.userId);
      const guestSnap = await guestRef.get();
      const guestTeamRating = guestSnap.exists ? (guestSnap.data().teamRating || 1500) : 1500;
      if (Math.abs(userTeamRating - guestTeamRating) <= 200) {
        await docSnap.ref.update({
          guestId: userId,
          status: 'matched',
          timestamp: new Date().toISOString()
        });
        console.log(`チームマッチ成立: matchId=${docSnap.id}, hostId=${guestData.userId}, guestId=${userId}`);
        matched = true;
        res.redirect(`/api/team/setup/${docSnap.id}`);
        break;
      }
    }

    if (!matched) {
      const matchRef = await matchesRef.add({
        userId: userId,
        type: 'team',
        status: 'waiting',
        ROOMID: '',
        timestamp: new Date().toISOString()
      });
      console.log(`チームマッチ作成: matchId=${matchRef.id}, hostId=${userId}`);
      res.redirect('/api/team/check');
    }
  } catch (error) {
    console.error('チームマッチングエラー:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.send(`
      <html>
        <body>
          <h1>マッチングに失敗しました</h1>
          <p>エラー: ${error.message}</p>
          <p><a href="/api/team">戻る</a></p>
        </body>
      </html>
    `);
  }
});

// マッチング状態チェック
app.get('/api/team/check', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/api/team');
  }
  const userId = req.user.id;
  const matchesRef = collection(db, 'matches');
  const userMatchQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'matched'), where('type', '==', 'team'));
  const userMatchSnapshot = await getDocs(userMatchQuery);

  if (!userMatchSnapshot.empty) {
    const matchId = userMatchSnapshot.docs[0].id;
    res.redirect(`/api/team/setup/${matchId}`);
  } else {
    const waitingQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'waiting'), where('type', '==', 'team'));
    const waitingSnapshot = await getDocs(waitingQuery);
    const roomId = waitingSnapshot.empty ? '' : waitingSnapshot.docs[0].data().roomId;
    res.send(`
      <html>
        <head>
          <style>
            .container { max-width: 800px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>チームマッチング待機中</h1>
            <p>相手チームを待っています... あなたのチームレート: ${req.user.teamRating || 1500}</p>
            <p>Switchで部屋を作成し、以下に部屋IDを入力してください。</p>
            <form action="/api/team/update" method="POST">
              <label>Switch部屋ID: <input type="text" name="roomId" value="${roomId}" placeholder="例: ABC123"></label>
              <button type="submit">IDを更新</button>
            </form>
            <p><a href="/api/team/cancel">キャンセル</a></p>
            <script>
              setInterval(() => {
                fetch('/api/team/check/status')
                  .then(response => response.json())
                  .then(data => {
                    if (data.matched) {
                      window.location.href = '/api/team/setup/' + data.matchId;
                    }
                  })
                  .catch(error => console.error('ポーリングエラー:', error));
              }, 2000);
            </script>
          </div>
        </body>
      </html>
    `);
  }
});

// ポーリング用エンドポイント
app.get('/api/team/check/status', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ matched: false });
  }
  const userId = req.user.id;
  const matchesRef = collection(db, 'matches');
  const userMatchQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'matched'), where('type', '==', 'team'));
  const userMatchSnapshot = await getDocs(userMatchQuery);

  if (!userMatchSnapshot.empty) {
    const matchId = userMatchSnapshot.docs[0].id;
    res.json({ matched: true, matchId });
  } else {
    res.json({ matched: false });
  }
});

// 待機キャンセル
app.get('/api/team/cancel', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/api/team');
  }
  const userId = req.user.id;
  const matchesRef = collection(db, 'matches');
  const waitingQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'waiting'), where('type', '==', 'team'));
  const waitingSnapshot = await getDocs(waitingQuery);

  try {
    waitingSnapshot.forEach(async (docSnap) => {
      await deleteDoc(docSnap.ref);
    });
    res.redirect('/api/team');
  } catch (error) {
    console.error('チームキャンセルエラー:', error.message, error.stack);
    res.send(`
      <html>
        <body>
          <h1>キャンセルに失敗しました</h1>
          <p>エラー: ${error.message}</p>
          <p><a href="/api/team">戻る</a></p>
        </body>
      </html>
    `);
  }
});

app.post('/api/team/update', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/api/team');
  }
  const userId = req.user.id;
  const roomId = req.body.roomId || '';

  try {
    const db = admin.firestore();
    const matchesRef = db.collection('matches');
    const waitingQuery = matchesRef
      .where('userId', '==', userId)
      .where('status', '==', 'waiting')
      .where('type', '==', 'team');
    const waitingSnapshot = await waitingQuery.get();

    if (!waitingSnapshot.empty) {
      const docSnap = waitingSnapshot.docs[0];
      await docSnap.ref.update({ roomId: roomId });
      console.log('チーム部屋ID更新成功:', { userId, roomId });
    }
    res.redirect('/api/team/check');
  } catch (error) {
    console.error('チームID更新エラー:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.send(`
      <html>
        <body>
          <h1>ID更新に失敗しました</h1>
          <p>エラー: ${error.message}</p>
          <p><a href="/api/team">戻る</a></p>
        </body>
      </html>
    `);
  }
});

app.get('/api/team/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;

  if (!userId) {
    console.log('ユーザー未認証、リダイレクト:', matchId);
    return res.redirect('/api/team');
  }

  try {
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const matchSnap = await matchRef.get();

    if (!matchSnap.exists || (matchSnap.data().userId !== userId && matchSnap.data().guestId !== userId)) {
      console.error(`チームマッチが見つかりません: matchId=${matchId}, userId=${userId}`);
      return res.send('マッチが見つかりません');
    }

    const matchData = matchSnap.data();
    const isHost = matchData.userId === userId;
    const hostId = matchData.userId;
    const guestId = matchData.guestId || '';

    const hostRef = db.collection('users').doc(hostId);
    const guestRef = db.collection('users').doc(guestId);
    const [hostSnap, guestSnap] = await Promise.all([hostRef.get(), guestRef.get()]);
    const hostName = hostSnap.data().handleName || '不明';
    const guestName = guestSnap.data().handleName || '不明';
    let hostTeamRating = hostSnap.data().teamRating || 1500;
    let guestTeamRating = guestSnap.data().teamRating || 1500;
    const hostProfileImage = hostSnap.data().profileImage || '/default.png';
    const guestProfileImage = guestSnap.data().profileImage || '/default.png';

    res.send(`
      <html>
        <head>
          <style>
            .match-container { max-width: 800px; margin: 0 auto; padding: 20px; font-family: Arial, sans-serif; }
            .room-id { text-align: center; font-size: 1.5em; margin-bottom: 20px; }
            .player-table { display: flex; justify-content: space-between; margin-bottom: 20px; }
            .player-info { width: 45%; padding: 10px; border: 1px solid #ccc; border-radius: 5px; text-align: center; }
            .player-info img { width: 32px; height: 32px; vertical-align: middle; margin-right: 5px; }
            .player-info h2 { font-size: 1.2em; margin: 10px 0; }
            .button-group { text-align: center; margin-top: 20px; }
            .result-btn { padding: 10px 20px; margin: 5px; cursor: pointer; }
            .result-btn.disabled { opacity: 0.5; pointer-events: none; cursor: not-allowed; }
            .confirm-btn.disabled { opacity: 0.5; pointer-events: none; cursor: not-allowed; }            
            .chat-container { margin: 20px 0; border: 1px solid #ccc; border-radius: 5px; padding: 10px; }
            .chat-log { max-height: 200px; overflow-y: auto; border-bottom: 1px solid #ccc; margin-bottom: 10px; padding: 10px; }
            .chat-message { margin: 5px 0; }
            .chat-message .sender { font-weight: bold; margin-right: 5px; }
            .chat-message .message-time { color: #888; font-size: 0.9em; margin-left: 5px; }
            .chat-input { width: 100%; margin-bottom: 10px; }
            .chat-input textarea { width: 100%; height: 50px; resize: none; }
            .chat-controls { display: flex; align-items: center; justify-content: flex-end; }
            .chat-controls button { width: 100px; margin-left: 10px; }
            .char-count { font-size: 0.9em; margin-left: 10px; }
            @media (max-width: 768px) {
              .player-table { flex-direction: column; align-items: center; }
              .player-info { width: 100%; margin-bottom: 10px; }
              .chat-controls button { width: 80px; }
            }
          </style>
          <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
          <script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-firestore.js"></script>
          <script>
            var firebaseConfig = {
              apiKey: "${process.env.FIREBASE_API_KEY}",
              authDomain: "${process.env.FIREBASE_AUTH_DOMAIN}",
              projectId: "${process.env.FIREBASE_PROJECT_ID}",
              storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET}",
              messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
              appId: "${process.env.FIREBASE_APP_ID}",
              measurementId: "${process.env.FIREBASE_MEASUREMENT_ID}"
            };
            firebase.initializeApp(firebaseConfig);
            var db = firebase.firestore();

            async function submitResult(result) {
              try {
                const response = await fetch('/api/team/setup/${matchId}', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ result })
                });
                if (!response.ok) {
                  alert('結果の送信に失敗しました: ' + await response.text());
                }
              } catch (error) {
                alert('ネットワークエラー: ' + error.message);
              }
            }

            async function sendMessage() {
              const messageInput = document.getElementById('messageInput');
              const message = messageInput.value.trim();
              if (!message) return;
              try {
                const response = await fetch('/api/team/setup/${matchId}/message', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ message })
                });
                if (!response.ok) {
                  alert('メッセージ送信に失敗しました: ' + await response.text());
                  return;
                }
                messageInput.value = '';
                updateCharCount();
              } catch (error) {
                alert('ネットワークエラー: ' + error.message);
              }
            }

            function updateCharCount() {
              const messageInput = document.getElementById('messageInput');
              const charCount = document.getElementById('charCount');
              const length = messageInput.value.length;
              charCount.innerText = length + '/500';
              if (length > 500) {
                charCount.style.color = 'red';
                messageInput.value = messageInput.value.slice(0, 500);
                charCount.innerText = '500/500';
              } else {
                charCount.style.color = 'black';
              }
            }

            db.collection('matches').doc('${matchId}').onSnapshot((doc) => {
              if (!doc.exists) {
                alert('マッチが終了しました。');
                return;
              }
              const data = doc.data();
              const hostChoices = data.hostChoices || {};
              const guestChoices = data.guestChoices || {};
              const isHost = ${isHost};
              const hostResult = hostChoices.result || '対戦中';
              const guestResult = guestChoices.result || '対戦中';
              const hostRatingElement = document.getElementById('hostRating');
              const guestRatingElement = document.getElementById('guestRating');
              const hostResultElement = document.getElementById('hostResult');
              const guestResultElement = document.getElementById('guestResult');
              const buttons = document.querySelectorAll('.result-btn');

              // 結果表示の更新（日本語変換）
              const resultMap = {
                'win': '勝ち',
                'lose': '負け',
                'cancel': '対戦中止',
                '対戦中': '対戦中'
              };
              hostResultElement.innerText = '状態: ' + resultMap[hostResult];
              guestResultElement.innerText = '状態: ' + resultMap[guestResult];

              // ボタン制御
              const isValidResult = 
                (hostChoices.result === 'win' && guestChoices.result === 'lose') ||
                (hostChoices.result === 'lose' && guestChoices.result === 'win') ||
                (hostChoices.result === 'cancel' && guestChoices.result === 'cancel');
              buttons.forEach(btn => {
                if (isValidResult) {
                  btn.classList.add('disabled');
                  btn.style.pointerEvents = 'none';
                  btn.style.cursor = 'not-allowed';
                } else {
                  btn.classList.remove('disabled');
                  btn.style.pointerEvents = 'auto';
                  btn.style.cursor = 'pointer';
                }
              });

              // レート更新（マッチ終了時）
              if (data.status === 'finished' && data.teamRatingChanges) {
                const hostRatingChange = data.teamRatingChanges['${hostId}'] || 0;
                const guestRatingChange = data.teamRatingChanges['${guestId}'] || 0;
                const newHostRating = ${hostTeamRating} + hostRatingChange;
                const newGuestRating = ${guestTeamRating} + guestRatingChange;
                hostRatingElement.innerText = 'レート: ' + newHostRating;
                guestRatingElement.innerText = 'レート: ' + newGuestRating;
              } else {
                hostRatingElement.innerText = 'レート: ${hostTeamRating}';
                guestRatingElement.innerText = 'レート: ${guestTeamRating}';
              }
            });

            // チャットログのリアルタイム更新
            db.collection('matches').doc('${matchId}').collection('messages')
              .orderBy('timestamp', 'asc')
              .onSnapshot((snapshot) => {
                const chatLog = document.getElementById('chatLog');
                chatLog.innerHTML = '';
                snapshot.forEach((doc) => {
                  const msg = doc.data();
                  const messageElement = document.createElement('div');
                  messageElement.className = 'chat-message';
                  messageElement.innerHTML = 
                    '<span class="sender">' + msg.handleName + ':</span>' + 
                    msg.message.replace(/\\n/g, '<br>') + 
                    '<span class="message-time">' + msg.time + '</span>';
                  chatLog.appendChild(messageElement);
                });
                chatLog.scrollTop = chatLog.scrollHeight;
              });
          </script>
        </head>
        <body>
          <div class="match-container">
            <div class="room-id">対戦部屋のID: ${matchData.roomId || '未設定'}</div>
            <div class="player-table">
              <div class="player-info">
                <h2><img src="${hostProfileImage}" alt="${hostName}のプロフィール画像"> ${hostName}</h2>
                <p id="hostRating">レート: ${hostTeamRating}</p>
                <p id="hostResult">状態: 対戦中</p>
              </div>
              <div class="player-info">
                <h2><img src="${guestProfileImage}" alt="${guestName}のプロフィール画像"> ${guestName}</h2>
                <p id="guestRating">レート: ${guestTeamRating}</p>
                <p id="guestResult">状態: 対戦中</p>
              </div>
            </div>
            <div class="chat-container">
              <div class="chat-log" id="chatLog"></div>
              <div class="chat-input">
                <textarea id="messageInput" maxlength="500" oninput="updateCharCount()" placeholder="メッセージを入力..."></textarea>
              </div>
              <div class="chat-controls">
                <span id="charCount">0/500</span>
                <button onclick="sendMessage()">送信</button>
              </div>
            </div>
            <div class="button-group">
              <button class="result-btn" onclick="submitResult('win')">勝ち</button>
              <button class="result-btn" onclick="submitResult('lose')">負け</button>
              <button class="result-btn" onclick="submitResult('cancel')">対戦中止</button>
              <p><a href="/api/team">戻る</a></p>
            </div>
          </div>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('チームセットアップ画面エラー:', {
      message: error.message,
      stack: error.stack,
      code: error.code || 'N/A'
    });
    res.status(500).send(`エラーが発生しました: ${error.message}`);
  }
});

app.post('/api/team/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  const { result } = req.body;

  console.log('POST /api/team/setup/:matchId received:', { matchId, userId, result });

  try {
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const matchSnap = await matchRef.get();
    if (!matchSnap.exists) return res.status(404).send('マッチが見つかりません');

    const matchData = matchSnap.data();
    if (matchData.status === 'finished') {
      return res.status(400).send('このマッチは既に終了しています');
    }

    const isHost = matchData.userId === userId;
    const choicesKey = isHost ? 'hostChoices' : 'guestChoices';
    const opponentChoicesKey = isHost ? 'guestChoices' : 'hostChoices';
    const updateData = {};

    async function updateTeamRatings(winnerId, loserId) {
      const winnerRef = db.collection('users').doc(winnerId);
      const loserRef = db.collection('users').doc(loserId);
      const [winnerSnap, loserSnap] = await Promise.all([winnerRef.get(), loserRef.get()]);
      const winnerTeamRating = winnerSnap.data()?.teamRating || 1500;
      const loserTeamRating = loserSnap.data()?.teamRating || 1500;
      const teamRatingDiff = loserTeamRating - winnerTeamRating;
      const winPoints = teamRatingDiff >= 400 ? 0 : Math.floor(16 + teamRatingDiff * 0.04);
      const losePoints = winPoints;
      await Promise.all([
        winnerRef.update({ teamRating: winnerTeamRating + winPoints }),
        loserRef.update({ teamRating: loserTeamRating - losePoints })
      ]);
      return { winPoints, losePoints };
    }

    // 選択を保存
    updateData[choicesKey] = { ...matchData[choicesKey], result: result || '' };
    updateData[opponentChoicesKey] = matchData[opponentChoicesKey] || {};

    // 両者の選択が揃った場合の処理
    const hostResult = updateData.hostChoices.result;
    const guestResult = updateData.guestChoices.result;
    if (hostResult && guestResult) {
      if (
        (hostResult === 'win' && guestResult === 'lose') ||
        (hostResult === 'lose' && guestResult === 'win')
      ) {
        // 勝ち負けの場合
        updateData.status = 'finished';
        const winnerId = hostResult === 'win' ? matchData.userId : matchData.guestId;
        const loserId = hostResult === 'win' ? matchData.guestId : matchData.userId;
        const { winPoints, losePoints } = await updateTeamRatings(winnerId, loserId);
        updateData.teamRatingChanges = {
          [winnerId]: winPoints,
          [loserId]: -losePoints
        };
      } else if (hostResult === 'cancel' && guestResult === 'cancel') {
        // 両者対戦中止の場合
        updateData.status = 'finished';
        updateData.teamRatingChanges = {
          [matchData.userId]: 0,
          [matchData.guestId]: 0
        };
      }
      // 矛盾する選択（例：両者勝ち、両者負け）の場合は何もしない
    }

    await matchRef.update(updateData);
    console.log('チームマッチデータ更新成功:', { matchId, updateData });
    res.send('OK');
  } catch (error) {
    console.error('チームマッチデータ更新エラー:', {
      message: error.message,
      stack: error.stack,
      code: error.code || 'N/A'
    });
    res.status(500).send(`エラー: ${error.message}`);
  }
});

app.post('/api/team/setup/:matchId/message', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  const { message } = req.body;

  if (!userId) {
    return res.status(401).send('認証が必要です');
  }
  if (!message || typeof message !== 'string') {
    return res.status(400).send('メッセージが必要です');
  }
  if (message.length > 500) {
    return res.status(400).send('メッセージは500文字以内にしてください');
  }

  try {
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const userLimitRef = matchRef.collection('userLimits').doc(userId);
    const messagesRef = matchRef.collection('messages');

    // マッチの存在確認
    const matchSnap = await matchRef.get();
    if (!matchSnap.exists || (matchSnap.data().userId !== userId && matchSnap.data().guestId !== userId)) {
      return res.status(403).send('このマッチにアクセスする権限がありません');
    }

    // ルーム全体の制限チェック
    const matchData = matchSnap.data();
    const totalMessages = matchData.totalMessages || 0;
    const totalChars = matchData.totalChars || 0;
    if (totalMessages >= 100) {
      return res.status(400).send('このルームのメッセージ回数上限（100回）に達しました');
    }
    if (totalChars + message.length > 10000) {
      return res.status(400).send('このルームの文字数上限（10,000文字）に達しました');
    }

    // ユーザーごとの制限チェック
    const userLimitSnap = await userLimitRef.get();
    let userLimitData = userLimitSnap.exists ? userLimitSnap.data() : { messageCount: 0, lastReset: null, totalChars: 0 };
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);

    if (!userLimitData.lastReset || new Date(userLimitData.lastReset) < oneMinuteAgo) {
      userLimitData = { messageCount: 0, lastReset: now.toISOString(), totalChars: userLimitData.totalChars };
    }
    if (userLimitData.messageCount >= 10) {
      return res.status(400).send('1分間の送信回数上限（10回）に達しました。しばらくお待ちください');
    }

    // JSTで送信時間（hh:mm）を生成
    const jstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);

    // メッセージ保存
    const userSnap = await db.collection('users').doc(userId).get();
    const handleName = userSnap.data()?.handleName || '不明';
    await messagesRef.add({
      userId,
      handleName,
      message,
      timestamp: now.toISOString(),
      time: jstTime
    });

    // 制限データの更新
    await userLimitRef.set({
      messageCount: userLimitData.messageCount + 1,
      lastReset: userLimitData.lastReset,
      totalChars: userLimitData.totalChars + message.length
    }, { merge: true });

    await matchRef.update({
      totalMessages: totalMessages + 1,
      totalChars: totalChars + message.length
    });

    res.send('OK');
  } catch (error) {
    console.error('メッセージ送信エラー:', {
      message: error.message,
      stack: error.stack,
      code: error.code || 'N/A'
    });
    res.status(500).send(`エラー: ${error.message}`);
  }
});

app.listen(3000, () => console.log('サーバー起動: http://localhost:3000'));