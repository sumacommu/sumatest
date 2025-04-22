const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { createClient } = require('redis');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, collection, query, where, addDoc, updateDoc, deleteDoc, getDocs } = require('firebase/firestore');
const EventEmitter = require('events');
require('dotenv').config();

const app = express();

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
  projectId: process.env.FIREBASE_PROJECT_ID
});

const redisClient = createClient({
  url: 'rediss://default:AdSZAAIjcDE2Y2MwY2U4Zjk3ZmQ0YjI0ODM3M2QyMzM5Nzk0M2ZlYnAxMA@present-civet-54425.upstash.io:6379',
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
    const userRef = doc(db, 'users', profile.id);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) {
      const userData = {
        displayName: profile.displayName,
        email: profile.emails[0].value,
        photoUrl: profile.photos[0].value,
        createdAt: new Date().toISOString(),
        matchCount: 0,
        reportCount: 0,
        validReportCount: 0,
        penalty: false,
        rating: 1500
      };
      await setDoc(userRef, userData);
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
    const userSnap = await getDoc(doc(db, 'users', id));
    if (!userSnap.exists()) {
      console.error('ユーザーが見つかりません:', id);
      return done(null, false);
    }
    const userData = userSnap.data();
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

app.get('/api/', async (req, res) => {
  console.log('ルートアクセス、req.session:', req.session);
  console.log('ルートアクセス、req.user:', req.user);
  if (req.user) {
    const userData = req.user;
    res.send(`
      <html><body>
        <h1>こんにちは、${userData.displayName}さん！</h1>
        <img src="${userData.photoUrl}" alt="プロフィール画像" width="50">
        <p><a href="/api/solo">タイマン用</a></p>
        <p><a href="/api/team">チーム用</a></p>
        <p><a href="/api/logout">ログアウト</a></p>
      </body></html>
    `);
  } else {
    res.send(`
      <html><body>
        <h1>スマブラマッチング</h1>
        <p><a href="/api/solo">タイマン用</a></p>
        <p><a href="/api/team">チーム用</a></p>
        <p><a href="/api/auth/google?redirect=/api/">Googleでログイン</a></p>
      </body></html>
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
    const rating = req.user.rating || 1500;
    html += `
      <form action="/api/solo/match" method="POST">
        <button type="submit">マッチング開始</button>
      </form>
      <p>現在のレート: ${rating}</p>
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
          <p>相手を待っています... あなたのレート: ${req.user.rating || 1500}</p>
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

// タイマン用マッチング処理
app.post('/api/solo/match', async (req, res) => {
  if (!req.user || !req.user.id) {
    console.error('ユーザー情報が不正:', req.user);
    return res.redirect('/api/solo');
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
      const guestData = docSnap.data();
      if (!guestData.roomId) continue;
      const guestRef = doc(db, 'users', guestData.userId);
      const guestSnap = await getDoc(guestRef);
      const guestRating = guestSnap.exists() ? (guestSnap.data().rating || 1500) : 1500;
      if (Math.abs(userRating - guestRating) <= 200) {
        await updateDoc(docSnap.ref, {
          guestId: userId,
          status: 'matched',
          step: 'character_selection',
          timestamp: new Date().toISOString(),
          hostChoices: { wins: 0, losses: 0 },
          guestChoices: { wins: 0, losses: 0 }
        });
        console.log(`マッチ成立: matchId=${docSnap.id}, hostId=${guestData.userId}, guestId=${userId}`);
        matched = true;
        res.redirect(`/api/solo/setup/${docSnap.id}`);
        break;
      }
    }

    if (!matched) {
      const matchRef = await addDoc(matchesRef, {
        userId: userId,
        type: 'solo',
        status: 'waiting',
        roomId: '',
        timestamp: new Date().toISOString(),
        hostChoices: { wins: 0, losses: 0 },
        guestChoices: { wins: 0, losses: 0 }
      });
      console.log(`マッチ作成: matchId=${matchRef.id}, hostId=${userId}`);
      res.redirect('/api/solo/check');
    }
  } catch (error) {
    console.error('マッチングエラー:', error.message, error.stack);
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
  if (!userId) {
    console.log('ユーザー未認証、リダイレクト:', matchId);
    return res.redirect('/api/solo');
  }

  const matchRef = doc(db, 'matches', matchId);
  const matchSnap = await getDoc(matchRef);
  if (!matchSnap.exists() || (matchSnap.data().userId !== userId && matchSnap.data().guestId !== userId)) {
    console.error(`マッチが見つかりません: matchId=${matchId}, userId=${userId}`);
    return res.send('マッチが見つかりません');
  }

  const matchData = matchSnap.data();
  const isHost = matchData.userId === userId;
  const hostId = matchData.userId;
  const guestId = matchData.guestId || '';
  const hostRef = doc(db, 'users', hostId);
  const guestRef = doc(db, 'users', guestId);
  const hostSnap = await getDoc(hostRef);
  const guestSnap = await getDoc(guestRef);
  const hostName = hostSnap.data().displayName || '不明';
  const guestName = guestSnap.data().displayName || '不明';
  const hostRating = hostSnap.data().rating || 1500;
  const guestRating = guestSnap.data().rating || 1500;

  const hostChoices = matchData.hostChoices || { wins: 0, losses: 0 };
  const guestChoices = matchData.guestChoices || { wins: 0, losses: 0 };
  console.log('初期hostChoices:', hostChoices, '初期guestChoices:', guestChoices);

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
    { id: 'BattleField', name: '戦場' },
    { id: 'Final Destination', name: '終点' },
    { id: 'Hollow Bastion', name: 'ホロウバスティオン' },
    { id: 'Pokemon Stadium 2', name: 'ポケモンスタジアム2' },
    { id: 'Small Battlefield', name: '小戦場' },
    { id: 'Town and City', name: '村と街' },
    { id: 'Smashville', name: 'すま村' }
  ];
  const bannedStages = [...(hostChoices.bannedStages || []), ...(guestChoices.bannedStages || [])];

  res.send(`
    <html>
      <head>
        <style>
          .overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); z-index: 1; }
          .popup { display: none; position: fixed; top: 20%; left: 20%; width: 60%; height: 60%; background: white; border: none; overflow: auto; z-index: 2; }
          .popup img { width: 64px; height: 64px; margin: 5px; }
          .section { margin: 20px 0; }
          #miiInput { display: none; }
          .char-btn { opacity: 0.3; transition: opacity 0.3s; border: none; background: none; padding: 0; }
          .char-btn.selected { opacity: 1; }
          .char-btn.disabled { opacity: 0.5; pointer-events: none; }
          .stage-btn { transition: opacity 0.3s, filter 0.3s; border: none; background: none; padding: 0; }
          .stage-btn.disabled { pointer-events: none; }
          .stage-btn.enabled { pointer-events: auto; }
          .stage-btn.selected { opacity: 0.5; }
          .stage-btn.banned { filter: grayscale(100%); opacity: 0.3; }
          .stage-btn.extra { filter: grayscale(100%); }
          .char-display { margin: 10px 0; }
          .char-display img { width: 64px; height: 64px; opacity: 0; }
          .char-display img.selected { opacity: 1; }
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
  var selectedStages = ${JSON.stringify(bannedStages)};
  var hostChoices = ${JSON.stringify(hostChoices)};
  var guestChoices = ${JSON.stringify(guestChoices)};
  var isHost = ${isHost};
  var hostName = '${hostName}';
  var guestName = '${guestName}';

  function selectCharacter(id, name) {
    selectedChar = id;
    document.getElementById('charPopup').style.display = 'none';
    document.getElementById('overlay').style.display = 'none';
    var miiInput = document.getElementById('miiInput');
    if (['54', '55', '56'].includes(id)) {
      miiInput.style.display = 'block';
    } else {
      miiInput.style.display = 'none';
    }
    document.querySelectorAll('.char-btn').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.id === id);
    });
    document.getElementById('charStatus').innerText = 'キャラクターを選択しました。決定ボタンを押してください。';
  }

  function selectStage(id) {
    var matchCount = (hostChoices.wins || 0) + (hostChoices.losses || 0);
    var maxBanned = matchCount === 0 ? (isHost ? 1 : 2) : 2;
    var index = selectedStages.indexOf(id);
    if (matchCount === 0) {
      if (isHost && (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0)) {
        if (index !== -1) selectedStages.splice(index, 1);
        else if (selectedStages.length < 1) selectedStages = [id];
      } else if (!isHost && hostChoices.bannedStages && (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
        if (index !== -1) selectedStages.splice(index, 1);
        else if (selectedStages.length < maxBanned) selectedStages.push(id);
      }
    } else {
      var isHostWinner = (hostChoices.wins || 0) > (guestChoices.wins || 0);
      if ((isHost && isHostWinner || !isHost && !isHostWinner) && (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0)) {
        if (index !== -1) selectedStages.splice(index, 1);
        else if (selectedStages.length < maxBanned) selectedStages.push(id);
      } else if ((isHost && !isHostWinner || !isHost && isHostWinner) && hostChoices.bannedStages && !data.selectedStage) {
        selectedChar = id; // 敗者がステージを選択
      }
    }
    updateStageButtons();
  }

  function updateStageButtons() {
    document.querySelectorAll('.stage-btn').forEach(btn => {
      btn.classList.remove('selected', 'banned');
      var banned = [...(hostChoices.bannedStages || []), ...(guestChoices.bannedStages || [])];
      if (selectedStages.includes(btn.dataset.id)) {
        btn.classList.add('selected');
      } else if (banned.includes(btn.dataset.id)) {
        btn.classList.add('banned');
      }
    });
  }

  async function saveSelections(matchId, result) {
    var data = {};
    if (result) {
      data.result = result;
    } else {
      var matchCount = (hostChoices.wins || 0) + (hostChoices.losses || 0);
      if (selectedChar && !data.selectedStage) {
        data.characterReady = true;
        data['character' + (matchCount + 1)] = selectedChar;
      }
      var miiMoves = ['54', '55', '56'].includes(selectedChar) ? document.getElementById('miiMoves').value : '';
      if (miiMoves) data['miiMoves' + (matchCount + 1)] = miiMoves;
      if (selectedStages.length > 0) data.bannedStages = selectedStages;
      if (matchCount > 0 && selectedChar && !data['character' + (matchCount + 1)]) {
        data.selectedStage = selectedChar; // 敗者のステージ選択
      }
    }

    try {
      var response = await fetch('/api/solo/setup/' + matchId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      var resultText = await response.text();
      if (!response.ok) {
        alert('保存に失敗しました: ' + resultText);
        return;
      }
      if (!result) {
        selectedChar = '';
        selectedStages = [];
      }
      updateStageButtons();
    } catch (error) {
      alert('ネットワークエラー: ' + error.message);
    }
  }

  db.collection('matches').doc('${matchId}').onSnapshot(function(doc) {
    if (!doc.exists) {
      console.error('ドキュメントが存在しません');
      return;
    }
    var data = doc.data();
    hostChoices = data.hostChoices || { wins: 0, losses: 0 };
    guestChoices = data.guestChoices || { wins: 0, losses: 0 };
    var matchCount = data.matchCount || (hostChoices.wins || 0) + (hostChoices.losses || 0);
    var isHostWinner = (hostChoices.wins || 0) > (guestChoices.wins || 0);

    // デバッグログ追加
    console.log('matchCount:', matchCount);
    console.log('isHostWinner:', isHostWinner);
    console.log('hostChoices.bannedStages:', hostChoices.bannedStages);
    console.log('guestChoices.bannedStages:', guestChoices.bannedStages);
    console.log('data.selectedStage:', data.selectedStage);

    // 試合状況の表示
    document.getElementById('matchStatus').innerText = '現在の試合: ' + (matchCount + 1) + '戦目';
    var history = '';
    if (hostChoices.wins > 0 || guestChoices.wins > 0) {
      history = '勝敗履歴: ';
      for (var i = 1; i <= matchCount; i++) {
        if (hostChoices.wins >= i) {
          history += i + '戦目の勝者: ' + hostName + ' ';
        } else if (guestChoices.wins >= i) {
          history += i + '戦目の勝者: ' + guestName + ' ';
        }
      }
    }
    document.getElementById('matchHistory').innerText = history;

    // 試合終了チェック
    if (data.status === 'finished') {
      var winner = hostChoices.wins >= 2 ? hostName : guestName;
      document.getElementById('guide').innerText = '試合終了！勝者: ' + winner;
      document.querySelectorAll('.char-btn, .stage-btn, button').forEach(btn => btn.disabled = true);
      return;
    }

    var bothCharsReady = hostChoices.characterReady && guestChoices.characterReady;
    document.getElementById('hostStatus').innerText = hostName + 'の選択: ' + (hostChoices.characterReady ? '完了' : '未選択');
    document.getElementById('guestStatus').innerText = guestName + 'の選択: ' + (guestChoices.characterReady ? '完了' : '未選択');

    var guideText = '';
    var canSelectChar = false;
    var canSelectStage = false;

    if (matchCount === 0) {
      // 1戦目: ホスト・ゲスト同時選択可能
      if (!hostChoices.characterReady || !guestChoices.characterReady) {
        guideText = 'キャラクターを選択してください（' + (isHost ? hostName : guestName) + '）';
        canSelectChar = !hostChoices.characterReady && isHost || !guestChoices.characterReady && !isHost;
      } else if (bothCharsReady && isHost && (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0)) {
        guideText = '拒否ステージを1つ選んでください（' + hostName + '）';
        canSelectStage = true;
      } else if (bothCharsReady && isHost && hostChoices.bannedStages && (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
        guideText = guestName + 'が拒否ステージを選んでいます...';
      } else if (bothCharsReady && !isHost && hostChoices.bannedStages && (!guestChoices.bannedStages || guestChoices.bannedStages.length === 0)) {
        guideText = '拒否ステージを2つ選んでください（' + guestName + '）';
        canSelectStage = true;
      } else if (bothCharsReady && !isHost && (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0)) {
        guideText = hostName + 'が拒否ステージを選んでいます...';
      } else if (bothCharsReady && isHost && guestChoices.bannedStages) {
        guideText = '表示されている残りのステージから選び、対戦を開始してください（' + hostName + '）';
      } else if (bothCharsReady && !isHost && hostChoices.bannedStages && guestChoices.bannedStages) {
        guideText = 'ステージを「おまかせ」に設定し、対戦を開始してください（' + guestName + '）';
      }
    } else {
      // 2戦目以降
      if ((isHost && isHostWinner || !isHost && !isHostWinner) && (!hostChoices.bannedStages || hostChoices.bannedStages.length === 0)) {
        guideText = '拒否ステージを2つ選んでください（' + (isHost ? hostName : guestName) + '）';
        canSelectStage = true;
      } else if ((isHost && !isHostWinner || !isHost && isHostWinner) && hostChoices.bannedStages && !data.selectedStage) {
        guideText = '対戦するステージを選んでください（' + (isHost ? hostName : guestName) + '）';
        canSelectStage = true;
      } else if ((isHost && isHostWinner || !isHost && !isHostWinner) && data.selectedStage && !hostChoices['character' + (matchCount + 1)]) {
        guideText = 'キャラクターを選択してください（' + (isHost ? hostName : guestName) + '）';
        canSelectChar = true;
      } else if ((isHost && !isHostWinner || !isHost && isHostWinner) && hostChoices['character' + (matchCount + 1)] && !guestChoices['character' + (matchCount + 1)]) {
        guideText = 'キャラクターを選択してください（' + (isHost ? hostName : guestName) + '）';
        canSelectChar = true;
      } else if (hostChoices['character' + (matchCount + 1)] && guestChoices['character' + (matchCount + 1)]) {
        guideText = 'ステージを「おまかせ」に設定し、選んだキャラクターで対戦を始めてください（' + (isHost ? hostName : guestName) + '）';
      }
    }

    document.getElementById('guide').innerText = guideText;
    document.querySelectorAll('.char-btn').forEach(btn => {
      btn.classList.toggle('disabled', !canSelectChar);
    });
    document.querySelectorAll('.stage-btn').forEach(btn => {
      var banned = [...(hostChoices.bannedStages || []), ...(guestChoices.bannedStages || [])];
      btn.classList.remove('disabled', 'enabled', 'selected', 'banned');
      if (banned.includes(btn.dataset.id)) btn.classList.add('banned');
      if (canSelectStage) {
        btn.classList.add('enabled');
        btn.style.pointerEvents = 'auto';
        btn.onclick = () => selectStage(btn.dataset.id);
      } else {
        btn.classList.add('disabled');
        btn.style.pointerEvents = 'none';
        btn.onclick = null;
      }
    });

    // キャラクター表示制御
    var displayChar = bothCharsReady || matchCount > 0 && (isHost && !isHostWinner || !isHost && isHostWinner) && hostChoices['character' + (matchCount + 1)] ? (hostChoices['character' + (matchCount + 1)] || '00') : '00';
    var displayMoves = bothCharsReady || matchCount > 0 && (isHost && !isHostWinner || !isHost && isHostWinner) && hostChoices['character' + (matchCount + 1)] ? (hostChoices['miiMoves' + (matchCount + 1)] || '') : '';
    var guestDisplayChar = bothCharsReady ? (guestChoices['character' + (matchCount + 1)] || '00') : '00';
    var guestDisplayMoves = bothCharsReady ? (guestChoices['miiMoves' + (matchCount + 1)] || '') : '';
    document.querySelector('.char-display').innerHTML = 
      '<p>' + hostName + 'のキャラクター: <img src="/characters/' + displayChar + '.png" class="' + (displayChar !== '00' ? 'selected' : '') + '"> ' + displayMoves + '</p>' +
      '<p>' + guestName + 'のキャラクター: <img src="/characters/' + guestDisplayChar + '.png" class="' + (guestDisplayChar !== '00' ? 'selected' : '') + '"> ' + guestDisplayMoves + '</p>';
  }, function(error) {
    console.error('onSnapshotエラー:', error);
  });
</script>
      </head>
<body>
  <div class="overlay" id="overlay"></div>
  <h1>マッチング成立！</h1>
  <p>ホスト: ${hostName} (レート: ${hostRating})</p>
  <p>ゲスト: ${guestName} (レート: ${guestRating})</p>
  <p>対戦部屋のID: ${matchData.roomId || '未設定'}</p>
  <p id="matchStatus">現在の試合: 1戦目</p>
  <p id="matchHistory">勝敗履歴: なし</p>
  <p id="hostStatus">${hostName}の選択: ${hostChoices.character1 ? '完了' : '未選択'}</p>
  <p id="guestStatus">${guestName}の選択: ${guestChoices.character1 ? '完了' : '未選択'}</p>
  <p id="charStatus"></p>
  <p id="guide"></p>

  <div class="section">
    <h2>キャラクター選択</h2>
    ${popularCharacters.map(char => `
      <button class="popular char-btn" data-id="${char.id}" onclick="selectCharacter('${char.id}', '${char.name}')">
        <img src="/characters/${char.id}.png">
      </button>
    `).join('')}
    <button onclick="document.getElementById('charPopup').style.display='block';document.getElementById('overlay').style.display='block';">全キャラから選ぶ</button>
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

  <div class="char-display">
    <p>${hostName}のキャラクター: <img src="/characters/${hostChoices.character1 || '00'}.png" class="${hostChoices.character1 ? 'selected' : ''}"> ${hostChoices.miiMoves1 || ''}</p>
    <p>${guestName}のキャラクター: <img src="/characters/${guestChoices.character1 || '00'}.png" class="${guestChoices.character1 ? 'selected' : ''}"> ${guestChoices.miiMoves1 || ''}</p>
  </div>

  <div class="section">
    <h2>ステージ選択</h2>
    ${stages.map(stage => `
      <button class="stage-btn disabled ${bannedStages.includes(stage.id) ? 'banned' : ''} ${['Town and City', 'Smashville'].includes(stage.id) ? 'extra' : ''}" data-id="${stage.id}">
        <img src="/stages/${stage.id}.png">
      </button>
    `).join('')}
  </div>

  <button onclick="saveSelections('${matchId}')">決定</button>
  <button onclick="saveSelections('${matchId}', 'win')">勝ち</button>
  <button onclick="saveSelections('${matchId}', 'lose')">負け</button>
  <p><a href="/api/solo">戻る</a></p>
</body>
    </html>
  `);
});

app.post('/api/solo/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  const { character1, character2, character3, miiMoves1, miiMoves2, miiMoves3, bannedStages, result, characterReady, selectedStage } = req.body;

  const matchRef = doc(db, 'matches', matchId);
  const matchSnap = await getDoc(matchRef);
  if (!matchSnap.exists()) return res.status(404).send('マッチが見つかりません');

  const matchData = matchSnap.data();
  const isHost = matchData.userId === userId;
  const choicesKey = isHost ? 'hostChoices' : 'guestChoices';
  const opponentChoicesKey = isHost ? 'guestChoices' : 'hostChoices';
  const updateData = {};

  if (result) {
    updateData[choicesKey] = { ...matchData[choicesKey], result };
    const opponentChoices = matchData[opponentChoicesKey];
    if (opponentChoices.result && (
      (result === 'win' && opponentChoices.result === 'lose') ||
      (result === 'lose' && opponentChoices.result === 'win')
    )) {
      const hostWins = matchData.hostChoices.wins || 0;
      const guestWins = matchData.guestChoices.wins || 0;
      updateData.hostChoices = { ...matchData.hostChoices, result: '', characterReady: false, bannedStages: [], selectedStage: '' };
      updateData.guestChoices = { ...matchData.guestChoices, result: '', characterReady: false, bannedStages: [], selectedStage: '' };
      if (result === 'win' && isHost || result === 'lose' && !isHost) {
        updateData.hostChoices.wins = hostWins + 1;
        updateData.guestChoices.losses = (matchData.guestChoices.losses || 0) + 1;
      } else {
        updateData.guestChoices.wins = guestWins + 1;
        updateData.hostChoices.losses = (matchData.hostChoices.losses || 0) + 1;
      }
      updateData.matchCount = (matchData.matchCount || 0) + 1;
      if (updateData.hostChoices.wins >= 2 || updateData.guestChoices.wins >= 2) {
        updateData.status = 'finished';
      }
    }
  } else {
    const matchCount = matchData.hostChoices.wins + matchData.hostChoices.losses;
    updateData[choicesKey] = { ...matchData[choicesKey] };
    if (characterReady) updateData[choicesKey].characterReady = true;
    if (character1 !== undefined) updateData[choicesKey].character1 = character1;
    if (character2 !== undefined) updateData[choicesKey].character2 = character2;
    if (character3 !== undefined) updateData[choicesKey].character3 = character3;
    if (miiMoves1 !== undefined) updateData[choicesKey].miiMoves1 = miiMoves1;
    if (miiMoves2 !== undefined) updateData[choicesKey].miiMoves2 = miiMoves2;
    if (miiMoves3 !== undefined) updateData[choicesKey].miiMoves3 = miiMoves3;
    if (bannedStages) updateData[choicesKey].bannedStages = bannedStages;
    if (selectedStage) updateData.selectedStage = selectedStage; // 敗者のステージ選択を保存
  }

  await updateDoc(matchRef, updateData);
  res.send('OK');
});

// ID更新処理
app.post('/api/solo/update', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/api/solo');
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
    res.redirect('/api/solo/check');
  } catch (error) {
    console.error('ID更新エラー:', error.message, error.stack);
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

// チーム用ページ（仮）
app.get('/api/team', async (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>チーム用ページ</h1>
        <p>準備中です</p>
        <p><a href="/api/">戻る</a></p>
      </body>
    </html>
  `);
});

app.listen(3000, () => console.log('サーバー起動: http://localhost:3000'));