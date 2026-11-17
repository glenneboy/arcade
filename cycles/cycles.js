import { Link, cleanCode, describeError } from '../shared/net.js';

// ---------- Constants ----------
const GW = 30, GH = 52;          // grid size (portrait)
const TICK = 0.075;              // seconds per move
const WIN_ROUNDS = 3;
const MAX_AHEAD = 20;            // online: ticks we may predict past the confirmed state
const COL = ['#2ef6ff', '#ff8a1f'];
const RGB = [[46, 246, 255], [255, 138, 31]];
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0]; // 0 up, 1 right, 2 down, 3 left

// ---------- DOM helpers ----------
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
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- View ----------
let view = { cs: 10, ox: 0, oy: 0, dpr: 1, w: 0, h: 0 };
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const pad = 8;
  const cs = Math.min((w - pad * 2) / GW, (h - pad * 2 - 56) / GH);
  view = { cs, ox: (w - GW * cs) / 2, oy: (h - GH * cs) / 2 + 20, dpr, w, h };
}
window.addEventListener('resize', resize);
resize();

// ---------- Audio ----------
let ac = null, muted = false, hum = null;
try { muted = localStorage.getItem('arcade.muted') === '1'; } catch {}
function updateMuteBtn() { $('btnMute').textContent = muted ? '🔇' : '🔊'; }
updateMuteBtn();
function unlockAudio() {
  try {
    if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  } catch {}
}
function tone(freq, dur = 0.08, type = 'square', vol = 0.1, slideTo = 0, delay = 0) {
  if (!ac || muted) return;
  const t = ac.currentTime + delay;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t); o.stop(t + dur + 0.03);
}
function noise(dur = 0.5, vol = 0.25) {
  if (!ac || muted) return;
  const n = Math.floor(ac.sampleRate * dur);
  const buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
  const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  src.buffer = buf; f.type = 'lowpass'; f.frequency.value = 1400; g.gain.value = vol;
  src.connect(f).connect(g).connect(ac.destination); src.start();
}
function humOn() {
  if (!ac || muted || hum) return;
  const o = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain(), f = ac.createBiquadFilter();
  o.type = 'sawtooth'; o.frequency.value = 55; o2.type = 'sawtooth'; o2.frequency.value = 55.7;
  f.type = 'lowpass'; f.frequency.value = 420; g.gain.value = 0.0001;
  o.connect(f); o2.connect(f); f.connect(g).connect(ac.destination);
  o.start(); o2.start();
  g.gain.exponentialRampToValueAtTime(0.035, ac.currentTime + 0.3);
  hum = { o, o2, g };
}
function humOff() {
  if (!hum || !ac) { hum = null; return; }
  const h = hum; hum = null;
  try { h.g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.15); h.o.stop(ac.currentTime + 0.2); h.o2.stop(ac.currentTime + 0.2); } catch {}
}
const sfx = {
  turn: () => tone(700, 0.035, 'square', 0.04),
  beep: (hi) => tone(hi ? 880 : 440, hi ? 0.25 : 0.12, 'square', 0.09),
  crash: () => { noise(0.6, 0.3); tone(160, 0.4, 'sawtooth', 0.08, 40); },
  round: (good) => good ? [523, 784].forEach((f, i) => tone(f, 0.14, 'square', 0.09, 0, i * 0.1))
                        : tone(300, 0.3, 'triangle', 0.1, 120),
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'square', 0.1, 0, i * 0.11)),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone(f, 0.22, 'triangle', 0.12, 0, i * 0.13)),
};
const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch {} };

// ---------- Simulation (deterministic: same inputs -> same result on both phones) ----------
function newRoundState() {
  const s = {
    g: new Uint8Array(GW * GH),
    x: [GW >> 1, (GW >> 1) - 1], y: [GH - 4, 3], d: [0, 2],   // symmetric under 180° rotation
    alive: [true, true], path: [[], []], crash: [null, null], k: 0, over: false,
  };
  for (let i = 0; i < 2; i++) { const c = s.y[i] * GW + s.x[i]; s.g[c] = i + 1; s.path[i].push(c); }
  return s;
}
function cloneState(s) {
  return { g: s.g.slice(), x: s.x.slice(), y: s.y.slice(), d: s.d.slice(), alive: s.alive.slice(),
    path: [s.path[0].slice(), s.path[1].slice()], crash: s.crash.slice(), k: s.k, over: s.over };
}
function blocked(s, x, y) { return x < 0 || x >= GW || y < 0 || y >= GH || s.g[y * GW + x] !== 0; }

function stepState(s, dirs) {
  const nx = [0, 0], ny = [0, 0], dead = [false, false];
  for (let i = 0; i < 2; i++) {
    if (!s.alive[i]) continue;
    let d = dirs[i];
    if (d === undefined || d === null || (d + 2) % 4 === s.d[i]) d = s.d[i];
    s.d[i] = d;
    nx[i] = s.x[i] + DX[d]; ny[i] = s.y[i] + DY[d];
    if (blocked(s, nx[i], ny[i])) dead[i] = true;
  }
  if (s.alive[0] && s.alive[1] && nx[0] === nx[1] && ny[0] === ny[1]) dead[0] = dead[1] = true;
  for (let i = 0; i < 2; i++) {
    if (!s.alive[i]) continue;
    if (dead[i]) { s.alive[i] = false; s.crash[i] = [clamp(nx[i], 0, GW - 1), clamp(ny[i], 0, GH - 1)]; continue; }
    s.x[i] = nx[i]; s.y[i] = ny[i];
    const c = ny[i] * GW + nx[i];
    s.g[c] = i + 1; s.path[i].push(c);
  }
  s.k++;
  if (!s.alive[0] || !s.alive[1]) s.over = true;
}

// CPU: avoids death, prefers open space, tries to cut the player off
function flood(s, sx, sy, limit) {
  const seen = new Uint8Array(GW * GH);
  const q = [sy * GW + sx]; seen[q[0]] = 1;
  let n = 0;
  while (q.length && n < limit) {
    const c = q.pop(); n++;
    const x = c % GW, y = (c / GW) | 0;
    for (let d = 0; d < 4; d++) {
      const xx = x + DX[d], yy = y + DY[d];
      if (xx < 0 || xx >= GW || yy < 0 || yy >= GH) continue;
      const cc = yy * GW + xx;
      if (seen[cc] || s.g[cc]) continue;
      seen[cc] = 1; q.push(cc);
    }
  }
  return n;
}
function cpuDir(s) {
  const i = 1, o = 0, cur = s.d[i];
  if (!s.alive[i]) return cur;
  const opts = [cur, (cur + 1) % 4, (cur + 3) % 4];
  let best = cur, bestScore = -Infinity;
  const tx = s.x[o] + DX[s.d[o]] * 5, ty = s.y[o] + DY[s.d[o]] * 5;
  for (const d of opts) {
    const nx = s.x[i] + DX[d], ny = s.y[i] + DY[d];
    let score;
    if (blocked(s, nx, ny)) score = -1e6;
    else {
      score = flood(s, nx, ny, 400);
      if (d === cur) score += 6;
      score -= (Math.abs(nx - tx) + Math.abs(ny - ty)) * 0.6; // aggression
      score += Math.random() * 10;
    }
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

// ---------- Game / match state ----------
// mode: 'solo' | 'local' | 'host' | 'guest'
let mode = null, me = 0, running = false, paused = false, netWait = false, link = null;
let C = null;          // confirmed state (all inputs known)
let P = null;          // predicted state (what we draw)
let inputs = [[], []]; // inputs[player][tick] = direction
let N = 0;             // our current tick
let tickAcc = 0;
const queue = [[], []];
const match = { sc: [0, 0], round: 0, phase: 'idle', cd: 0, endT: 0, winner: -1, gen: 0, msg: '' };
const net = { oppAck: 0, rtt: 0, lastPo: 0, lastPing: 0, oppLatest: 0, goAt: 0, lastGo: 0, lastSent: 0 };
let lastRecv = 0;
const online = () => mode === 'host' || mode === 'guest';
const oneWay = () => clamp(net.rtt / 2, 0, 300) / 1000;

function startRound(cd = 3) {
  C = newRoundState(); P = C;
  inputs = [[], []]; N = 0; tickAcc = 0;
  queue[0].length = queue[1].length = 0;
  net.oppLatest = 0; net.oppAck = 0;
  match.round++;
  match.phase = 'count'; match.cd = cd; match.winner = -1;
  match.lastBeep = Math.ceil(cd) + 1;
  parts.length = 0;
}

function newMatch() {
  match.sc = [0, 0]; match.round = 0;
  startRound();
}

function queueTurn(p, d) {
  if (match.phase !== 'run' && match.phase !== 'count') return;
  const q = queue[p];
  const ref = q.length ? q[q.length - 1] : (P ? P.d[p] : d);
  if (d === ref || (d + 2) % 4 === ref) return;
  if (q.length < 3) q.push(d);
  if (match.phase === 'run') sfx.turn();
}

function doTick() {
  N++;
  const players = mode === 'local' ? [0, 1] : mode === 'solo' ? [0] : [me];
  for (const p of players) {
    let d = P.d[p];
    while (queue[p].length) {
      const t = queue[p].shift();
      if (t !== d && (t + 2) % 4 !== d) { d = t; break; }
    }
    inputs[p][N] = d;
  }
  if (mode === 'solo') inputs[1][N] = cpuDir(C);
  if (online()) sendInputs();
  advance();
}

function sendInputs() {
  // resend everything the other phone hasn't confirmed yet (plus a few recent ticks)
  const from = Math.max(1, Math.min(N - 4, net.oppAck + 1), N - 40);
  link?.send({ t: 'in', g: match.gen, k: from, ds: inputs[me].slice(from, N + 1), a: C.k });
  net.lastSent = performance.now();
}

// Step the confirmed state as far as both players' inputs are known, then re-predict
function advance() {
  while (!C.over && C.k < N && inputs[0][C.k + 1] !== undefined && inputs[1][C.k + 1] !== undefined) {
    stepState(C, [inputs[0][C.k + 1], inputs[1][C.k + 1]]);
  }
  if (C.k >= N || C.over) P = C;
  else {
    P = cloneState(C);
    while (P.k < N && !P.over) stepState(P, [inputs[0][P.k + 1], inputs[1][P.k + 1]]); // unknown opponent input = keep going straight
  }
  if (C.over && match.phase === 'run') endRound();
}

function endRound() {
  P = C;
  const w = C.alive[0] ? 0 : C.alive[1] ? 1 : -1;
  match.winner = w;
  if (w >= 0) match.sc[w]++;
  match.phase = 'end'; match.endT = 2.4;
  humOff();
  for (let i = 0; i < 2; i++) if (C.crash[i]) {
    const [x, y] = C.crash[i];
    burst(x + 0.5, y + 0.5, RGB[i], 70, 14, 1.0);
  }
  shake = 0.45; flash = 0.6; flashCol = w >= 0 ? RGB[w] : [255, 255, 255];
  sfx.crash();
  const good = mode === 'local' ? true : w === me;
  setTimeout(() => sfx.round(good), 350);
  buzz(w === me || mode === 'local' ? [30] : [60, 40, 80]);
  if (mode === 'local') match.msg = w < 0 ? 'DRAW' : w === 0 ? 'BOTTOM WINS ROUND' : 'TOP WINS ROUND';
  else match.msg = w < 0 ? 'DRAW' : w === me ? 'ROUND WON' : 'ROUND LOST';
}

function matchOver() { return match.sc[0] >= WIN_ROUNDS || match.sc[1] >= WIN_ROUNDS; }

// ---------- Networking ----------
function onData(m) {
  lastRecv = performance.now();
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'pi': link?.send({ t: 'po', ts: m.ts }); break;
    case 'po':
      if (m.ts > net.lastPo) {
        net.lastPo = m.ts;
        const s = performance.now() - m.ts;
        net.rtt = net.rtt ? net.rtt * 0.8 + s * 0.2 : s;
      }
      break;
    case 'in': {
      if (m.g !== match.gen || !C || !Array.isArray(m.ds)) break;
      const opp = 1 - me;
      let changed = false;
      for (let i = 0; i < m.ds.length; i++) {
        const k = m.k + i;
        if (inputs[opp][k] === undefined) { inputs[opp][k] = m.ds[i] | 0; changed = true; }
      }
      net.oppLatest = Math.max(net.oppLatest, m.k + m.ds.length - 1);
      if (typeof m.a === 'number') net.oppAck = Math.max(net.oppAck, m.a);
      if (changed && (match.phase === 'run')) advance();
      break;
    }
    case 'go':
      if (mode !== 'guest' || m.g <= match.gen) break;
      match.gen = m.g;
      match.sc = m.sc.slice();
      match.round = m.r - 1;
      startRound(Math.max(0.3, m.cd - oneWay()));
      show(null);
      break;
    case 'r':
      if (mode === 'host' && match.phase === 'over') hostNext(true);
      break;
  }
}

// Host decides when the next round (or a rematch) starts
function hostNext(rematch) {
  if (rematch) { match.sc = [0, 0]; match.round = 0; show(null); }
  match.gen++;
  startRound();
  net.goAt = performance.now(); net.lastGo = 0;
}
function sendGo() {
  link?.send({ t: 'go', g: match.gen, r: match.round, sc: match.sc, cd: Math.round(match.cd * 1000) / 1000 });
}

// ---------- Input ----------
const flip = () => mode === 'guest';
const swipes = new Map();
function playerFor(e) {
  if (mode === 'local') return e.clientY > view.h / 2 ? 0 : 1;
  return me;
}
canvas.addEventListener('pointerdown', (e) => {
  unlockAudio();
  if (!running) return;
  swipes.set(e.pointerId, { x: e.clientX, y: e.clientY, p: playerFor(e) });
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
});
canvas.addEventListener('pointermove', (e) => {
  const s = swipes.get(e.pointerId);
  if (!s) return;
  const dx = e.clientX - s.x, dy = e.clientY - s.y;
  const th = Math.max(16, view.cs * 1.6);
  if (Math.abs(dx) < th && Math.abs(dy) < th) return;
  let d = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
  if (flip()) d = (d + 2) % 4;
  queueTurn(s.p, d);
  s.x = e.clientX; s.y = e.clientY;
  e.preventDefault();
});
const endSwipe = (e) => swipes.delete(e.pointerId);
canvas.addEventListener('pointerup', endSwipe);
canvas.addEventListener('pointercancel', endSwipe);
document.addEventListener('touchmove', (e) => { if (running) e.preventDefault(); }, { passive: false });

const KEYS = { arrowup: 0, arrowright: 1, arrowdown: 2, arrowleft: 3, w: 0, d: 1, s: 2, a: 3 };
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'escape' || k === 'p') { togglePause(); return; }
  if (!running || !(k in KEYS)) return;
  let d = KEYS[k];
  const p = mode === 'local' ? (k.startsWith('arrow') ? 0 : 1) : me;
  if (flip()) d = (d + 2) % 4;
  queueTurn(p, d);
  e.preventDefault();
});

// ---------- Flow ----------
function startGame(m) {
  mode = m;
  me = mode === 'guest' ? 1 : 0;
  Object.assign(net, { rtt: 0, lastPo: 0, lastPing: 0, oppLatest: 0, goAt: 0, lastGo: 0 });
  match.gen = 0; match.sc = [0, 0]; match.round = 0;
  running = true; paused = false; netWait = false;
  lastRecv = performance.now();
  if (mode === 'guest') { C = P = newRoundState(); match.phase = 'wait'; match.msg = ''; }
  else if (mode === 'host') hostNext(true);
  else newMatch();
  show(null); hideToast();
  $('hud').classList.add('on');
  updateNetMode();
  requestWakeLock();
}

function updateNetMode() {
  const el = $('netMode');
  if (!link || !online()) { el.textContent = ''; return; }
  el.textContent = link.isDirect ? '⚡ Direct' : '☁ Relay';
}

function gameOver() {
  match.phase = 'over';
  const w = match.sc[0] >= WIN_ROUNDS ? 0 : 1;
  const title = mode === 'local' ? (w === 0 ? 'BOTTOM WINS' : 'TOP WINS') : (w === me ? 'YOU WIN' : 'YOU LOSE');
  $('overTitle').textContent = title;
  $('overTitle').style.color = COL[w];
  const a = mode === 'local' ? match.sc[0] : match.sc[me], b = mode === 'local' ? match.sc[1] : match.sc[1 - me];
  $('overScore').textContent = `${a} – ${b}`;
  $('overMsg').textContent = mode === 'guest' ? 'Tap Rematch to play again.' : '';
  $('btnRematch').disabled = false;
  (mode === 'local' || w === me) ? sfx.win() : sfx.lose();
  show('scrOver');
}

function toMenu() {
  running = false; paused = false; netWait = false;
  humOff();
  if (link) { link.destroy(); link = null; }
  mode = null; C = P = null; match.phase = 'idle';
  $('hud').classList.remove('on');
  hideToast(); releaseWakeLock();
  show('scrMenu');
  history.replaceState(null, '', location.pathname);
}

function togglePause() {
  if (!running) return;
  $('btnResume').textContent = online() ? 'Back to game' : 'Resume';
  if ($('scrPause').classList.contains('on')) { show(null); paused = false; }
  else if (!$('scrOver').classList.contains('on')) { show('scrPause'); paused = !online(); if (paused) humOff(); }
}

async function hostGame() {
  show('scrLobby');
  $('lobbyCode').textContent = '····';
  $('lobbyMsg').innerHTML = '<span class="dots">Setting up</span>';
  $('btnShare').disabled = true;
  link = new Link('cycles');
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
    show('scrMenu'); menuMsg(describeError(e), true);
  }
}

async function joinGame(raw) {
  const code = cleanCode(raw);
  if (code.length !== 4) { menuMsg('Enter the 4-letter code from the host.', true); return; }
  show('scrJoin');
  $('joinTitle').textContent = `JOINING ${code}`;
  link = new Link('cycles');
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
    show('scrMenu'); menuMsg(describeError(e), true);
  }
}

function onPeerClose() {
  if (!running) return;
  running = false; humOff();
  $('hud').classList.remove('on');
  $('overTitle').textContent = 'DISCONNECTED';
  $('overTitle').style.color = '';
  $('overScore').textContent = `${match.sc[me]} – ${match.sc[1 - me]}`;
  $('overMsg').textContent = 'The other player left the game.';
  $('btnRematch').disabled = true;
  show('scrOver');
  if (link) { link.destroy(); link = null; }
}

function menuMsg(t, err) { const m = $('menuMsg'); m.textContent = t || ''; m.classList.toggle('err', !!err); }

async function shareInvite() {
  const url = `${location.origin}${location.pathname}?join=${link?.code}`;
  const text = `Race me in Light Cycles! Code ${link?.code}`;
  try { if (navigator.share) { await navigator.share({ title: 'Light Cycles', text, url }); return; } }
  catch (e) { if (e?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  catch { toast(url, 5000); }
}

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
    else if (mode === 'host') hostNext(true);
    else { show(null); newMatch(); }
  }
});
$('btnPause').addEventListener('click', togglePause);
$('btnMute').addEventListener('click', () => {
  muted = !muted; updateMuteBtn(); unlockAudio();
  if (muted) humOff(); else if (match.phase === 'run') humOn();
  try { localStorage.setItem('arcade.muted', muted ? '1' : '0'); } catch {}
});
$('joinCode').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value); });
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame(e.target.value); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running && !online() && !paused && match.phase !== 'over') togglePause();
  if (!document.hidden && running) requestWakeLock();
});

let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
}
function releaseWakeLock() { try { wakeLock?.release(); } catch {} wakeLock = null; }

// ---------- Main loop ----------
function update(dt, now) {
  const on = online();
  netWait = on && now - lastRecv > 2000;

  if (on) {
    if (now - net.lastPing > 1000) { link?.send({ t: 'pi', ts: now }); net.lastPing = now; }
    if (mode === 'host' && now - net.goAt < 1500 && now - net.lastGo > 250) { sendGo(); net.lastGo = now; }
    // keep-alive + resend recent inputs (covers lost packets)
    if (now - net.lastSent > 100) { if (match.phase === 'run') sendInputs(); else { link?.send({ t: 'ka' }); net.lastSent = now; } }
  }
  if (paused || netWait) return;

  if (match.phase === 'count') {
    match.cd -= dt;
    const c = Math.ceil(match.cd);
    if (c < match.lastBeep && c >= 1) { match.lastBeep = c; sfx.beep(false); }
    if (match.cd <= 0) { match.phase = 'run'; sfx.beep(true); humOn(); }
  } else if (match.phase === 'run') {
    let rate = 1;
    if (on) {
      const ahead = N - (net.oppLatest + oneWay() / TICK);
      rate = ahead > 1.5 ? 0.88 : ahead < -1.5 ? 1.12 : 1;
    }
    tickAcc += dt * rate;
    while (tickAcc >= TICK && match.phase === 'run') {
      if (on && N - C.k >= MAX_AHEAD) { tickAcc = TICK; break; } // too far ahead of the other phone: wait
      tickAcc -= TICK;
      doTick();
    }
    if (hum && ac) hum.o.frequency.value = 55 + Math.min(N, 600) * 0.02;
  } else if (match.phase === 'end') {
    match.endT -= dt;
    if (match.endT <= 0) {
      if (matchOver()) gameOver();
      else if (mode === 'host') hostNext(false);
      else if (mode === 'guest') match.phase = 'between'; // waiting for host's "go"
      else startRound();
    }
  }

  if (netWait && match.phase !== 'over') toast('Waiting for the other player…', 0);
  else if (!netWait && $('toast').textContent.startsWith('Waiting')) hideToast();
}

let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  if (running && C) update(dt, now);
  if (netWait && online()) {
    // still show the toast even while paused for the network
    if (match.phase !== 'over') toast('Waiting for the other player…', 0);
  }
  render(dt, now);
}

// ---------- Effects ----------
const parts = [];
let shake = 0, flash = 0, flashCol = [255, 255, 255];
function burst(x, y, rgb, n, speed, life) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, v = speed * (0.2 + Math.random());
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: life * (0.5 + Math.random() * 0.5), max: life, rgb, r: 0.12 + Math.random() * 0.2 });
  }
}

// ---------- Rendering ----------
function render(dt, now) {
  const { cs, ox, oy, dpr, w, h } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#05040c';
  ctx.fillRect(0, 0, w, h);

  shake = Math.max(0, shake - dt);
  flash = Math.max(0, flash - dt * 1.5);
  const sh = shake * shake * cs * 2.2;
  const sx = (Math.random() * 2 - 1) * sh, sy = (Math.random() * 2 - 1) * sh;

  const st = P || demoState(now);

  ctx.save();
  ctx.translate(ox + sx, oy + sy);
  ctx.scale(cs, cs);
  if (flip()) { ctx.translate(GW, GH); ctx.rotate(Math.PI); }

  // floor
  const g = ctx.createLinearGradient(0, 0, 0, GH);
  g.addColorStop(0, 'rgba(255,138,31,0.06)');
  g.addColorStop(0.5, 'rgba(20,14,50,0.3)');
  g.addColorStop(1, 'rgba(46,246,255,0.06)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, GW, GH);
  if (flash > 0) { ctx.fillStyle = `rgba(${flashCol[0]},${flashCol[1]},${flashCol[2]},${flash * 0.15})`; ctx.fillRect(0, 0, GW, GH); }

  ctx.lineWidth = 0.04;
  ctx.strokeStyle = 'rgba(140,150,255,0.08)';
  ctx.beginPath();
  for (let x = 1; x < GW; x++) { ctx.moveTo(x, 0); ctx.lineTo(x, GH); }
  for (let y = 1; y < GH; y++) { ctx.moveTo(0, y); ctx.lineTo(GW, y); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(140,150,255,0.16)';
  ctx.beginPath();
  for (let x = 5; x < GW; x += 5) { ctx.moveTo(x, 0); ctx.lineTo(x, GH); }
  for (let y = 5; y < GH; y += 5) { ctx.moveTo(0, y); ctx.lineTo(GW, y); }
  ctx.stroke();

  // arena wall
  ctx.lineWidth = 0.25;
  ctx.strokeStyle = 'rgba(170,180,255,0.6)';
  ctx.shadowColor = '#8c9cff'; ctx.shadowBlur = 12 * dpr;
  ctx.strokeRect(0, 0, GW, GH);
  ctx.shadowBlur = 0;

  // trails
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const frac = match.phase === 'run' ? clamp(tickAcc / TICK, 0, 1) : 0;
  for (let i = 0; i < 2; i++) {
    const path = st.path[i];
    if (!path.length) continue;
    const pts = [];
    for (const c of path) pts.push([(c % GW) + 0.5, ((c / GW) | 0) + 0.5]);
    let hx = pts[pts.length - 1][0], hy = pts[pts.length - 1][1];
    if (st.alive[i] && running && match.phase === 'run') {
      hx += DX[st.d[i]] * frac; hy += DY[st.d[i]] * frac;
      pts.push([hx, hy]);
    }
    const [r, gg, b] = RGB[i];
    const layers = [[1.1, `rgba(${r},${gg},${b},0.16)`], [0.55, `rgba(${r},${gg},${b},0.55)`], [0.18, 'rgba(255,255,255,0.85)']];
    for (const [lw, col] of layers) {
      ctx.lineWidth = lw; ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j][0], pts[j][1]);
      ctx.stroke();
    }
    // head
    if (st.alive[i]) {
      ctx.shadowColor = COL[i]; ctx.shadowBlur = 18 * dpr;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(hx, hy, 0.42, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // particles
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.life -= dt;
    if (p.life <= 0) { parts.splice(i, 1); continue; }
    p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 1 - dt * 2.2; p.vy *= 1 - dt * 2.2;
    const a = p.life / p.max;
    ctx.fillStyle = `rgba(${p.rgb[0]},${p.rgb[1]},${p.rgb[2]},${a})`;
    ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
  }
  ctx.restore();

  if (running && C) drawOverlay(now);
}

function drawOverlay(now) {
  const { cs, ox, oy, dpr, w } = view;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const cx = w / 2, cy = oy + (GH / 2) * cs;

  // round pips: mine (or bottom) under the arena, theirs above
  const bottom = flip() ? 1 : 0, top = 1 - bottom;
  const pip = (pl, y) => {
    for (let i = 0; i < WIN_ROUNDS; i++) {
      const x = cx + (i - (WIN_ROUNDS - 1) / 2) * 22;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, 7);
      if (i < match.sc[pl]) { ctx.fillStyle = COL[pl]; ctx.shadowColor = COL[pl]; ctx.shadowBlur = 10 * dpr; ctx.fill(); ctx.shadowBlur = 0; }
      else { ctx.strokeStyle = 'rgba(200,200,255,0.35)'; ctx.lineWidth = 1.5; ctx.stroke(); }
    }
  };
  pip(bottom, oy + GH * cs + 16);
  pip(top, oy - 16);

  const big = Math.round(cs * 5);
  if (match.phase === 'count') {
    const n = Math.ceil(match.cd);
    const t = match.cd - Math.floor(match.cd);
    ctx.font = `900 ${Math.round(big * (1 + t * 0.4))}px system-ui, sans-serif`;
    ctx.fillStyle = `rgba(238,241,255,${0.35 + t * 0.6})`;
    ctx.fillText(String(n), cx, cy);
    ctx.font = `800 ${Math.round(cs * 1.4)}px Orbitron, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(238,241,255,0.8)';
    ctx.fillText(`ROUND ${match.round}`, cx, cy - big * 0.95);
    if (match.round === 1) {
      ctx.font = `600 ${Math.round(cs * 1.1)}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(238,241,255,0.6)';
      ctx.fillText(mode === 'local' ? 'SWIPE IN YOUR HALF TO TURN' : 'SWIPE TO TURN', cx, cy + big * 0.95);
    }
  } else if (match.phase === 'end' || match.phase === 'between') {
    ctx.font = `800 ${Math.round(cs * 2)}px Orbitron, system-ui, sans-serif`;
    const w0 = match.winner;
    ctx.fillStyle = w0 >= 0 ? COL[w0] : '#eef1ff';
    ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 16 * dpr;
    ctx.fillText(match.msg, cx, cy);
    ctx.shadowBlur = 0;
  } else if (match.phase === 'wait') {
    ctx.font = `600 ${Math.round(cs * 1.3)}px system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(238,241,255,0.7)';
    ctx.fillText('Get ready…', cx, cy);
  }
  ctx.restore();
}

// Attract mode behind the menu: two CPU cycles
let demo = null, demoAcc = 0, demoT = 0;
function demoState(now) {
  const dt = Math.min((now - (demoT || now)) / 1000, 0.05); demoT = now;
  if (!demo || demo.over && (demoAcc += dt) > 1.2) { demo = newRoundState(); demoAcc = 0; }
  if (!demo.over) {
    demo._acc = (demo._acc || 0) + dt;
    while (demo._acc >= TICK * 1.4 && !demo.over) {
      demo._acc -= TICK * 1.4;
      const mirror = { ...demo, x: [demo.x[1], demo.x[0]], y: [demo.y[1], demo.y[0]], d: [demo.d[1], demo.d[0]], alive: [demo.alive[1], demo.alive[0]] };
      stepState(demo, [cpuDir(mirror), cpuDir(demo)]);
    }
  }
  return demo;
}

requestAnimationFrame(frame);

// Auto-join from invite link (?join=CODE)
const qJoin = cleanCode(new URLSearchParams(location.search).get('join'));
if (qJoin.length === 4) { $('joinCode').value = qJoin; joinGame(qJoin); }

// Debug/test hook (read-only)
window.__cycles = { get C() { return C; }, get P() { return P; }, get N() { return N; }, get match() { return match; }, get net() { return net; }, get mode() { return mode; } };
