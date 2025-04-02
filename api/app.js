const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const { createClient } = require('redis');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, collection, query, where, getDocs } = require('firebase/firestore');
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

const redisClient = createClient({
  url: process.env.REDIS_URL // Upstashから取得
});
redisClient.on('error', (err) => console.error('Redisエラー:', err));
redisClient.connect();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax'
  }
}));
app.use(passport.initialize());
app.use(passport.session());

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
  passport.authenticate('google', { scope: ['profile', 'email'], state: redirectTo })(req, res, next);
});

app.get('/api/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/api/' }), 
  (req, res) => {
    console.log('コールバック成功:', req.user.id);
    const redirectTo = req.query.state || '/api/';
    res.redirect(redirectTo);
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
  req.logout(() => res.redirect('/api/'));
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
    res.redirect(`/api/solo/setup/${matchId}`); // 成立したらセットアップ画面へ
  } else {
    const waitingQuery = query(matchesRef, where('userId', '==', userId), where('status', '==', 'waiting'));
    const waitingSnapshot = await getDocs(waitingQuery);
    const roomId = waitingSnapshot.empty ? '' : waitingSnapshot.docs[0].data().roomId;
    res.send(`
      <html>
        <body>
          <h1>マッチング待機中</h1>
          <p>相手を待っています... あなたのレート: ${req.user.rating || 1500}</p>
          <form action="/api/solo/update" method="POST">
            <label>専用部屋ID: <input type="text" name="roomId" value="${roomId}"></label>
            <button type="submit">IDを設定して更新</button>
          </form>
          <p><a href="/api/solo/cancel">キャンセル</a></p>
        </body>
      </html>
    `);
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
      const opponentRef = doc(db, 'users', opponentData.userId);
      const opponentSnap = await getDoc(opponentRef);
      const opponentRating = opponentSnap.exists() ? (opponentSnap.data().rating || 1500) : 1500;
      if (Math.abs(userRating - opponentRating) <= 200 && opponentData.roomId) {
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
        res.redirect(`/api/solo/setup/${newMatchDoc.id}`);
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
    const firebaseConfig = {
      apiKey: "${process.env.FIREBASE_API_KEY}",
      authDomain: "${process.env.FIREBASE_AUTH_DOMAIN}",
      projectId: "${process.env.FIREBASE_PROJECT_ID}",
      storageBucket: "${process.env.FIREBASE_STORAGE_BUCKET}",
      messagingSenderId: "${process.env.FIREBASE_MESSAGING_SENDER_ID}",
      appId: "${process.env.FIREBASE_APP_ID}",
      measurementId: "${process.env.FIREBASE_MEASUREMENT_ID}"
    };
    firebase.initializeApp(firebaseConfig);
    const db = firebase.firestore();
  `;

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
            opacity: 0.3; 
            transition: opacity 0.3s; 
            border: none; 
            background: none; 
            padding: 0; 
          }
          .char-btn.selected { 
            opacity: 1; 
          }
          .stage-btn { 
            opacity: 0.3; 
            transition: opacity 0.3s; 
            border: none; 
            background: none; 
            padding: 0; 
          }
          .stage-btn.selected { 
            opacity: 1; 
          }
          button:not(.char-btn):not(.stage-btn) { 
            opacity: 1 !important; 
          }
        </style>
        <script src="https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js"></script>
        <script src="https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js"></script>
        <script>${firebaseConfigScript}</script>
      </head>
      <body>
        <div class="overlay" id="overlay"></div>
        <h1>マッチング成立！</h1>
        <p>相手: ${opponentName} (レート: ${opponentRating})</p>
        <p>相手の専用部屋ID: ${matchData.opponentRoomId || '未設定'}</p>
        <p id="myStatus">あなたの選択: ${myChoices.character ? '完了' : '未選択'}</p>
        <p id="opponentStatus">相手の選択: ${opponentChoices.character ? '完了' : '未選択'}</p>
        <p id="guide">${myChoices.character && !opponentChoices.character ? '相手の選択を待っています...' : (myChoices.character && opponentChoices.character ? '次のステップへ: <a href="/api/solo/ban/${matchId}">ステージ拒否</a>' : 'キャラクターを選んでください')}</p>
  
        <div class="section">
          <h2>キャラクター選択</h2>
          ${popularCharacters.map(char => `
            <button class="popular char-btn ${myChoices.character === char.id ? 'selected' : ''}" data-id="${char.id}" onclick="selectCharacter('${char.id}', '${char.name}')">
              <img src="/characters/${char.id}.png">
            </button>
          `).join('')}
          <button onclick="document.getElementById('charPopup').style.display='block';document.getElementById('overlay').style.display='block';">全キャラから選ぶ</button>
          <div id="charPopup" class="popup">
            ${allCharacters.map(char => `
              <button class="char-btn ${myChoices.character === char.id ? 'selected' : ''}" data-id="${char.id}" onclick="selectCharacter('${char.id}', '${char.name}')">
                <img src="/characters/${char.id}.png">
              </button>
            `).join('')}
          </div>
        </div>
  
        <div class="section" id="miiInput">
          <h2>Miiファイター設定</h2>
          <label>技番号（例: 1233）: <input type="text" id="miiMoves" maxlength="4" value="${myChoices.miiMoves || ''}"></label>
        </div>
  
        <div class="section">
          <h2>ステージ選択</h2>
          ${stages.map(stage => `
            <button class="stage-btn ${myChoices.stage === stage.id ? 'selected' : ''}" data-id="${stage.id}" onclick="selectStage('${stage.id}', '${stage.name}')">
              <img src="/stages/${stage.id}.png">
            </button>
          `).join('')}
        </div>
  
        <button onclick="saveSelections('${matchId}')">決定</button>
        <p><a href="/api/solo">戻る</a></p>
  
        <script>
          let selectedChar = '${myChoices.character || ''}';
          let selectedStage = '${myChoices.stage || ''}';
  
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
  
          function selectStage(id, name) {
            selectedStage = id;
            document.querySelectorAll('.stage-btn').forEach(btn => {
              btn.classList.toggle('selected', btn.dataset.id === id);
            });
          }
  
          document.querySelector('button[onclick*="charPopup"]').addEventListener('click', () => {
            document.getElementById('charPopup').style.display = 'block';
            document.getElementById('overlay').style.display = 'block';
          });
  
          async function saveSelections(matchId) {
            if (!selectedChar || !selectedStage) {
              alert('キャラクターとステージを選択してください');
              return;
            }
            const miiMoves = ['54', '55', '56'].includes(selectedChar) ? document.getElementById('miiMoves').value : '';
            const data = { character: selectedChar, stage: selectedStage };
            if (miiMoves) data.miiMoves = miiMoves;
  
            try {
              const response = await fetch('/api/solo/setup/' + matchId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
              });
              if (!response.ok) {
                const errorText = await response.text();
                alert('保存に失敗しました: ' + errorText);
              }
            } catch (error) {
              alert('ネットワークエラー: ' + error.message);
            }
          }
  
          db.collection('matches').doc('${matchId}').onSnapshot((doc) => {
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
          });
        </script>
      </body>
    </html>
  `);
});

// キャラ・ステージ保存処理
app.post('/api/solo/setup/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  const userId = req.user?.id;
  if (!userId) return res.status(401).send('ログインが必要です');

  const { character, stage, miiMoves } = req.body;
  if (!character || !stage) return res.status(400).send('キャラクターとステージが必要です');

  const matchRef = doc(db, 'matches', matchId);
  const matchSnap = await getDoc(matchRef);
  if (!matchSnap.exists() || (matchSnap.data().userId !== userId && matchSnap.data().opponentId !== userId)) {
    return res.status(404).send('マッチが見つかりません');
  }

  const matchData = matchSnap.data();
  const isPlayer1 = matchData.userId === userId;
  const choices = { character, stage };
  if (miiMoves) choices.miiMoves = miiMoves;

  const updateData = {
    ...(isPlayer1 ? { player1Choices: choices } : { player2Choices: choices }),
    step: matchData.step || 'character_selection'
  };

  if ((isPlayer1 && matchData.player2Choices) || (!isPlayer1 && matchData.player1Choices)) {
    updateData.step = 'stage_ban_1';
  }

  await updateDoc(matchRef, updateData);
  res.status(200).send('OK');
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