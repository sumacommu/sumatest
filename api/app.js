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
      await setDoc(userRef, {
        displayName: profile.displayName,
        email: profile.emails[0].value,
        photoUrl: profile.photos[0].value,
        createdAt: new Date().toISOString(),
        matchCount: 0,
        reportCount: 0,
        validReportCount: 0,
        penalty: false,
        rating: 1500
      });
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
      return done(new Error('ユーザーが見つかりません'));
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
            }, 2000); // 2秒ごとにチェック
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
      const opponentData = docSnap.data();
      if (!opponentData.roomId) continue; // 部屋IDが未設定ならスキップ
      const opponentRef = doc(db, 'users', opponentData.userId);
      const opponentSnap = await getDoc(opponentRef);
      const opponentRating = opponentSnap.exists() ? (opponentSnap.data().rating || 1500) : 1500;
      if (Math.abs(userRating - opponentRating) <= 200) {
        await updateDoc(docSnap.ref, {
          opponentId: userId,
          status: 'matched',
          step: 'character_selection',
          timestamp: new Date().toISOString()
        });
        console.log(`マッチ成立: matchId=${docSnap.id}, userId=${userId}（②側）, opponentId=${opponentData.userId}（①側）`);
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
        roomId: '', // 初期値は空、後に更新
        timestamp: new Date().toISOString()
      });
      console.log(`マッチ作成: matchId=${matchRef.id}, userId=${userId}（①側）`);
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

// セットアップ画面（遷移制御をサーバーに移行）
app.get('/api/solo/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  if (!userId) return res.redirect('/api/solo');

  const matchRef = doc(db, 'matches', matchId);
  const matchSnap = await getDoc(matchRef);
  if (!matchSnap.exists() || (matchSnap.data().userId !== userId && matchSnap.data().opponentId !== userId)) {
    return res.send('マッチが見つかりません');
  }

  const matchData = matchSnap.data();
  const isPlayer1 = matchData.userId === userId;
  const opponentId = isPlayer1 ? matchData.opponentId : matchData.userId;
  const opponentRef = doc(db, 'users', opponentId);
  const opponentSnap = await getDoc(opponentRef);
  const opponentName = opponentSnap.data().displayName || '不明';
  const opponentRating = opponentSnap.data().rating || 1500;

  const player1Choices = matchData.player1Choices || {};
  const player2Choices = matchData.player2Choices || {};
  const myChoices = isPlayer1 ? player1Choices : player2Choices;
  const opponentChoices = isPlayer1 ? player2Choices : player1Choices;

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
    { id: 'Small Battlefield', name: '小戦場' }
  ];

  const firebaseConfigScript = `
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
  `;

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
          .stage-btn { transition: opacity 0.3s; border: none; background: none; padding: 0; pointer-events: none; }
        </style>
        <script type="module">
          import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js';
          import { getFirestore, onSnapshot, doc } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js';

          const firebaseConfig = {
            apiKey: "${process.env.FIREBASE_API_KEY}",
            authDomain: "${process.env.FIREBASE_AUTH_DOMAIN}",
            projectId: "${process.env.FIREBASE_PROJECT_ID}",
            storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET}",
            messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
            appId: "${process.env.FIREBASE_APP_ID}",
            measurementId: "${process.env.FIREBASE_MEASUREMENT_ID}"
          };
          const app = initializeApp(firebaseConfig);
          console.log('Firebase初期化完了');
          const db = getFirestore(app);

          let selectedChar = '${myChoices.character || ''}';

          function selectCharacter(id, name) {
            selectedChar = id;
            document.getElementById('charPopup').style.display = 'none';
            document.getElementById('overlay').style.display = 'none';
            const miiInput = document.getElementById('miiInput');
            if (['54', '55', '56'].includes(id)) {
              miiInput.style.display = 'block';
            } else {
              miiInput.style.display = 'none';
            }
            document.querySelectorAll('.char-btn').forEach(btn => {
              btn.classList.toggle('selected', btn.dataset.id === id);
            });
          }

          async function saveSelections(matchId) {
            if (!selectedChar) {
              alert('キャラクターを選択してください');
              return;
            }
            const miiMoves = ['54', '55', '56'].includes(selectedChar) ? document.getElementById('miiMoves').value : '';
            const data = { character: selectedChar };
            if (miiMoves) data.miiMoves = miiMoves;

            try {
              const response = await fetch('/api/solo/setup/' + matchId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
              const result = await response.text();
              if (!response.ok) {
                alert('保存に失敗しました: ' + result);
                return;
              }
              if (result === 'NEXT') {
                window.location.href = '/api/solo/ban/' + matchId;
              }
            } catch (error) {
              alert('ネットワークエラー: ' + error.message);
            }
          }

          onSnapshot(doc(db, 'matches', '${matchId}'), (doc) => {
            console.log('onSnapshot発火');
            const data = doc.data();
            const isPlayer1 = '${userId}' === data.userId;
            const myChoices = isPlayer1 ? data.player1Choices : data.player2Choices;
            const opponentChoices = isPlayer1 ? data.player2Choices : data.player1Choices;

            document.getElementById('myStatus').innerText = 'あなたの選択: ' + (myChoices?.character ? '完了' : '未選択');
            document.getElementById('opponentStatus').innerText = '相手の選択: ' + (opponentChoices?.character ? '完了' : '未選択');
            document.getElementById('guide').innerHTML = myChoices?.character && !opponentChoices?.character 
              ? '相手の選択を待っています...' 
              : (myChoices?.character && opponentChoices?.character 
                ? '次のステップへ: <a href="/api/solo/ban/${matchId}">ステージ拒否</a>' 
                : 'キャラクターを選んでください');
            if (myChoices?.character && opponentChoices?.character) {
              window.location.href = '/api/solo/ban/${matchId}';
            }
          }, (error) => {
            console.error('onSnapshotエラー:', error);
          });
        </script>
      </head>
      <body>
        <div class="overlay" id="overlay"></div>
        <h1>マッチング成立！</h1>
        <p>相手: ${opponentName} (レート: ${opponentRating})</p>
        <p>対戦部屋のID: ${matchData.roomId || '未設定'}</p>
        <p id="myStatus">あなたの選択: ${myChoices.character ? '完了' : '未選択'}</p>
        <p id="opponentStatus">相手の選択: ${opponentChoices.character ? '完了' : '未選択'}</p>
        <p id="guide">${myChoices.character && !opponentChoices.character ? '相手の選択を待っています...' : (myChoices.character && opponentChoices.character ? '次のステップへ: <a href="/api/solo/ban/' + matchId + '">ステージ拒否</a>' : 'キャラクターを選んでください')}</p>
        <!-- 残りのHTMLはそのまま -->
        <button onclick="saveSelections('${matchId}')">決定</button>
        <p><a href="/api/solo">戻る</a></p>
      </body>
    </html>
  `);
});

// POST（サーバー側で遷移制御）
app.post('/api/solo/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  if (!userId) return res.status(401).send('ログインが必要です');

  const { character, miiMoves } = req.body;
  console.log(`POST /api/solo/setup/${matchId} 受信データ:`, { character, miiMoves, userId });
  if (!character) return res.status(400).send('キャラクターが必要です');

  const matchRef = doc(db, 'matches', matchId);
  const matchSnap = await getDoc(matchRef);
  if (!matchSnap.exists() || (matchSnap.data().userId !== userId && matchSnap.data().opponentId !== userId)) {
    console.error(`マッチが見つかりません: matchId=${matchId}, userId=${userId}`);
    return res.status(404).send('マッチが見つかりません');
  }

  const matchData = matchSnap.data();
  console.log(`マッチデータ:`, matchData);
  const isPlayer1 = matchData.userId === userId;
  const choices = { character };
  if (miiMoves) choices.miiMoves = miiMoves;

  const updateData = {
    ...(isPlayer1 ? { player1Choices: choices } : { player2Choices: choices }),
    step: matchData.step || 'character_selection'
  };

  const player1HasChosen = (isPlayer1 ? choices.character : matchData.player1Choices?.character);
  const player2HasChosen = (!isPlayer1 ? choices.character : matchData.player2Choices?.character);
  console.log(`選択状況: player1HasChosen=${player1HasChosen}, player2HasChosen=${player2HasChosen}, isPlayer1=${isPlayer1}`);
  if (player1HasChosen && player2HasChosen) {
    updateData.step = 'stage_ban_1';
    console.log(`両者選択済み、ステップ更新: step=stage_ban_1, matchId=${matchId}`);
  } else {
    console.log(`片方のみ選択済み、ステップ維持: step=${updateData.step}`);
  }

  await updateDoc(matchRef, updateData);
  console.log(`マッチデータ更新成功: matchId=${matchId}, updateData=`, updateData);
  res.send(player1HasChosen && player2HasChosen ? 'NEXT' : 'OK');
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

// ステージ拒否画面（①②修正＋リアルタイム更新強化）
app.get('/api/solo/ban/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  if (!userId) return res.redirect('/api/solo');

  const matchRef = doc(db, 'matches', matchId);
  const matchSnap = await getDoc(matchRef);
  if (!matchSnap.exists() || (matchSnap.data().userId !== userId && matchSnap.data().opponentId !== userId)) {
    return res.send('マッチが見つかりません');
  }

  const matchData = matchSnap.data();
  const isPlayer1 = matchData.userId === userId; // ①側: userId, ②側: opponentId
  console.log(`ban画面: userId=${userId}, matchData.userId=${matchData.userId}, matchData.opponentId=${matchData.opponentId}, isPlayer1=${isPlayer1}`);
  const opponentId = isPlayer1 ? matchData.opponentId : matchData.userId;
  const opponentRef = doc(db, 'users', opponentId);
  const opponentSnap = await getDoc(opponentRef);
  const opponentName = opponentSnap.data().displayName || '不明';

  const player1Choices = matchData.player1Choices || {};
  const player2Choices = matchData.player2Choices || {};
  const myChoices = isPlayer1 ? player1Choices : player2Choices;
  const opponentChoices = isPlayer1 ? player2Choices : player1Choices;

  const stages = [
    { id: 'BattleField', name: '戦場' },
    { id: 'Final Destination', name: '終点' },
    { id: 'Hollow Bastion', name: 'ホロウバスティオン' },
    { id: 'Pokemon Stadium 2', name: 'ポケモンスタジアム2' },
    { id: 'Small Battlefield', name: '小戦場' }
  ];

  const bannedStages = [...(player1Choices.bannedStages || []), ...(player2Choices.bannedStages || [])];
  const availableStages = stages.filter(stage => !bannedStages.includes(stage.id));

  let guideText = '';
  if (isPlayer1 && !player1Choices.bannedStages) {
    guideText = '拒否ステージを1つ選んでください（①側）。';
  } else if (isPlayer1 && player1Choices.bannedStages && !player2Choices.bannedStages) {
    guideText = '相手（②側）が拒否ステージを選んでいます...';
  } else if (!isPlayer1 && player1Choices.bannedStages && !player2Choices.bannedStages) {
    guideText = '拒否ステージを2つ選んでください（②側）。';
  } else if (!isPlayer1 && !player1Choices.bannedStages) {
    guideText = '相手が拒否ステージを選んでいます...（②側）';
  } else if (player1Choices.bannedStages && player2Choices.bannedStages) {
    guideText = isPlayer1
      ? '表示されている残りのステージから選び、対戦を開始してください（①側）。'
      : 'ステージを「おまかせ」に設定し、対戦を開始してください（②側）。';
  }

  const firebaseConfigScript = `
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
  `;

  res.send(`
    <html>
      <head>
        <style>
          .stage-btn { transition: opacity 0.3s, filter 0.3s; border: none; background: none; padding: 0; }
          .stage-btn.selected { opacity: 0.3; }
          .stage-btn.banned { filter: grayscale(100%); }
          .char-display { margin: 10px 0; }
        </style>
        <script type="module">
          import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js';
          import { getFirestore, onSnapshot, doc } from 'https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js';

          const firebaseConfig = {
            apiKey: "${process.env.FIREBASE_API_KEY}",
            authDomain: "${process.env.FIREBASE_AUTH_DOMAIN}",
            projectId: "${process.env.FIREBASE_PROJECT_ID}",
            storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET}",
            messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
            appId: "${process.env.FIREBASE_APP_ID}",
            measurementId: "${process.env.FIREBASE_MEASUREMENT_ID}"
          };
          const app = initializeApp(firebaseConfig);
          console.log('Firebase初期化完了');
          const db = getFirestore(app);

          let selectedStages = ${JSON.stringify(myChoices.bannedStages || [])};
          let finalStage = '${myChoices.finalStage || ''}';

          function selectStage(id) {
            const isPlayer1 = ${isPlayer1};
            if (isPlayer1 && !${JSON.stringify(player1Choices.bannedStages)} && selectedStages.length < 1) {
              selectedStages = [id];
            } else if (!isPlayer1 && ${JSON.stringify(player1Choices.bannedStages)} && !${JSON.stringify(player2Choices.bannedStages)} && selectedStages.length < 2) {
              if (!selectedStages.includes(id)) selectedStages.push(id);
            } else if (isPlayer1 && ${JSON.stringify(player2Choices.bannedStages)}) {
              finalStage = id;
            }
            document.querySelectorAll('.stage-btn').forEach(btn => {
              btn.classList.toggle('selected', selectedStages.includes(btn.dataset.id));
              btn.classList.toggle('banned', ${JSON.stringify(bannedStages)}.includes(btn.dataset.id));
            });
          }

          async function saveBan(matchId) {
            const data = ${isPlayer1} && ${JSON.stringify(player2Choices.bannedStages)} 
              ? { finalStage: finalStage } 
              : { bannedStages: selectedStages };
            if ((!${isPlayer1} && selectedStages.length !== 2) || (${isPlayer1} && !${JSON.stringify(player1Choices.bannedStages)} && selectedStages.length !== 1)) {
              alert('必要な数のステージを選択してください');
              return;
            }
            if (${isPlayer1} && ${JSON.stringify(player2Choices.bannedStages)} && !finalStage) {
              alert('最終ステージを選択してください');
              return;
            }

            try {
              const response = await fetch('/api/solo/ban/' + matchId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
              if (!response.ok) throw new Error(await response.text());
            } catch (error) {
              alert('保存に失敗しました: ' + error.message);
            }
          }

          console.log('リスナー登録開始: matchId=${matchId}');
          onSnapshot(doc(db, 'matches', '${matchId}'), (doc) => {
            console.log('onSnapshot発火');
            if (!doc.exists) {
              console.error('ドキュメントが存在しません');
              return;
            }
            const data = doc.data();
            console.log('取得データ:', data);
            const isPlayer1 = '${userId}' === data.userId;
            const myChoices = isPlayer1 ? data.player1Choices : data.player2Choices;
            const opponentChoices = isPlayer1 ? data.player2Choices : data.player1Choices;
            const bannedStages = [...(myChoices?.bannedStages || []), ...(opponentChoices?.bannedStages || [])];
            document.querySelectorAll('.stage-btn').forEach(btn => {
              btn.classList.toggle('banned', bannedStages.includes(btn.dataset.id));
              btn.classList.toggle('selected', selectedStages.includes(btn.dataset.id));
            });
            const myChar = myChoices?.character || 'default';
            const myMoves = myChoices?.miiMoves || '';
            const oppChar = opponentChoices?.character || 'default';
            const oppMoves = opponentChoices?.miiMoves || '';
            console.log('キャラクター更新: myChar=', myChar, 'oppChar=', oppChar);
            document.querySelector('.char-display').innerHTML = 
              '<p>あなたのキャラクター: <img src="/characters/' + myChar + '.png" width="64" height="64"> ' + myMoves + '</p>' +
              '<p>相手のキャラクター: <img src="/characters/' + oppChar + '.png" width="64" height="64"> ' + oppMoves + '</p>';
            let newGuide = '';
            if (isPlayer1 && !myChoices?.bannedStages) {
              newGuide = '拒否ステージを1つ選んでください（①側）。';
            } else if (isPlayer1 && myChoices?.bannedStages && !opponentChoices?.bannedStages) {
              newGuide = '相手（②側）が拒否ステージを選んでいます...';
            } else if (!isPlayer1 && opponentChoices?.bannedStages && !myChoices?.bannedStages) {
              newGuide = '拒否ステージを2つ選んでください（②側）。';
            } else if (!isPlayer1 && !opponentChoices?.bannedStages) {
              newGuide = '相手が拒否ステージを選んでいます...（②側）';
            } else if (myChoices?.bannedStages && opponentChoices?.bannedStages) {
              newGuide = isPlayer1 
                ? '表示されている残りのステージから選び、対戦を開始してください（①側）。' 
                : 'ステージを「おまかせ」に設定し、対戦を開始してください（②側）。';
            }
            document.getElementById('guide').innerText = newGuide;
            document.getElementById('submitBtn').disabled = newGuide.includes('待っています');
          }, (error) => {
            console.error('onSnapshotエラー:', error);
          });
        </script>
      </head>
      <body>
        <!-- 既存のHTMLはそのまま -->
      </body>
    </html>
  `);
});

// ステージ拒否の選択を保存する処理
app.post('/api/solo/ban/:matchId', async (req, res) => {
  const matchId = req.params.matchId; // URLからマッチIDを取得
  const userId = req.user?.id; // ログインユーザーのID
  if (!userId) return res.status(401).send('ログインが必要です'); // 未ログインならエラー

  const { bannedStages, finalStage } = req.body; // リクエストボディからデータ取得
  if (!bannedStages && !finalStage) return res.status(400).send('ステージ情報が必要です'); // データがない場合

  const matchRef = doc(db, 'matches', matchId); // Firestoreのマッチドキュメント参照
  const matchSnap = await getDoc(matchRef); // マッチデータを取得
  if (!matchSnap.exists() || (matchSnap.data().userId !== userId && matchSnap.data().opponentId !== userId)) {
    return res.status(404).send('マッチが見つかりません'); // マッチが存在しないか権限がない場合
  }

  const matchData = matchSnap.data(); // マッチデータ
  const isPlayer1 = matchData.userId === userId; // 自分がPlayer1かどうか
  const updateData = {}; // 更新用データ

  // ステージ拒否または最終選択の処理
  if (bannedStages) {
    if (isPlayer1 && !matchData.player1Choices.bannedStages && bannedStages.length === 1) {
      updateData.player1Choices = { ...matchData.player1Choices, bannedStages }; // Player1の拒否を保存
      updateData.step = 'stage_ban_2'; // 次のステップへ
    } else if (!isPlayer1 && matchData.player1Choices.bannedStages && !matchData.player2Choices.bannedStages && bannedStages.length === 2) {
      updateData.player2Choices = { ...matchData.player2Choices, bannedStages }; // Player2の拒否を保存
      updateData.step = 'final_stage'; // 次のステップへ
    } else {
      return res.status(400).send('不正なステージ拒否数です'); // 拒否数が不正な場合
    }
  } else if (finalStage && isPlayer1 && matchData.player2Choices.bannedStages) {
    updateData.player1Choices = { ...matchData.player1Choices, finalStage }; // Player1の最終ステージを保存
    updateData.step = 'completed'; // 完了ステップへ
  } else {
    return res.status(400).send('不正な操作です'); // 不正な操作の場合
  }

  await updateDoc(matchRef, updateData); // Firestoreを更新
  res.status(200).send('OK'); // 成功レスポンス
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