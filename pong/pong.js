import { Link, cleanCode, describeError } from '../shared/net.js';

// ---------- Constants (field units; portrait 9 x 16) ----------
const W = 9, H = 16;
const PW = 1.15;          // paddle half-width
const PT = 0.32;          // paddle thickness
const PY = [H - 1.35, 1.35]; // paddle y: player 0 bottom, player 1 top
const BR = 0.2;           // ball radius
const WIN = 7;
const SERVE_SPEED = 8.5, MAX_SPEED = 23, ACCEL = 1.05;
const STEP = 1 / 120;
const COL = ['#2ef6ff', '#ff3dd8'];
const COL_RGB = [[46, 246, 255], [255, 61, 216]];

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const screens = ['scrMenu', 'scrPause', 'scrLobby', 'scrJoin', 'scrOver'];
function show(id) { for (const s of screens) $(s).classList.toggle('on', s === id); }
function toast(text, ms = 1800) {
  const t = $('toast'); t.textContent = text; t.classList.add('on');
  clearTimeout(toast._t); if (ms) toast._t = setTimeout(() => t.classList.remove('on'), ms);
}
function hideToast() { $('toast').classList.remove('on'); }

// ---------- View / resize ----------
let view = { s: 1, ox: 0, oy: 0, dpr: 1, w: 0, h: 0 };
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const s = Math.min(w / W, h / H);
  view = { s, ox: (w - W * s) / 2, oy: (h - H * s) / 2, dpr, w, h };
}
window.addEventListener('resize', resize);
resize();

// ---------- Audio ----------
let ac = null;
let muted = false;
try { muted = localStorage.getItem('pong.muted') === '1'; } catch {}
function updateMuteBtn() { $('btnMute').textContent = muted ? '🔇' : '🔊'; }
updateMuteBtn();
function unlockAudio() {
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  } catch {}
}
function tone(freq, dur = 0.08, type = 'square', vol = 0.12, slideTo = 0, delay = 0) {
  if (!ac || muted) return;
  const t = ac.currentTime + delay;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t); o.stop(t + dur + 0.03);
}
const sfx = {
  hit: (speed) => { const f = 330 + (speed - SERVE_SPEED) * 28; tone(f, 0.09, 'square', 0.11, f * 1.5); },
  wall: () => tone(200, 0.05, 'triangle', 0.1),
  serve: () => tone(520, 0.06, 'sine', 0.08),
  score: (good) => good ? (tone(523, 0.1, 'square', 0.1), tone(784, 0.16, 'square', 0.1, 0, 0.09))
                        : tone(260, 0.35, 'sawtooth', 0.09, 70),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.1, 0, i * 0.11)),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.22, 'triangle', 0.12, 0, i * 0.13)),
};
const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch {} };

// ---------- Game state ----------
// mode: 'solo' | 'local' | 'host' | 'guest'
let mode = null;
let me = 0;              // which paddle this device's main player controls
let running = false;
let paused = false;      // user pause (solo/local only)
let netWait = false;     // waiting on the other device
let S = null;            // authoritative (or last received) state
let link = null;

function newState() {
  return {
    bx: W / 2, by: H / 2, vx: 0, vy: 0,
    p: [W / 2, W / 2], sc: [0, 0],
    ph: 'serve', cd: 1.6, srv: Math.random() < 0.5 ? 0 : 1,
    h: 0, wb: 0, last: -1, win: -1,
    ang: randAng(), pred: false, hold: false,
  };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function randAng() { return (Math.random() * 2 - 1) * 0.45; }
const online = () => mode === 'host' || mode === 'guest';
const target = [W / 2, W / 2];     // desired paddle x from input
const pvel = [0, 0];               // paddle velocity (for spin)
const cpu = { err: 0, think: 0 };

function step(dt) {
  if (S.ph === 'serve') {
    S.bx = W / 2; S.by = H / 2;
    S.cd -= dt;
    if (S.cd <= 0) {
      S.ph = 'play';
      const a = S.ang;
      const dir = S.srv === 0 ? 1 : -1;
      S.vx = Math.sin(a) * SERVE_SPEED;
      S.vy = Math.cos(a) * SERVE_SPEED * dir;
      S.last = -1; S.pred = false; S.hold = false;
    }
    return;
  }
  if (S.ph !== 'play' || S.hold) return;

  const py = S.by;
  S.bx += S.vx * dt; S.by += S.vy * dt;
  if (S.bx < BR) { S.bx = 2 * BR - S.bx; S.vx = Math.abs(S.vx); S.wb++; }
  else if (S.bx > W - BR) { S.bx = 2 * (W - BR) - S.bx; S.vx = -Math.abs(S.vx); S.wb++; }

  const face0 = PY[0] - PT / 2;
  if (S.vy > 0 && py + BR <= face0 + 0.02 && S.by + BR >= face0 && Math.abs(S.bx - S.p[0]) <= PW + BR) hit(0, face0 - BR);
  const face1 = PY[1] + PT / 2;
  if (S.vy < 0 && py - BR >= face1 - 0.02 && S.by - BR <= face1 && Math.abs(S.bx - S.p[1]) <= PW + BR) hit(1, face1 + BR);

  if (S.by > H + BR * 3) goal(1);
  else if (S.by < -BR * 3) goal(0);
}

// Online, each phone is the authority for its own paddle and goal line.
// The ball passing the OTHER player's line just waits for their verdict.
function goal(scorer) {
  if (!online()) { point(scorer); return; }
  if (1 - scorer === me) {
    point(scorer);
    link?.send({ t: 'pt', sc: S.sc, srv: S.srv, ang: S.ang });
  } else {
    S.hold = true; S.vx = S.vy = 0;
  }
}

function hit(i, y) {
  const off = clamp((S.bx - S.p[i]) / (PW + BR), -1, 1);
  const sp = Math.min(Math.hypot(S.vx, S.vy) * ACCEL, MAX_SPEED);
  const ang = off * 1.0; // up to ~57°
  const dir = i === 0 ? -1 : 1;
  let vx = Math.sin(ang) * sp + clamp(pvel[i], -30, 30) * 0.1;
  vx = clamp(vx, -sp * 0.85, sp * 0.85);
  S.vx = vx;
  S.vy = Math.sqrt(Math.max(sp * sp - vx * vx, 1)) * dir;
  S.by = y;
  S.h++; S.last = i;
  if (online()) {
    if (i === me) {
      S.pred = false;
      net.myHits++;
      link?.send({ t: 'hit', n: net.myHits, b: [r3(S.bx), r3(S.by), r3(S.vx), r3(S.vy)] });
    } else S.pred = true; // predicted from opponent's last known paddle; confirmed/corrected by their message
  }
  cpu.err = (Math.random() * 2 - 1) * 0.9;
}

function point(i) {
  S.sc[i]++;
  S.vx = S.vy = 0;
  if (S.sc[i] >= WIN) { S.ph = 'over'; S.win = i; }
  else { S.ph = 'serve'; S.cd = 1.1; S.srv = 1 - i; S.ang = randAng(); }
  S.pred = false; S.hold = false;
}

// CPU: predicts where the ball will cross its line, with some error and limited speed
function cpuThink(dt) {
  const i = 1;
  let tx = W / 2;
  if (S.ph === 'play' && S.vy < 0) {
    const t = (S.by - PY[1]) / -S.vy;
    let x = S.bx + S.vx * t;
    const span = W - 2 * BR;
    x -= BR;
    x = ((x % (2 * span)) + 2 * span) % (2 * span);
    if (x > span) x = 2 * span - x;
    tx = x + BR + cpu.err * (0.6 + Math.hypot(S.vx, S.vy) / MAX_SPEED);
  } else if (S.ph === 'play') {
    tx = W / 2 + (S.bx - W / 2) * 0.35;
  }
  const lead = Math.min(S.sc[0] - S.sc[1], 3);
  const maxV = 9.5 + lead * 0.6 + (S.h % 20) * 0.08;
  const d = tx - S.p[i];
  const mv = clamp(d, -maxV * dt, maxV * dt);
  const nx = clamp(S.p[i] + mv, PW * 0.6, W - PW * 0.6);
  pvel[i] = (nx - S.p[i]) / dt;
  S.p[i] = nx;
}

// Human paddles: follow target closely
function movePaddle(i, dt) {
  const k = 1 - Math.exp(-dt * 40);
  const nx = clamp(S.p[i] + (target[i] - S.p[i]) * k, PW * 0.6, W - PW * 0.6);
  pvel[i] = pvel[i] * 0.7 + ((nx - S.p[i]) / dt) * 0.3;
  S.p[i] = nx;
}

// ---------- Input ----------
const flip = () => mode === 'guest';
const pointers = new Map();
function toField(cx, cy) {
  let x = (cx - view.ox) / view.s, y = (cy - view.oy) / view.s;
  if (flip()) { x = W - x; y = H - y; }
  return { x, y };
}
function pointerPlayer(e) {
  if (mode === 'local') return e.clientY > view.h / 2 ? 0 : 1;
  return me;
}
canvas.addEventListener('pointerdown', (e) => {
  unlockAudio();
  if (!running) return;
  const pl = pointerPlayer(e);
  pointers.set(e.pointerId, pl);
  target[pl] = clamp(toField(e.clientX, e.clientY).x, 0, W);
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  target[pointers.get(e.pointerId)] = clamp(toField(e.clientX, e.clientY).x, 0, W);
  e.preventDefault();
});
const endPointer = (e) => pointers.delete(e.pointerId);
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
document.addEventListener('touchmove', (e) => { if (running) e.preventDefault(); }, { passive: false });

const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys.add(e.key.toLowerCase());
  if (e.key === 'Escape' || e.key === 'p') togglePause();
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
function keyInput(dt) {
  const sp = 14 * dt;
  const dirFlip = flip() ? -1 : 1;
  const k0 = (keys.has('arrowright') - keys.has('arrowleft')) * dirFlip;
  if (mode === 'local') {
    if (k0) target[0] = clamp(S.p[0] + k0 * sp * 3, 0, W);
    const k1 = keys.has('d') - keys.has('a');
    if (k1) target[1] = clamp(S.p[1] + k1 * sp * 3, 0, W);
  } else {
    const k = k0 || (keys.has('d') - keys.has('a')) * dirFlip;
    if (k) target[me] = clamp(S.p[me] + k * sp * 3, 0, W);
  }
}

// ---------- Effects ----------
const parts = [];
const trail = [];
let shake = 0, flash = 0, flashCol = COL_RGB[0], scorePulse = [0, 0];
function burst(x, y, rgb, n, speed, life = 0.6) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.3 + Math.random());
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life, max: life, rgb, r: 0.05 + Math.random() * 0.08 });
  }
  if (parts.length > 400) parts.splice(0, parts.length - 400);
}

let ev = null; // last seen event counters
function syncEvents(silent) {
  ev = { h: S.h, wb: S.wb, s0: S.sc[0], s1: S.sc[1], ph: S.ph };
  if (silent) return;
}
function detectEvents() {
  if (!ev) return syncEvents();
  const speed = Math.hypot(S.vx, S.vy);
  if (S.h !== ev.h && S.last >= 0) {
    const i = S.last;
    burst(S.bx, PY[i] + (i === 0 ? -PT : PT), COL_RGB[i], 14 + Math.round(speed), 3 + speed * 0.25, 0.45);
    sfx.hit(speed);
    if (mode === 'local' || i === me) buzz(12);
  }
  if (S.wb !== ev.wb) { sfx.wall(); burst(S.bx < W / 2 ? 0 : W, S.by, [200, 200, 255], 6, 3, 0.3); }
  const scored = S.sc[0] > ev.s0 ? 0 : S.sc[1] > ev.s1 ? 1 : -1;
  if (scored >= 0) {
    const y = scored === 0 ? 0 : H;
    burst(clamp(lastBall.x, 0, W), y, COL_RGB[scored], 60, 9, 0.9);
    shake = 0.35; flash = 0.5; flashCol = COL_RGB[scored]; scorePulse[scored] = 1;
    const good = mode === 'local' || mode === 'solo' && scored === 0 || scored === me;
    if (S.ph !== 'over') sfx.score(mode === 'local' ? true : good);
    buzz(scored === me || mode === 'local' ? 30 : [40, 40, 60]);
  }
  if (S.ph !== ev.ph) {
    if (ev.ph === 'serve' && S.ph === 'play') sfx.serve();
    if (S.ph === 'over') gameOver();
    if (ev.ph === 'over' && S.ph !== 'over') { show(null); trail.length = 0; }
  }
  syncEvents();
}

// ---------- Networking ----------
// Both phones run the full simulation. Messages:
//   p   paddle x (stream)          hit  my paddle hit the ball: new ball state
//   pt  ball passed my line: score  go   (host) start/restart a match
//   r   (guest) rematch request    pi/po latency ping
const net = { myHits: 0, theirHits: 0, gen: 0, oppX: W / 2, rtt: 0, lastPo: 0, goAt: 0, lastGo: 0, lastPing: 0 };
let lastRecv = 0, lastSend = 0;
const r3 = (v) => Math.round(v * 1000) / 1000;
const oneWay = () => clamp(net.rtt / 2, 0, 250) / 1000;

// Move the ball forward in time (walls only), without crossing my own paddle face
function advanceBall(t) {
  const myFace = me === 0 ? PY[0] - PT / 2 - BR : PY[1] + PT / 2 + BR;
  if ((me === 0 && S.vy > 0) || (me === 1 && S.vy < 0)) t = Math.min(t, Math.max(0, (myFace - S.by) / S.vy - 0.01));
  let x = S.bx + S.vx * t;
  if (x < BR) x = 2 * BR - x; else if (x > W - BR) x = 2 * (W - BR) - x;
  S.bx = clamp(x, BR, W - BR); S.by += S.vy * t;
}

function sendGo() {
  link?.send({ t: 'go', g: net.gen, srv: S.srv, ang: S.ang, cd: r3(S.cd) });
}

function onData(m) {
  lastRecv = performance.now();
  if (!m || typeof m !== 'object' || !S) return;
  switch (m.t) {
    case 'p':
      if (typeof m.x === 'number') net.oppX = clamp(m.x, 0, W);
      break;
    case 'pi':
      link?.send({ t: 'po', ts: m.ts });
      break;
    case 'po':
      if (m.ts > net.lastPo) {
        net.lastPo = m.ts;
        const sample = performance.now() - m.ts;
        net.rtt = net.rtt ? net.rtt * 0.8 + sample * 0.2 : sample;
      }
      break;
    case 'hit':
      if (m.n <= net.theirHits || S.ph === 'over') break;
      net.theirHits = m.n;
      [S.bx, S.by, S.vx, S.vy] = m.b;
      if (!S.pred) S.h++; // show the hit effect if we hadn't predicted it
      S.last = 1 - me; S.pred = false; S.hold = false; S.ph = 'play';
      advanceBall(oneWay());
      break;
    case 'pt': {
      const total = m.sc[0] + m.sc[1];
      if (total <= S.sc[0] + S.sc[1]) break;
      S.sc = m.sc.slice(); S.vx = S.vy = 0; S.pred = false; S.hold = false;
      const w = S.sc[0] >= WIN ? 0 : S.sc[1] >= WIN ? 1 : -1;
      if (w >= 0) { S.ph = 'over'; S.win = w; }
      else { S.ph = 'serve'; S.srv = m.srv; S.ang = m.ang; S.cd = Math.max(0.2, 1.1 - oneWay()); }
      break;
    }
    case 'go':
      if (mode !== 'guest' || m.g <= net.gen) break;
      net.gen = m.g;
      resetMatch();
      S.srv = m.srv; S.ang = m.ang; S.cd = Math.max(0.2, m.cd - oneWay());
      break;
    case 'r':
      if (mode === 'host' && S.ph === 'over') hostRematch();
      break;
  }
}

function hostRematch() {
  net.gen++;
  resetMatch();
  net.goAt = performance.now(); net.lastGo = 0;
}

// ---------- Flow ----------
function startGame(m) {
  mode = m;
  me = mode === 'guest' ? 1 : 0;
  S = newState();
  target[0] = target[1] = W / 2;
  pvel[0] = pvel[1] = 0;
  parts.length = 0; trail.length = 0;
  Object.assign(net, { myHits: 0, theirHits: 0, gen: 0, oppX: W / 2, rtt: 0, lastPo: 0, goAt: 0, lastGo: 0, lastPing: 0 });
  if (mode === 'guest') S.ph = 'wait';           // until the host's "go"
  if (mode === 'host') hostRematch();
  lastRecv = performance.now();
  syncEvents();
  running = true; paused = false; netWait = false;
  show(null); hideToast();
  $('hud').classList.add('on');
  updateNetMode();
  requestWakeLock();
}

function updateNetMode() {
  const el = $('netMode');
  if (!link || !(mode === 'host' || mode === 'guest')) { el.textContent = ''; return; }
  el.textContent = link.isDirect ? '⚡ Direct' : '☁ Relay';
}

// Fresh match on this device (keeps mode and connection)
function resetMatch() {
  const wasOver = S && S.ph === 'over';
  S = newState();
  target[0] = target[1] = W / 2;
  parts.length = 0; trail.length = 0;
  net.myHits = net.theirHits = 0;
  syncEvents();
  paused = false;
  if (wasOver || $('scrOver').classList.contains('on')) show(null);
}

function restart() {
  if (mode === 'host') hostRematch();
  else resetMatch();
}

function gameOver() {
  const w = S.win;
  let title, msg = '';
  if (mode === 'local') title = w === 0 ? 'BOTTOM WINS' : 'TOP WINS';
  else title = w === me ? 'YOU WIN' : 'YOU LOSE';
  const mine = mode === 'local' ? S.sc[0] : S.sc[me];
  const theirs = mode === 'local' ? S.sc[1] : S.sc[1 - me];
  $('overTitle').textContent = title;
  $('overTitle').style.color = COL[mode === 'local' ? w : (w === me ? me : 1 - me)];
  $('overScore').textContent = `${mine} – ${theirs}`;
  if (mode === 'guest') msg = 'Tap Rematch to play again.';
  $('overMsg').textContent = msg;
  $('btnRematch').disabled = false;
  (mode === 'local' || w === me) ? sfx.win() : sfx.lose();
  show('scrOver');
}

function toMenu() {
  running = false; paused = false; netWait = false;
  if (link) { link.destroy(); link = null; }
  mode = null;
  S = null;
  $('hud').classList.remove('on');
  hideToast();
  releaseWakeLock();
  show('scrMenu');
  history.replaceState(null, '', location.pathname);
}

function togglePause() {
  if (!running) return;
  if (mode === 'host' || mode === 'guest') {
    // online: no real pause, just open the quit menu
    $('btnResume').textContent = 'Back to game';
  } else $('btnResume').textContent = 'Resume';
  if ($('scrPause').classList.contains('on')) { show(null); paused = false; }
  else if (!$('scrOver').classList.contains('on')) { show('scrPause'); paused = mode === 'solo' || mode === 'local'; }
}

async function hostGame() {
  show('scrLobby');
  $('lobbyCode').textContent = '····';
  $('lobbyMsg').innerHTML = '<span class="dots">Setting up</span>';
  $('btnShare').disabled = true;
  link = new Link('pong');
  const myLink = link;
  link.on('data', onData).on('close', onPeerClose).on('mode', updateNetMode);
  link.on('connect', () => { if (link === myLink) { buzz(30); startGame('host'); } });
  try {
    const code = await link.host();
    if (link !== myLink) return;
    $('lobbyCode').textContent = code;
    $('lobbyMsg').innerHTML = '<span class="dots">Waiting for player 2</span>';
    $('btnShare').disabled = false;
  } catch (e) {
    if (link !== myLink) return;
    link.destroy(); link = null;
    show('scrMenu');
    menuMsg(describeError(e), true);
  }
}

async function joinGame(raw) {
  const code = cleanCode(raw);
  if (code.length !== 4) { menuMsg('Enter the 4-letter code from the host.', true); return; }
  show('scrJoin');
  $('joinTitle').textContent = `JOINING ${code}`;
  link = new Link('pong');
  const myLink = link;
  link.on('data', onData).on('close', onPeerClose).on('mode', updateNetMode);
  try {
    await link.join(code);
    if (link !== myLink) return;
    buzz(30);
    startGame('guest');
  } catch (e) {
    if (link !== myLink) return;
    link.destroy(); link = null;
    show('scrMenu');
    menuMsg(describeError(e), true);
  }
}

function onPeerClose() {
  if (!running) return;
  running = false;
  $('hud').classList.remove('on');
  $('overTitle').textContent = 'DISCONNECTED';
  $('overTitle').style.color = '';
  $('overScore').textContent = `${S.sc[me]} – ${S.sc[1 - me]}`;
  $('overMsg').textContent = 'The other player left the game.';
  $('btnRematch').disabled = true;
  show('scrOver');
  if (link) { link.destroy(); link = null; }
}

function menuMsg(t, err) { const m = $('menuMsg'); m.textContent = t || ''; m.classList.toggle('err', !!err); }

async function shareInvite() {
  const url = `${location.origin}${location.pathname}?join=${link?.code}`;
  const text = `Play Pong with me! Code ${link?.code}`;
  try {
    if (navigator.share) { await navigator.share({ title: 'Neon Pong', text, url }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  catch { toast(url, 5000); }
}

// Buttons
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  unlockAudio();
  const act = b.dataset.act;
  menuMsg('');
  if (act === 'solo') startGame('solo');
  else if (act === 'local') startGame('local');
  else if (act === 'host') hostGame();
  else if (act === 'join') joinGame($('joinCode').value);
  else if (act === 'menu') toMenu();
  else if (act === 'resume') { show(null); paused = false; }
  else if (act === 'share') shareInvite();
  else if (act === 'rematch') {
    if (mode === 'guest') { link?.send({ t: 'r' }); $('overMsg').textContent = 'Starting…'; }
    else restart();
  }
});
$('btnPause').addEventListener('click', togglePause);
$('btnMute').addEventListener('click', () => {
  muted = !muted; updateMuteBtn(); unlockAudio();
  try { localStorage.setItem('pong.muted', muted ? '1' : '0'); } catch {}
});
$('joinCode').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value); });
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(e.target.value); });

document.addEventListener('visibilitychange', () => {
  if (document.hidden && running && (mode === 'solo' || mode === 'local') && !paused && S.ph !== 'over') togglePause();
  if (!document.hidden && running) requestWakeLock();
});

// Wake lock keeps the screen on during play
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
}
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }

// ---------- Main loop ----------
let acc = 0, lastT = performance.now();
const lastBall = { x: W / 2, y: H / 2 };

function update(dt, now) {
  keyInput(dt);
  const on = online();
  netWait = on && now - lastRecv > 2000;
  if (!paused && !netWait) {
    acc += dt;
    while (acc >= STEP) {
      if (mode === 'solo') { movePaddle(0, STEP); cpuThink(STEP); }
      else if (mode === 'local') { movePaddle(0, STEP); movePaddle(1, STEP); }
      else { movePaddle(me, STEP); target[1 - me] = net.oppX; movePaddle(1 - me, STEP); }
      step(STEP);
      acc -= STEP;
    }
  } else acc = 0;

  if (on) {
    if (now - lastSend > (link?.isDirect ? 16 : 33)) { link?.send({ t: 'p', x: r3(S.p[me]) }); lastSend = now; }
    if (now - net.lastPing > 1000) { link?.send({ t: 'pi', ts: now }); net.lastPing = now; }
    if (mode === 'host' && now - net.goAt < 1500 && now - net.lastGo > 250) { sendGo(); net.lastGo = now; }
  }

  if (S.ph === 'play' && S.by > -1 && S.by < H + 1) { lastBall.x = S.bx; lastBall.y = S.by; }
  detectEvents();

  if (netWait && S.ph !== 'over') toast(mode === 'host' ? 'Waiting for player 2…' : 'Waiting for host…', 0);
  else if (netWait === false && $('toast').textContent.startsWith('Waiting')) hideToast();
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  if (running && S) update(dt, now);
  render(dt, now);
}

// ---------- Rendering ----------
function render(dt, now) {
  const { s, ox, oy, dpr, w, h } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#05040c';
  ctx.fillRect(0, 0, w, h);

  const st = S || attract(now);
  shake = Math.max(0, shake - dt);
  flash = Math.max(0, flash - dt * 1.6);
  const sh = shake * shake * 0.9 * s;
  const sx = (Math.random() * 2 - 1) * sh, sy = (Math.random() * 2 - 1) * sh;

  ctx.save();
  ctx.translate(ox + sx, oy + sy);
  ctx.scale(s, s);
  if (flip()) { ctx.translate(W, H); ctx.rotate(Math.PI); }

  // Field
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(255,61,216,0.07)');
  g.addColorStop(0.5, 'rgba(20,14,50,0.25)');
  g.addColorStop(1, 'rgba(46,246,255,0.07)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.lineWidth = 0.015;
  ctx.strokeStyle = 'rgba(140,150,255,0.07)';
  ctx.beginPath();
  for (let x = 1; x < W; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = 1; y < H; y++) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();

  if (flash > 0) {
    ctx.fillStyle = `rgba(${flashCol[0]},${flashCol[1]},${flashCol[2]},${flash * 0.18})`;
    ctx.fillRect(0, 0, W, H);
  }

  // side rails
  ctx.lineWidth = 0.06;
  ctx.strokeStyle = 'rgba(160,170,255,0.35)';
  ctx.beginPath(); ctx.moveTo(0.03, 0); ctx.lineTo(0.03, H); ctx.moveTo(W - 0.03, 0); ctx.lineTo(W - 0.03, H); ctx.stroke();

  // center line
  ctx.setLineDash([0.3, 0.3]);
  ctx.lineWidth = 0.05;
  ctx.strokeStyle = 'rgba(200,200,255,0.22)';
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  ctx.setLineDash([]);

  ctx.restore();

  // Scores (drawn upright in screen space)
  drawScores(st, dt);

  ctx.save();
  ctx.translate(ox + sx, oy + sy);
  ctx.scale(s, s);
  if (flip()) { ctx.translate(W, H); ctx.rotate(Math.PI); }
  ctx.globalCompositeOperation = 'lighter';

  // Trail
  if (st.ph === 'play') {
    trail.push({ x: st.bx, y: st.by });
    const maxLen = 6 + Math.round(Math.hypot(st.vx, st.vy) * 0.8);
    while (trail.length > maxLen) trail.shift();
  } else if (trail.length) trail.shift();
  const tc = st.last >= 0 ? COL_RGB[st.last] : [220, 220, 255];
  for (let i = 0; i < trail.length; i++) {
    const t = (i + 1) / trail.length;
    ctx.fillStyle = `rgba(${tc[0]},${tc[1]},${tc[2]},${t * 0.35})`;
    ctx.beginPath(); ctx.arc(trail[i].x, trail[i].y, BR * (0.35 + t * 0.6), 0, 7); ctx.fill();
  }

  // Particles
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    if (p.life <= 0) { parts.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 2.5; p.vy *= 1 - dt * 2.5;
    const a = p.life / p.max;
    ctx.fillStyle = `rgba(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]},${a})`;
    ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
  }

  // Paddles
  for (let i = 0; i < 2; i++) {
    const x = st.p[i], y = PY[i];
    ctx.shadowColor = COL[i];
    ctx.shadowBlur = 22 * view.dpr;
    ctx.fillStyle = COL[i];
    roundRect(x - PW, y - PT / 2, PW * 2, PT, PT / 2);
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    roundRect(x - PW + 0.12, y - 0.04, PW * 2 - 0.24, 0.08, 0.04);
  }

  // Ball
  if (st.ph !== 'over') {
    let r = BR;
    let alpha = 1;
    if (st.ph === 'serve') { const pulse = 0.5 + 0.5 * Math.sin(now / 90); r = BR * (0.8 + pulse * 0.35); alpha = 0.55 + pulse * 0.45; }
    ctx.shadowColor = st.last >= 0 ? COL[st.last] : '#ffffff';
    ctx.shadowBlur = 26 * view.dpr;
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.beginPath(); ctx.arc(st.bx, st.by, r, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
  }
  ctx.restore();

  // "Serve" hint arrow toward receiver on first serve
  if (S && running && st.ph === 'serve' && st.sc[0] + st.sc[1] === 0) {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(238,241,255,0.85)';
    ctx.font = `800 ${Math.round(s * 0.55)}px Orbitron, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const hint = mode === 'local' ? 'DRAG IN YOUR HALF' : 'DRAG TO MOVE';
    ctx.fillText('READY', w / 2, oy + (H / 2 - 1.1) * s);
    ctx.font = `600 ${Math.round(s * 0.3)}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(238,241,255,0.55)';
    ctx.fillText(hint, w / 2, oy + (H / 2 + 1.1) * s);
    ctx.restore();
  }
}

function drawScores(st, dt) {
  const { s, ox, oy, dpr, w } = view;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const bottom = flip() ? 1 : 0, top = 1 - bottom;
  for (const [pl, yField, rot] of [[bottom, H * 0.75, false], [top, H * 0.25, mode === 'local']]) {
    scorePulse[pl] = Math.max(0, scorePulse[pl] - dt * 1.5);
    const pulse = scorePulse[pl];
    const size = Math.round(s * (3.2 + pulse * 1.2));
    const [r, g, b] = COL_RGB[pl];
    ctx.save();
    ctx.translate(w / 2, oy + yField * s);
    if (rot) ctx.rotate(Math.PI);
    ctx.font = `900 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.fillStyle = `rgba(${r},${g},${b},${0.13 + pulse * 0.5})`;
    ctx.fillText(String(st.sc[pl]), 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

// Attract-mode demo behind the menu
const demo = { bx: W / 2, by: H / 2, vx: 3.3, vy: 6.1, p: [W / 2, W / 2], sc: [0, 0], ph: 'play', last: -1 };
let demoT = 0;
function attract(now) {
  const dt = Math.min((now - (demoT || now)) / 1000, 0.05); demoT = now;
  demo.bx += demo.vx * dt; demo.by += demo.vy * dt;
  if (demo.bx < BR || demo.bx > W - BR) { demo.vx *= -1; demo.bx = clamp(demo.bx, BR, W - BR); }
  if (demo.by > PY[0] - PT / 2 - BR && demo.vy > 0) { demo.vy *= -1; demo.last = 0; }
  if (demo.by < PY[1] + PT / 2 + BR && demo.vy < 0) { demo.vy *= -1; demo.last = 1; }
  for (let i = 0; i < 2; i++) demo.p[i] += (clamp(demo.bx + Math.sin(now / 700 + i) * 0.6, PW, W - PW) - demo.p[i]) * Math.min(1, dt * 6);
  return demo;
}

requestAnimationFrame(frame);

// Auto-join from invite link (?join=CODE)
const qJoin = cleanCode(new URLSearchParams(location.search).get('join'));
if (qJoin.length === 4) { $('joinCode').value = qJoin; joinGame(qJoin); }

// Debug/test hook (read-only)
window.__pong = { get S() { return S; }, get net() { return net; }, get view() { return view; }, get mode() { return mode; } };
