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
app.use(express.static('public'));

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

const redisClient = createClient({
  url: process.env.REDIS_URL,
  socket: {
    connectTimeout: 20000,
    keepAlive: 10000,
    reconnectStrategy: (retries) => Math.min(retries * 100, 3000)
  }
});
redisClient.connect().catch((err) => {});

class CustomRedisStore extends EventEmitter {
  constructor(client) {
    super();
    this.client = client;
    this.prefix = 'sess:';
  }

  async get(key, cb) {
    try {
      const fullKey = this.prefix + key;
      const data = await this.client.get(fullKey);
      cb(null, data ? JSON.parse(data) : null);
    } catch (err) {
      cb(err);
    }
  }

  async set(key, sess, cb) {
    try {
      const fullKey = this.prefix + key;
      await this.client.set(fullKey, JSON.stringify(sess), { EX: 604800 });
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  async destroy(key, cb) {
    try {
      const fullKey = this.prefix + key;
      await this.client.del(fullKey);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  async regenerate(req, cb) {
    const oldSessionId = req.sessionID;
    req.session.destroy((err) => {
      if (err) {
        return cb(err);
      }
      req.sessionStore.generate(req);
      cb(null);
    });
  }

  generate(req) {
    req.session = new session.Session(req);
    req.sessionID = req.session.id;
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
  if (cookieHeader) {
    const cookies = cookieHeader.split('; ').reduce((acc, cookie) => {
      const [name, value] = cookie.split('=');
      acc[name] = value;
      return acc;
    }, {});
    const receivedSid = cookies['connect.sid'];
    if (receivedSid && receivedSid !== req.sessionID) {
      req.sessionID = receivedSid.split('.')[0];
    }
  }
  req.sessionStore.get(req.sessionID, (err, session) => {
    if (err) {
      return next();
    }
    if (session) {
      Object.assign(req.session, session);
    }
    next();
  });
});
app.use(passport.initialize());
app.use(passport.session());
app.use((req, res, next) => {
  next();
});

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: 'https://sumatest.vercel.app/api/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
  try {
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
        teamRating: 1500,
        uploadCount: 0,
        lastUploadReset: new Date().toISOString(),
        tagPartnerId: '',
        isTagged: false
      };
      await userRef.set(userData);
    }
    return done(null, profile);
  } catch (error) {
    return done(error);
  }
}));

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const db = admin.firestore();
    const userRef = db.collection('users').doc(id);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return done(null, false);
    }
    let userData = userSnap.data();
    userData.id = id;
    done(null, userData);
  } catch (error) {
    done(error);
  }
});

app.get('/api/auth/google', (req, res, next) => {
  const redirectTo = req.query.redirect || '/api/';
  passport.authenticate('google', { scope: ['profile', 'email'], state: redirectTo }, (err) => {
    if (err) {
      return res.redirect('/api/');
    }
  })(req, res, next);
});

app.get('/api/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/api/' }), 
  (req, res) => {
    req.session.save((err) => {
      if (err) {
        return res.redirect('/api/');
      }
      res.set('Set-Cookie', `connect.sid=${req.sessionID}; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax`);
      const redirectTo = req.query.state || '/api/';
      res.status(302).set('Location', redirectTo).end();
    });
  }
);

app.get('/', (req, res) => {
  res.redirect('/api/');
});

app.get('/api/', async (req, res) => {
  if (req.user) {
    const userData = req.user;
    if (!userData.handleName) {
      return res.redirect(`/api/user/${userData.id}`);
    }
    res.send(`
      <html>
        <head>
          <link rel="stylesheet" href="/css/general.css">
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
          <link rel="stylesheet" href="/css/general.css">
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
        return res.redirect('/api/');
      }
      req.session.destroy((err) => {
        if (err) {
          return res.redirect('/api/');
        }
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

app.get('/api/solo', async (req, res) => {
  const matchesRef = collection(db, 'matches');
  const waitingQuery = query(matchesRef, where('type', '==', 'solo'), where('status', '==', 'waiting'));
  const waitingSnapshot = await getDocs(waitingQuery);
  const waitingCount = waitingSnapshot.size;

  let html = `
    <html>
      <head>
        <link rel="stylesheet" href="/css/general.css">
      </head>
      <body>
        <div class="container">
          <h1>タイマン用ページ</h1>
          <p>待機中: ${waitingCount}人</p>
  `;
  if (req.user) {
    const soloRating = req.user.soloRating || 1500;
    html += `
      <form id="matchForm">
        <button type="button" id="matchButton">マッチング開始</button>
      </form>
      <p>現在のレート: ${soloRating}</p>
      <script>
        document.getElementById('matchButton').addEventListener('click', async () => {
          try {
            const response = await fetch('/api/solo/match', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();
            if (response.ok) {
              window.location.href = data.redirect;
            } else {
              alert(data.message);
            }
          } catch (error) {
            alert('ネットワークエラー: ' + error.message);
          }
        });
      </script>
    `;
  } else {
    html += `<p>マッチングするには<a href="/api/auth/google?redirect=/api/solo">ログイン</a>してください</p>`;
  }
  html += `
          <p><a href="/api/">戻る</a></p>
        </div>
      </body>
    </html>`;
  res.send(html);
});

app.get('/api/solo/check', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/api/solo');
  }
  const userId = req.user.id;
  const matchesRef = collection(db, 'matches');
  const userMatchQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'matched'), where('type', '==', 'solo'));
  const userMatchSnapshot = await getDocs(userMatchQuery);

  if (!userMatchSnapshot.empty) {
    const matchId = userMatchSnapshot.docs[0].id;
    res.redirect(`/api/solo/setup/${matchId}`);
  } else {
    const waitingQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'waiting'), where('type', '==', 'solo'));
    const waitingSnapshot = await getDocs(waitingQuery);
    const roomId = waitingSnapshot.empty ? '' : waitingSnapshot.docs[0].data().roomId;
    res.send(`
      <html>
        <head>
          <link rel="stylesheet" href="/css/general.css">
        </head>
        <body>
          <div class="container">
            <h1>マッチング待機中</h1>
            <p>相手を待っています... あなたのレート: ${req.user.soloRating || 1500}</p>
            <p>Switchで部屋を作成し、以下に部屋IDを入力してください。</p>
            <form action="/api/solo/update" method="POST">
              <label>Switch部屋ID: <input type="text" name="roomId" value="${roomId}" placeholder="例: ABC123"></label>
              <button type="submit">IDを更新</button>
            </form>
            <button id="cancelButton">ルームを削除する</button>
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

              document.addEventListener('DOMContentLoaded', () => {
                const cancelButton = document.getElementById('cancelButton');
                cancelButton.addEventListener('click', async () => {
                  try {
                    const response = await fetch('/api/solo/check/cancel', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' }
                    });
                    if (response.ok) {
                      window.location.href = '/api/solo';
                    } else {
                      const data = await response.json();
                      alert(data.message);
                    }
                  } catch (error) {
                    alert('エラーが発生しました: ' + error.message);
                  }
                });
              });
            </script>
          </div>
        </body>
      </html>
    `);
  }
});

app.post('/api/solo/check/cancel', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ message: '認証が必要です。ログインしてください。' });
  }
  const userId = req.user.id;

  try {
    const db = admin.firestore();
    const matchesRef = db.collection('matches');
    const waitingQuery = matchesRef
      .where('type', '==', 'solo')
      .where('status', '==', 'waiting')
      .where('userId', '==', userId);
    const waitingSnapshot = await waitingQuery.get();

    if (waitingSnapshot.empty) {
      return res.send('OK');
    }

    const matchDoc = waitingSnapshot.docs[0];
    await matchDoc.ref.delete();

    res.send('OK');
  } catch (error) {
    return res.status(500).json({ message: `キャンセルに失敗しました: ${error.message}` });
  }
});

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

app.post('/api/solo/match', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ message: '認証が必要です。ログインしてください。' });
  }
  const userId = req.user.id;
  const userSoloRating = req.user.soloRating || 1500;

  try {
    const db = admin.firestore();
    const matchesRef = db.collection('matches');

    const userSoloMatchesQuery = matchesRef.where('type', '==', 'solo');
    const userSoloHostQuery = userSoloMatchesQuery
      .where('userId', '==', userId)
      .where('status', 'in', ['matched', 'waiting']);
    const userSoloGuestQuery = userSoloMatchesQuery
      .where('guestId', '==', userId)
      .where('status', '==', 'matched');
    const [userSoloHostSnapshot, userSoloGuestSnapshot] = await Promise.all([
      userSoloHostQuery.get(),
      userSoloGuestQuery.get()
    ]);

    if (!userSoloHostSnapshot.empty) {
      const matchDoc = userSoloHostSnapshot.docs[0];
      const matchData = matchDoc.data();
      if (matchData.status === 'matched') {
        return res.json({ redirect: `/api/solo/setup/${matchDoc.id}` });
      } else if (matchData.status === 'waiting') {
        return res.json({ redirect: '/api/solo/check' });
      }
    }
    if (!userSoloGuestSnapshot.empty) {
      const matchDoc = userSoloGuestSnapshot.docs[0];
      if (userSoloGuestSnapshot.size > 1) {
        console.warn('複数のソロゲストルーム検出:', { userId, count: userSoloGuestSnapshot.size });
      }
      return res.json({ redirect: `/api/solo/setup/${matchDoc.id}` });
    }

    const userTeamMatchesQuery = matchesRef
      .where('type', '==', 'team')
      .where('status', 'in', ['matched', 'waiting']);
    const userTeamHostQuery = userTeamMatchesQuery.where('userId', '==', userId);
    const userTeamGuestQuery = userTeamMatchesQuery.where('guestId', '==', userId);
    const [userTeamHostSnapshot, userTeamGuestSnapshot] = await Promise.all([
      userTeamHostQuery.get(),
      userTeamGuestQuery.get()
    ]);

    if (!userTeamHostSnapshot.empty) {
      const matchId = userTeamHostSnapshot.docs[0].id;
      const status = userTeamHostSnapshot.docs[0].data().status;
      if (status === 'matched') {
        return res.status(403).json({ message: 'あなたはチーム版で対戦中です' });
      }
      return res.status(403).json({ message: 'あなたはチーム版で待機中です' });
    }
    if (!userTeamGuestSnapshot.empty) {
      const matchId = userTeamGuestSnapshot.docs[0].id;
      return res.status(403).json({ message: 'あなたはチーム版で対戦中です' });
    }

    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'ユーザーが見つかりません' });
    }
    const userData = userSnap.data();
    const isTagged = userData.isTagged || false;
    const tagPartnerId = userData.tagPartnerId || '';

    if (isTagged && tagPartnerId) {
      const partnerTeamMatchesQuery = matchesRef
        .where('type', '==', 'team')
        .where('status', 'in', ['matched', 'waiting']);
      const partnerTeamHostQuery = partnerTeamMatchesQuery.where('userId', '==', tagPartnerId);
      const partnerTeamGuestQuery = partnerTeamMatchesQuery.where('guestId', '==', tagPartnerId);
      const [partnerTeamHostSnapshot, partnerTeamGuestSnapshot] = await Promise.all([
        partnerTeamHostQuery.get(),
        partnerTeamGuestQuery.get()
      ]);

      if (!partnerTeamHostSnapshot.empty) {
        const matchId = partnerTeamHostSnapshot.docs[0].id;
        const status = partnerTeamHostSnapshot.docs[0].data().status;
        if (status === 'matched') {
          return res.status(403).json({ message: 'チーム相方がチーム版で対戦中です' });
        }
        return res.status(403).json({ message: 'チーム相方がチーム版で待機中です' });
      }
      if (!partnerTeamGuestSnapshot.empty) {
        const matchId = partnerTeamGuestSnapshot.docs[0].id;
        return res.status(403).json({ message: 'チーム相方がチーム版で対戦中です' });
      }
    }

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
      const guestSoloRating = guestSnap.exists ? (guestSnap.data().soloRating || 1500) : 1500;
      if (Math.abs(userSoloRating - guestSoloRating) <= 200) {
        await docSnap.ref.update({
          guestId: userId,
          status: 'matched',
          step: 'character_selection',
          timestamp: new Date().toISOString(),
          hostChoices: { wins: 0, losses: 0, matchResults: [null, null, null] },
          guestChoices: { wins: 0, losses: 0, matchResults: [null, null, null] }
        });
        matched = true;
        return res.json({ redirect: `/api/solo/setup/${docSnap.id}` });
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
      return res.json({ redirect: '/api/solo/check' });
    }
  } catch (error) {
    return res.status(500).json({ message: `マッチングに失敗しました: ${error.message}` });
  }
});

app.get('/api/solo/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;

  if (!userId) {
    return res.redirect('/api/solo');
  }

  try {
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const matchSnap = await matchRef.get();

    if (!matchSnap.exists || (matchSnap.data().userId !== userId && matchSnap.data().guestId !== userId)) {
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
    const hostsoloRating = hostSnap.data().soloRating || 1500;
    const guestsoloRating = guestSnap.data().soloRating || 1500;
    const hostProfileImage = hostSnap.data().profileImage || '/default.png';
    const guestProfileImage = guestSnap.data().profileImage || '/default.png';

    const hostChoices = matchData.hostChoices || { wins: 0, losses: 0 };
    const guestChoices = matchData.guestChoices || { wins: 0, losses: 0 };

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

    res.send(`
      <html>
        <head>
          <link rel="stylesheet" href="/css/setup.css">
          <link rel="stylesheet" href="/css/solo.css">
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
                var canSelectSend = true;
                var canSelectResult = false;
                var canSelectCancel = true;

                if (isCancelled) {
                  guideText = 'このルームは対戦中止になりました';
                  canSelectChar = false;
                  canSelectStage = false;
                  canSelectSend = false;
                  canSelectResult = false;
                  canSelectCancel = false;
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
                  canSelectSend = false;
                  canSelectResult = false;
                  canSelectCancel = false;
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
                document.querySelectorAll('.send-btn').forEach(btn => {
                  btn.classList.toggle('disabled', !canSelectSend);
                  btn.style.cursor = canSelectSend ? 'auto' : 'not-allowed';
                });
                document.querySelectorAll('.result-btn').forEach(btn => {
                  btn.classList.toggle('disabled', !canSelectResult);
                  btn.style.cursor = canSelectResult ? 'auto' : 'not-allowed';
                });
                document.querySelectorAll('.cancel-btn').forEach(btn => {
                  btn.classList.toggle('disabled', !canSelectCancel);
                  btn.style.cursor = canSelectCancel ? 'auto' : 'not-allowed';
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
              <button class="send-btn" onclick="saveSelections('${matchId}')">決定</button>
              <button class="result-btn" onclick="saveSelections('${matchId}', 'win')">勝ち</button>
              <button class="result-btn" onclick="saveSelections('${matchId}', 'lose')">負け</button>
              <button class="cancel-btn" onclick="cancelMatch()">対戦中止</button>
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
    res.status(500).send('エラーが発生しました');
  }
});

app.post('/api/solo/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  const { character1, character2, character3, miiMoves1, miiMoves2, miiMoves3, bannedStages, result, characterReady, selectedStage } = req.body;

  try {
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
      const losePoints = winPoints;
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
        updateData[choicesKey].character1 = character1;
      }
      if (character2 !== undefined) {
        updateData[choicesKey].character2 = character2;
      }
      if (character3 !== undefined) {
        updateData[choicesKey].character3 = character3;
      }
      if (miiMoves1 !== undefined) updateData[choicesKey].miiMoves1 = miiMoves1;
      if (miiMoves2 !== undefined) updateData[choicesKey].miiMoves2 = miiMoves2;
      if (miiMoves3 !== undefined) updateData[choicesKey].miiMoves3 = miiMoves3;
      if (bannedStages) {
        updateData[choicesKey].bannedStages = bannedStages;
      }
      if (selectedStage) {
        updateData[choicesKey].selectedStage = selectedStage;
        updateData.selectedStage = selectedStage;
      }
    }

    await matchRef.update(updateData);
    res.send('OK');
  } catch (error) {
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

    const matchSnap = await matchRef.get();
    if (!matchSnap.exists || (matchSnap.data().userId !== userId && matchSnap.data().guestId !== userId)) {
      return res.status(403).send('このマッチにアクセスする権限がありません');
    }

    const matchData = matchSnap.data();
    const totalMessages = matchData.totalMessages || 0;
    const totalChars = matchData.totalChars || 0;
    if (totalMessages >= 100) {
      return res.status(400).send('このルームのメッセージ回数上限（100回）に達しました');
    }
    if (totalChars + message.length > 10000) {
      return res.status(400).send('このルームの文字数上限（10,000文字）に達しました');
    }

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

    const jstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);

    const userSnap = await db.collection('users').doc(userId).get();
    const handleName = userSnap.data()?.handleName || '不明';
    await messagesRef.add({
      userId,
      handleName,
      message,
      timestamp: now.toISOString(),
      time: jstTime
    });

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

    if (matchData.isCancelled) {
      return res.send('OK');
    }

    const updateData = {};
    if (isHost) {
      updateData['hostChoices.cancelRequested'] = true;
    } else {
      updateData['guestChoices.cancelRequested'] = true;
    }

    const otherCancelRequested = isHost ? matchData.guestChoices?.cancelRequested : matchData.hostChoices?.cancelRequested;
    if (otherCancelRequested) {
      updateData.isCancelled = true;
      updateData.status = 'finished';
    }

    await matchRef.update(updateData);
    res.send('OK');
  } catch (error) {
    res.status(500).send(`エラー: ${error.message}`);
  }
});

app.post('/api/solo/update', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.redirect('/api/solo');
  }
  const userId = req.user.id;
  const roomId = req.body.roomId || '';

  try {
    const db = admin.firestore();
    const matchesRef = db.collection('matches');
    const waitingQuery = matchesRef
      .where('userId', '==', userId)
      .where('status', '==', 'waiting');
    const waitingSnapshot = await waitingQuery.get();

    if (!waitingSnapshot.empty) {
      const docSnap = waitingSnapshot.docs[0];
      await docSnap.ref.update({ roomId: roomId });
    }
    res.redirect('/api/solo/check');
  } catch (error) {
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
    userData.handleName = userData.handleName || '';
    userData.bio = userData.bio || '';
    userData.profileImage = userData.profileImage || '/default.png';
    userData.uploadCount = userData.uploadCount || 0;
    userData.lastUploadReset = userData.lastUploadReset || new Date().toISOString();
    userData.tagPartnerId = userData.tagPartnerId || '';
    userData.isTagged = userData.isTagged || false;

    const isOwnProfile = currentUser && currentUser.id === userId;
    const isNewUser = isOwnProfile && !userData.handleName;

    let activeRoomLink = '';
    if (isOwnProfile) {
      const matchesRef = db.collection('matches');
      const userSoloHostQuery = matchesRef
        .where('type', '==', 'solo')
        .where('userId', '==', userId)
        .where('status', 'in', ['matched', 'waiting']);
      const userSoloGuestQuery = matchesRef
        .where('type', '==', 'solo')
        .where('guestId', '==', userId)
        .where('status', '==', 'matched');
      const userTeamHostQuery = matchesRef
        .where('type', '==', 'team')
        .where('userId', '==', userId)
        .where('status', 'in', ['matched', 'waiting']);
      const userTeamGuestQuery = matchesRef
        .where('type', '==', 'team')
        .where('guestId', '==', userId)
        .where('status', '==', 'matched');
      const [
        userSoloHostSnapshot,
        userSoloGuestSnapshot,
        userTeamHostSnapshot,
        userTeamGuestSnapshot
      ] = await Promise.all([
        userSoloHostQuery.get(),
        userSoloGuestQuery.get(),
        userTeamHostQuery.get(),
        userTeamGuestQuery.get()
      ]);

      if (!userSoloHostSnapshot.empty) {
        const matchDoc = userSoloHostSnapshot.docs[0];
        const matchData = matchDoc.data();
        if (userSoloHostSnapshot.size > 1) {
          console.warn('複数のソロホストルーム検出:', { userId, type: 'solo', count: userSoloHostSnapshot.size });
        }
        activeRoomLink = `<p><a href="/api/solo/${matchData.status === 'matched' ? 'setup/' + matchDoc.id : 'check'}">参加中のルームがあります</a></p>`;
      }
      else if (!userSoloGuestSnapshot.empty) {
        const matchDoc = userSoloGuestSnapshot.docs[0];
        if (userSoloGuestSnapshot.size > 1) {
          console.warn('複数のソロゲストルーム検出:', { userId, type: 'solo', count: userSoloGuestSnapshot.size });
        }
        activeRoomLink = `<p><a href="/api/solo/setup/${matchDoc.id}">参加中のルームがあります</a></p>`;
      }
      else if (!userTeamHostSnapshot.empty) {
        const matchDoc = userTeamHostSnapshot.docs[0];
        const matchData = matchDoc.data();
        if (userTeamHostSnapshot.size > 1) {
          console.warn('複数のチームホストルーム検出:', { userId, type: 'team', count: userTeamHostSnapshot.size });
        }
        activeRoomLink = `<p><a href="/api/team/${matchData.status === 'matched' ? 'setup/' + matchDoc.id : 'check'}">参加中のルームがあります</a></p>`;
      }
      else if (!userTeamGuestSnapshot.empty) {
        const matchDoc = userTeamGuestSnapshot.docs[0];
        if (userTeamGuestSnapshot.size > 1) {
          console.warn('複数のチームゲストルーム検出:', { userId, type: 'team', count: userTeamGuestSnapshot.size });
        }
        activeRoomLink = `<p><a href="/api/team/setup/${matchDoc.id}">参加中のルームがあります</a></p>`;
      }
    }

    let tagStatusHtml = '';
    if (isOwnProfile) {
      const isTagged = userData.isTagged;
      const tagPartnerId = userData.tagPartnerId;
      if (!isTagged || !tagPartnerId) {
        tagStatusHtml = `<p>チーム相方: 組んでいない</p>`;
      } else {
        const tagPartnerRef = db.collection('users').doc(tagPartnerId);
        const tagPartnerSnap = await tagPartnerRef.get();
        if (!tagPartnerSnap.exists) {
          tagStatusHtml = `<p>チーム相方: 申請中</p>`;
        } else {
          const tagPartnerData = tagPartnerSnap.data();
          if (!tagPartnerData.isTagged || tagPartnerData.tagPartnerId !== userId) {
            tagStatusHtml = `<p>チーム相方: 申請中</p>`;
          } else {
            tagStatusHtml = `<p>チーム相方: <a href="/api/user/${tagPartnerId}">${tagPartnerData.handleName || '未設定'}</a></p>`;
          }
        }
      }
    }

    let tagButtonHtml = '';
    let currentUserTagPartnerId = '';
    let currentUserIsTagged = false;
    if (currentUser && !isOwnProfile) {
      const currentUserRef = db.collection('users').doc(currentUser.id);
      const currentUserSnap = await currentUserRef.get();
      const currentUserData = currentUserSnap.data();
      currentUserTagPartnerId = currentUserData.tagPartnerId || '';
      currentUserIsTagged = currentUserData.isTagged || false;

      if (currentUserIsTagged && currentUserTagPartnerId === userId) {
        tagButtonHtml = `
          <button id="untagButton">タッグを解除する</button>
        `;
      } else {
        tagButtonHtml = `
          <button id="tagButton">タッグを組む</button>
        `;
      }
    } else if (isOwnProfile && userData.isTagged && userData.tagPartnerId) {
      tagButtonHtml = `
        <button id="untagButton">タッグを解除する</button>
      `;
    }

    if (isNewUser || !userData.handleName) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="ja">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>プロフィール設定</title>
          <link rel="stylesheet" href="/css/general.css">
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

    const matchesRef = db.collection('matches');
    const userMatchesQuery = matchesRef
      .where('status', '==', 'finished')
      .where('userId', 'in', [userId, userId]);
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
          <link rel="stylesheet" href="/css/general.css">
        </head>
        <body>
          <div class="container">
            <h1>${userData.handleName || '未設定'}のプロフィール</h1>
            <img src="${userData.profileImage}" alt="プロフィール画像">
            <p>自己紹介: ${userData.bio || '未設定'}</p>
            <p>レート: ${userData.soloRating}</p>
            ${tagStatusHtml}
            ${isOwnProfile ? `
              <p><a href="/api/user/${userId}/edit">プロフィールを編集</a></p>
              <p><a href="/api/logout">ログアウト</a></p>
              ${activeRoomLink}
            ` : ''}
            ${tagButtonHtml}
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
          <script>
            const tagButton = document.getElementById('tagButton');
            const untagButton = document.getElementById('untagButton');

            if (tagButton) {
              tagButton.addEventListener('click', async () => {
                try {
                  const response = await fetch('/api/user/${userId}/tag', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'tag' })
                  });
                  if (response.ok) {
                    window.location.reload();
                  } else {
                    const data = await response.json();
                    alert(data.message);
                  }
                } catch (error) {
                    alert('エラーが発生しました: ' + error.message);
                }
              });
            }

            if (untagButton) {
              untagButton.addEventListener('click', async () => {
                try {
                  const response = await fetch('/api/user/${userId}/tag', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'untag' })
                  });
                  if (response.ok) {
                    window.location.reload();
                  } else {
                    const data = await response.json();
                    alert(data.message);
                  }
                } catch (error) {
                    alert('エラーが発生しました: ' + error.message);
                }
              });
            }
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    res.status(500).send(`
      <html><body>
        <h1>エラーが発生しました</h1>
        <p>${error.message}</p>
        <p><a href="/api/">ホームに戻る</a></p>
      </body></html>
    `);
  }
});

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
        <link rel="stylesheet" href="/css/general.css">
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
    res.status(500).send('エラーが発生しました');
  }
});

app.post('/api/user/:userId/update', async (req, res) => {
  const { userId } = req.params;
  const currentUser = req.user;

  if (!currentUser) {
    return res.status(401).send('認証が必要です。ログインしてください。');
  }

  if (currentUser.id !== userId) {
    return res.status(403).send('自分のプロフィールのみ編集可能です');
  }

  try {
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

    if (!handleName) {
      return res.status(400).send('ハンドルネームは必須です');
    }

    if (profileImage) {
      if (!['image/png', 'image/jpeg'].includes(profileImage.mimetype)) {
        return res.status(400).send('PNGまたはJPEG形式の画像をアップロードしてください');
      }
      if (profileImage.size > 1 * 1024 * 1024) {
        return res.status(400).send('画像サイズは1MB以下にしてください');
      }
    }

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
        return res.status(500).send('画像アップロードに失敗しました');
      }
    }

    await userRef.update(updateData);
    res.send('OK');
  } catch (error) {
    res.status(500).send(`エラー: ${error.message}`);
  }
});

app.post('/api/user/:userId/tag', async (req, res) => {
  const { userId } = req.params;
  const currentUser = req.user;

  if (!currentUser) {
    return res.status(401).json({ message: '認証が必要です。ログインしてください。' });
  }

  const { action } = req.body;

  try {
    const db = admin.firestore();
    const currentUserRef = db.collection('users').doc(currentUser.id);
    const targetUserRef = db.collection('users').doc(userId);

    const currentUserSnap = await currentUserRef.get();
    if (!currentUserSnap.exists) {
      return res.status(404).json({ message: 'ユーザーが見つかりません' });
    }
    const currentUserData = currentUserSnap.data();

    if (currentUser.id === userId) {
      if (!currentUserData.isTagged) {
        return res.status(400).json({ message: '自分自身にタッグを組むことはできません' });
      }
      if (action !== 'untag') {
        return res.status(400).json({ message: '自身の場合はタッグ解除のみ可能です' });
      }

      const matchesRef = db.collection('matches');
      const userTeamHostQuery = matchesRef
        .where('type', '==', 'team')
        .where('userId', '==', currentUser.id)
        .where('status', 'in', ['matched', 'waiting']);
      const userTeamGuestQuery = matchesRef
        .where('type', '==', 'team')
        .where('guestId', '==', currentUser.id)
        .where('status', '==', 'matched');
      const [userTeamHostSnapshot, userTeamGuestSnapshot] = await Promise.all([
        userTeamHostQuery.get(),
        userTeamGuestQuery.get()
      ]);

      if (!userTeamHostSnapshot.empty) {
        const matchDoc = userTeamHostSnapshot.docs[0];
        const matchData = matchDoc.data();
        if (userTeamHostSnapshot.size > 1) {
          console.warn('複数のチームホストルーム検出:', { userId: currentUser.id, type: 'team', count: userTeamHostSnapshot.size });
        }
        return res.status(403).json({
          message: matchData.status === 'matched'
            ? 'チーム用で対戦中なので解除できません'
            : 'チーム用で待機中なので解除できません'
        });
      }
      if (!userTeamGuestSnapshot.empty) {
        const matchDoc = userTeamGuestSnapshot.docs[0];
        if (userTeamGuestSnapshot.size > 1) {
          console.warn('複数のチームゲストルーム検出:', { userId: currentUser.id, type: 'team', count: userTeamGuestSnapshot.size });
        }
        return res.status(403).json({ message: 'チーム用で対戦中なので解除できません' });
      }

      const tagPartnerId = currentUserData.tagPartnerId;
      if (tagPartnerId) {
        const partnerTeamHostQuery = matchesRef
          .where('type', '==', 'team')
          .where('userId', '==', tagPartnerId)
          .where('status', 'in', ['matched', 'waiting']);
        const partnerTeamGuestQuery = matchesRef
          .where('type', '==', 'team')
          .where('guestId', '==', tagPartnerId)
          .where('status', '==', 'matched');
        const [partnerTeamHostSnapshot, partnerTeamGuestSnapshot] = await Promise.all([
          partnerTeamHostQuery.get(),
          partnerTeamGuestQuery.get()
        ]);

        if (!partnerTeamHostSnapshot.empty) {
          const matchDoc = partnerTeamHostSnapshot.docs[0];
          const matchData = matchDoc.data();
          if (partnerTeamHostSnapshot.size > 1) {
            console.warn('複数のチームホストルーム検出:', { userId: tagPartnerId, type: 'team', count: partnerTeamHostSnapshot.size });
          }
          return res.status(403).json({
            message: matchData.status === 'matched'
              ? 'チーム用でチーム相方が対戦中なので解除できません'
              : 'チーム用でチーム相方が待機中なので解除できません'
          });
        }
        if (!partnerTeamGuestSnapshot.empty) {
          const matchDoc = partnerTeamGuestSnapshot.docs[0];
          if (partnerTeamGuestSnapshot.size > 1) {
            console.warn('複数のチームゲストルーム検出:', { userId: tagPartnerId, type: 'team', count: partnerTeamGuestSnapshot.size });
          }
          return res.status(403).json({ message: 'チーム用でチーム相方が対戦中なので解除できません' });
        }
      }

      await currentUserRef.update({
        tagPartnerId: '',
        isTagged: false
      });
      return res.send('OK');
    }

    const targetUserSnap = await targetUserRef.get();
    if (!targetUserSnap.exists) {
      return res.status(404).json({ message: '対象ユーザーが見つかりません' });
    }

    if (action === 'tag') {
      if (currentUserData.isTagged) {
        return res.status(400).json({ message: '既に他のユーザーとタッグを組んでいます' });
      }
      await currentUserRef.update({
        tagPartnerId: userId,
        isTagged: true
      });
      res.send('OK');
    } else if (action === 'untag') {
      if (!currentUserData.isTagged) {
        console.log('タッグ解除済み、変更なし:', { userId: currentUser.id });
        return res.send('OK');
      }
      await currentUserRef.update({
        tagPartnerId: '',
        isTagged: false
      });
      res.send('OK');
    } else {
      return res.status(400).json({ message: '無効なアクションです' });
    }
  } catch (error) {
    return res.status(500).json({ message: `エラー: ${error.message}` });
  }
});

app.get('/api/team', async (req, res) => {
  const matchesRef = collection(db, 'matches');
  const waitingQuery = query(matchesRef, where('type', '==', 'team'), where('status', '==', 'waiting'));
  const waitingSnapshot = await getDocs(waitingQuery);
  const waitingCount = waitingSnapshot.size;

  let html = `
    <html>
      <head>
        <link rel="stylesheet" href="/css/general.css">
      </head>
      <body>
        <div class="container">
          <h1>チーム用ページ</h1>
          <p>待機中のチーム: ${waitingCount}</p>
  `;
  if (req.user) {
    const userId = req.user.id;
    const db = admin.firestore();
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    const userData = userSnap.data() || {};
    const userTeamRating = userData.teamRating || 1500;
    let teamRating = userTeamRating;

    if (userData.isTagged && userData.tagPartnerId) {
      const tagPartnerRef = db.collection('users').doc(userData.tagPartnerId);
      const tagPartnerSnap = await tagPartnerRef.get();
      const tagPartnerRating = tagPartnerSnap.exists ? (tagPartnerSnap.data().teamRating || 1500) : 1500;
      teamRating = Math.max(userTeamRating, tagPartnerRating);
    }

    html += `
      <form id="matchForm">
        <button type="button" id="matchButton">マッチング開始</button>
      </form>
      <p>現在のチームレート: ${teamRating}</p>
      <script>
        document.getElementById('matchButton').addEventListener('click', async () => {
          try {
            const response = await fetch('/api/team/match', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();
            if (response.ok) {
              window.location.href = data.redirect;
            } else {
              alert(data.message);
            }
          } catch (error) {
            alert('ネットワークエラー: ' + error.message);
          }
        });
      </script>
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
    return res.status(401).json({ message: '認証が必要です。ログインしてください。' });
  }
  const userId = req.user.id;

  try {
    const db = admin.firestore();
    const matchesRef = db.collection('matches');

    const userTeamMatchesQuery = matchesRef
      .where('type', '==', 'team')
      .where('status', 'in', ['matched', 'waiting']);
    const userTeamHostQuery = userTeamMatchesQuery.where('userId', '==', userId);
    const userTeamGuestQuery = userTeamMatchesQuery.where('guestId', '==', userId);
    const [userTeamHostSnapshot, userTeamGuestSnapshot] = await Promise.all([
      userTeamHostQuery.get(),
      userTeamGuestQuery.get()
    ]);

    if (!userTeamHostSnapshot.empty) {
      const matchDoc = userTeamHostSnapshot.docs[0];
      const matchData = matchDoc.data();
      if (matchData.status === 'matched') {
        return res.json({ redirect: `/api/team/setup/${matchDoc.id}` });
      } else if (matchData.status === 'waiting') {
        return res.json({ redirect: '/api/team/check' });
      }
    }
    if (!userTeamGuestSnapshot.empty) {
      const matchDoc = userTeamGuestSnapshot.docs[0];
      if (userTeamGuestSnapshot.size > 1) {
        console.warn('複数のチームゲストルーム検出:', { userId, count: userTeamGuestSnapshot.size });
      }
      return res.json({ redirect: `/api/team/setup/${matchDoc.id}` });
    }

    const userSoloMatchesQuery = matchesRef
      .where('type', '==', 'solo')
      .where('status', 'in', ['matched', 'waiting']);
    const userSoloHostQuery = userSoloMatchesQuery.where('userId', '==', userId);
    const userSoloGuestQuery = userSoloMatchesQuery.where('guestId', '==', userId);
    const [userSoloHostSnapshot, userSoloGuestSnapshot] = await Promise.all([
      userSoloHostQuery.get(),
      userSoloGuestQuery.get()
    ]);

    if (!userSoloHostSnapshot.empty) {
      const matchDoc = userSoloHostSnapshot.docs[0];
      const matchData = matchDoc.data();
      if (matchData.status === 'matched') {
        return res.status(403).json({ message: 'あなたはタイマン版で対戦中です' });
      } else if (matchData.status === 'waiting') {
        return res.status(403).json({ message: 'あなたはタイマン版で待機中です' });
      }
    }
    if (!userSoloGuestSnapshot.empty) {
      const matchDoc = userSoloGuestSnapshot.docs[0];
      if (userSoloGuestSnapshot.size > 1) {
        console.warn('複数のソロゲストルーム検出:', { userId, count: userSoloGuestSnapshot.size });
      }
      return res.status(403).json({ message: 'あなたはタイマン版で対戦中です' });
    }

    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      return res.status(404).json({ message: 'ユーザーが見つかりません' });
    }
    const userData = userSnap.data();
    const isTagged = userData.isTagged || false;
    const tagPartnerId = userData.tagPartnerId || '';

    if (!isTagged || !tagPartnerId) {
      return res.status(403).json({ message: 'チームマッチングにはタッグを組む必要があります。タッグを組んでから再度お試しください。' });
    }

    const tagPartnerRef = db.collection('users').doc(tagPartnerId);
    const tagPartnerSnap = await tagPartnerRef.get();
    if (!tagPartnerSnap.exists) {
      return res.status(404).json({ message: 'タッグ相手が見つかりません' });
    }
    const tagPartnerData = tagPartnerSnap.data();
    if (!tagPartnerData.isTagged || tagPartnerData.tagPartnerId !== userId) {
      return res.status(403).json({ message: 'タッグ相手と相互にタッグを組む必要があります' });
    }

    const partnerTeamMatchesQuery = matchesRef
      .where('type', '==', 'team')
      .where('status', 'in', ['matched', 'waiting']);
    const partnerTeamHostQuery = partnerTeamMatchesQuery.where('userId', '==', tagPartnerId);
    const partnerTeamGuestQuery = partnerTeamMatchesQuery.where('guestId', '==', tagPartnerId);
    const [partnerTeamHostSnapshot, partnerTeamGuestSnapshot] = await Promise.all([
      partnerTeamHostQuery.get(),
      partnerTeamGuestQuery.get()
    ]);

    if (!partnerTeamHostSnapshot.empty) {
      const matchDoc = partnerTeamHostSnapshot.docs[0];
      const matchData = matchDoc.data();
      if (matchData.status === 'matched') {
        return res.status(403).json({ message: 'チーム相方がチーム版で対戦中です' });
      } else if (matchData.status === 'waiting') {
        return res.status(403).json({ message: 'チーム相方がチーム版で待機中です' });
      }
    }
    if (!partnerTeamGuestSnapshot.empty) {
      const matchDoc = partnerTeamGuestSnapshot.docs[0];
      if (partnerTeamGuestSnapshot.size > 1) {
        console.warn('タッグ相手の複数のチームゲストルーム検出:', { userId, tagPartnerId, count: partnerTeamGuestSnapshot.size });
      }
      return res.status(403).json({ message: 'チーム相方がチーム版で対戦中です' });
    }

    const partnerSoloMatchesQuery = matchesRef
      .where('type', '==', 'solo')
      .where('status', 'in', ['matched', 'waiting']);
    const partnerSoloHostQuery = partnerSoloMatchesQuery.where('userId', '==', tagPartnerId);
    const partnerSoloGuestQuery = partnerSoloMatchesQuery.where('guestId', '==', tagPartnerId);
    const [partnerSoloHostSnapshot, partnerSoloGuestSnapshot] = await Promise.all([
      partnerSoloHostQuery.get(),
      partnerSoloGuestQuery.get()
    ]);

    if (!partnerSoloHostSnapshot.empty) {
      const matchDoc = partnerSoloHostSnapshot.docs[0];
      const matchData = matchDoc.data();
      if (matchData.status === 'matched') {
        return res.status(403).json({ message: 'チーム相方がタイマン版で対戦中です' });
      } else if (matchData.status === 'waiting') {
        return res.status(403).json({ message: 'チーム相方がタイマン版で待機中です' });
      }
    }
    if (!partnerSoloGuestSnapshot.empty) {
      const matchDoc = partnerSoloGuestSnapshot.docs[0];
      if (partnerSoloGuestSnapshot.size > 1) {
        console.warn('タッグ相手の複数のソロゲストルーム検出:', { userId, tagPartnerId, count: partnerSoloGuestSnapshot.size });
      }
      return res.status(403).json({ message: 'チーム相方がタイマン版で対戦中です' });
    }

    let userTeamRating = userData.teamRating || 1500;
    const tagPartnerRating = tagPartnerData.teamRating || 1500;
    userTeamRating = Math.max(userTeamRating, tagPartnerRating);

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
      const guestDataFull = guestSnap.exists ? guestSnap.data() : {};
      let guestTeamRating = guestDataFull.teamRating || 1500;

      // ゲストのタッグパートナーのレートを取得
      if (guestDataFull.tagPartnerId) {
        const guestTagPartnerRef = db.collection('users').doc(guestDataFull.tagPartnerId);
        const guestTagPartnerSnap = await guestTagPartnerRef.get();
        const guestTagPartnerRating = guestTagPartnerSnap.exists ? (guestTagPartnerSnap.data().teamRating || 1500) : 1500;
        guestTeamRating = Math.max(guestTeamRating, guestTagPartnerRating);
      }

      if (Math.abs(userTeamRating - guestTeamRating) <= 200) {
        await docSnap.ref.update({
          guestId: userId,
          status: 'matched',
          timestamp: new Date().toISOString()
        });
        matched = true;
        return res.json({ redirect: `/api/team/setup/${docSnap.id}` });
      }
    }

    if (!matched) {
      const matchRef = await matchesRef.add({
        userId: userId,
        type: 'team',
        status: 'waiting',
        roomId: '',
        timestamp: new Date().toISOString()
      });
      return res.json({ redirect: '/api/team/check' });
    }
  } catch (error) {
    return res.status(500).json({ message: `マッチングに失敗しました: ${error.message}` });
  }
});

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
          <link rel="stylesheet" href="/css/general.css">
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
            <button id="cancelButton">ルームを削除する</button>
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

              document.addEventListener('DOMContentLoaded', () => {
                const cancelButton = document.getElementById('cancelButton');
                cancelButton.addEventListener('click', async () => {
                  try {
                    const response = await fetch('/api/team/check/cancel', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' }
                    });
                    if (response.ok) {
                      window.location.href = '/api/team';
                    } else {
                      const data = await response.json();
                      alert(data.message);
                    }
                  } catch (error) {
                    alert('エラーが発生しました: ' + error.message);
                  }
                });
              });
            </script>
          </div>
        </body>
      </html>
    `);
  }
});

app.post('/api/team/check/cancel', async (req, res) => {
  if (!req.user || !req.user.id) {
    return res.status(401).json({ message: '認証が必要です。ログインしてください。' });
  }
  const userId = req.user.id;

  try {
    const db = admin.firestore();
    const matchesRef = db.collection('matches');
    const waitingQuery = matchesRef
      .where('type', '==', 'team')
      .where('status', '==', 'waiting')
      .where('userId', '==', userId);
    const waitingSnapshot = await waitingQuery.get();

    if (waitingSnapshot.empty) {
      return res.send('OK');
    }

    const matchDoc = waitingSnapshot.docs[0];
    await matchDoc.ref.delete();

    res.send('OK');
  } catch (error) {
    return res.status(500).json({ message: `キャンセルに失敗しました: ${error.message}` });
  }
});

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
    }
    res.redirect('/api/team/check');
  } catch (error) {
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
    return res.redirect('/api/team');
  }

  try {
    const db = admin.firestore();
    const matchRef = db.collection('matches').doc(matchId);
    const matchSnap = await matchRef.get();

    if (!matchSnap.exists || (matchSnap.data().userId !== userId && matchSnap.data().guestId !== userId)) {
      return res.send('マッチが見つかりません');
    }

    const matchData = matchSnap.data();
    const isHost = matchData.userId === userId;
    const hostId = matchData.userId;
    const guestId = matchData.guestId || '';

    const hostRef = db.collection('users').doc(hostId);
    const guestRef = db.collection('users').doc(guestId);
    const [hostSnap, guestSnap] = await Promise.all([hostRef.get(), guestRef.get()]);
    const hostData = hostSnap.data();
    const guestData = guestSnap.data();
    const hostName = hostData.handleName || '不明';
    const guestName = guestData.handleName || '不明';
    const hostProfileImage = hostData.profileImage || '/default.png';
    const guestProfileImage = guestData.profileImage || '/default.png';

    let hostTeamRating = hostData.teamRating || 1500;
    if (hostData.isTagged && hostData.tagPartnerId) {
      const hostTagPartnerRef = db.collection('users').doc(hostData.tagPartnerId);
      const hostTagPartnerSnap = await hostTagPartnerRef.get();
      const hostTagPartnerRating = hostTagPartnerSnap.exists ? (hostTagPartnerSnap.data().teamRating || 1500) : 1500;
      hostTeamRating = Math.max(hostTeamRating, hostTagPartnerRating);
    }
    let guestTeamRating = guestData.teamRating || 1500;
    if (guestData.isTagged && guestData.tagPartnerId) {
      const guestTagPartnerRef = db.collection('users').doc(guestData.tagPartnerId);
      const guestTagPartnerSnap = await guestTagPartnerRef.get();
      const guestTagPartnerRating = guestTagPartnerSnap.exists ? (guestTagPartnerSnap.data().teamRating || 1500) : 1500;
      guestTeamRating = Math.max(guestTeamRating, guestTagPartnerRating);
    }

    let hostTagPartnerName = '不明';
    let hostTagPartnerImage = '/default.png';
    if (hostData.tagPartnerId && hostData.isTagged) {
      const hostTagPartnerRef = db.collection('users').doc(hostData.tagPartnerId);
      const hostTagPartnerSnap = await hostTagPartnerRef.get();
      if (hostTagPartnerSnap.exists) {
        const hostTagPartnerData = hostTagPartnerSnap.data();
        hostTagPartnerName = hostTagPartnerData.handleName || '不明';
        hostTagPartnerImage = hostTagPartnerData.profileImage || '/default.png';
      }
    }
    let guestTagPartnerName = '不明';
    let guestTagPartnerImage = '/default.png';
    if (guestData.tagPartnerId && guestData.isTagged) {
      const guestTagPartnerRef = db.collection('users').doc(guestData.tagPartnerId);
      const guestTagPartnerSnap = await guestTagPartnerRef.get();
      if (guestTagPartnerSnap.exists) {
        const guestTagPartnerData = guestTagPartnerSnap.data();
        guestTagPartnerName = guestTagPartnerData.handleName || '不明';
        guestTagPartnerImage = guestTagPartnerData.profileImage || '/default.png';
      }
    }

    res.send(`
      <html>
        <head>
          <link rel="stylesheet" href="/css/setup.css">
          <link rel="stylesheet" href="/css/team.css">
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

              const resultMap = {
                'win': '勝ち',
                'lose': '負け',
                'cancel': '対戦中止',
                '対戦中': '対戦中'
              };
              hostResultElement.innerText = '状態: ' + resultMap[hostResult];
              guestResultElement.innerText = '状態: ' + resultMap[guestResult];

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
                <div class="player-group">
                  <div class="player-row">
                    <span class="icon-container"><img src="${hostProfileImage}" alt="${hostName}のプロフィール画像"></span>
                    <span class="name">${hostName}</span>
                  </div>
                  <div class="player-row">
                    <span class="icon-container"><img src="${hostTagPartnerImage}" alt="${hostTagPartnerName}のプロフィール画像"></span>
                    <span class="name">${hostTagPartnerName}</span>
                  </div>
                </div>
                <p id="hostRating">レート: ${hostTeamRating}</p>
                <p id="hostResult">状態: 対戦中</p>
              </div>
              <div class="player-info">
                <div class="player-group">
                  <div class="player-row">
                    <span class="icon-container"><img src="${guestProfileImage}" alt="${guestName}のプロフィール画像"></span>
                    <span class="name">${guestName}</span>
                  </div>
                  <div class="player-row">
                    <span class="icon-container"><img src="${guestTagPartnerImage}" alt="${guestTagPartnerName}のプロフィール画像"></span>
                    <span class="name">${guestTagPartnerName}</span>
                  </div>
                </div>
                <p id="guestRating">レート: ${guestTeamRating}</p>
                <p id="guestResult">状態: 対戦中</p>
              </div>
            </div>
            <div class="button-group">
              <button class="result-btn" onclick="submitResult('win')">勝ち</button>
              <button class="result-btn" onclick="submitResult('lose')">負け</button>
              <button class="result-btn" onclick="submitResult('cancel')">対戦中止</button>
              <p><a href="/api/team">戻る</a></p>
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
    res.status(500).send(`エラーが発生しました: ${error.message}`);
  }
});

app.post('/api/team/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  const { result } = req.body;

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

    async function updateTeamRatings(winnerIds, loserIds) {
      const winnerRefs = winnerIds.map(id => db.collection('users').doc(id));
      const loserRefs = loserIds.map(id => db.collection('users').doc(id));
      const winnerSnaps = await Promise.all(winnerRefs.map(ref => ref.get()));
      const loserSnaps = await Promise.all(loserRefs.map(ref => ref.get()));

      const winnerRatings = winnerSnaps.map(snap => snap.exists ? (snap.data().teamRating || 1500) : 1500);
      const winnerTeamRating = Math.max(...winnerRatings);
      const loserRatings = loserSnaps.map(snap => snap.exists ? (snap.data().teamRating || 1500) : 1500);
      const loserTeamRating = Math.max(...loserRatings);

      const teamRatingDiff = loserTeamRating - winnerTeamRating;
      const winPoints = teamRatingDiff >= 400 ? 0 : Math.floor(16 + teamRatingDiff * 0.04);
      const losePoints = winPoints;

      const winnerUpdates = winnerSnaps.map((snap, index) => {
        const userId = winnerIds[index];
        const currentRating = snap.exists ? (snap.data().teamRating || 1500) : 1500;
        return winnerRefs[index].update({ teamRating: currentRating + winPoints });
      });
      const loserUpdates = loserSnaps.map((snap, index) => {
        const userId = loserIds[index];
        const currentRating = snap.exists ? (snap.data().teamRating || 1500) : 1500;
        return loserRefs[index].update({ teamRating: currentRating - losePoints });
      });

      await Promise.all([...winnerUpdates, ...loserUpdates]);

      return {
        winPoints,
        losePoints,
        ratingChanges: {
          ...winnerIds.reduce((acc, id) => ({ ...acc, [id]: winPoints }), {}),
          ...loserIds.reduce((acc, id) => ({ ...acc, [id]: -losePoints }), {})
        }
      };
    }

    updateData[choicesKey] = { ...matchData[choicesKey], result: result || '' };
    updateData[opponentChoicesKey] = matchData[opponentChoicesKey] || {};

    const hostResult = updateData.hostChoices.result;
    const guestResult = updateData.guestChoices.result;
    if (hostResult && guestResult) {
      if (
        (hostResult === 'win' && guestResult === 'lose') ||
        (hostResult === 'lose' && guestResult === 'win')
      ) {
        updateData.status = 'finished';
        const hostRef = db.collection('users').doc(matchData.userId);
        const guestRef = db.collection('users').doc(matchData.guestId);
        const [hostSnap, guestSnap] = await Promise.all([hostRef.get(), guestRef.get()]);
        const hostData = hostSnap.data();
        const guestData = guestSnap.data();

        const hostTagPartnerId = hostData.tagPartnerId || '';
        const guestTagPartnerId = guestData.tagPartnerId || '';
        const winnerIds = hostResult === 'win'
          ? [matchData.userId, hostTagPartnerId].filter(id => id)
          : [matchData.guestId, guestTagPartnerId].filter(id => id);
        const loserIds = hostResult === 'win'
          ? [matchData.guestId, guestTagPartnerId].filter(id => id)
          : [matchData.userId, hostTagPartnerId].filter(id => id);

        const { winPoints, losePoints, ratingChanges } = await updateTeamRatings(winnerIds, loserIds);
        updateData.teamRatingChanges = ratingChanges;
      } else if (hostResult === 'cancel' && guestResult === 'cancel') {
        updateData.status = 'finished';
        updateData.teamRatingChanges = {
          [matchData.userId]: 0,
          [matchData.guestId]: 0,
          ...(matchData.hostTagPartnerId ? { [matchData.hostTagPartnerId]: 0 } : {}),
          ...(matchData.guestTagPartnerId ? { [matchData.guestTagPartnerId]: 0 } : {})
        };
      }
    }

    await matchRef.update(updateData);
    res.send('OK');
  } catch (error) {
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

    const matchSnap = await matchRef.get();
    if (!matchSnap.exists || (matchSnap.data().userId !== userId && matchSnap.data().guestId !== userId)) {
      return res.status(403).send('このマッチにアクセスする権限がありません');
    }

    const matchData = matchSnap.data();
    const totalMessages = matchData.totalMessages || 0;
    const totalChars = matchData.totalChars || 0;
    if (totalMessages >= 100) {
      return res.status(400).send('このルームのメッセージ回数上限（100回）に達しました');
    }
    if (totalChars + message.length > 10000) {
      return res.status(400).send('このルームの文字数上限（10,000文字）に達しました');
    }

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

    const jstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);

    const userSnap = await db.collection('users').doc(userId).get();
    const handleName = userSnap.data()?.handleName || '不明';
    await messagesRef.add({
      userId,
      handleName,
      message,
      timestamp: now.toISOString(),
      time: jstTime
    });

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
    res.status(500).send(`エラー: ${error.message}`);
  }
});

app.listen(3000, () => console.log('サーバー起動: http://localhost:3000'));