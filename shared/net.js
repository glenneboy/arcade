// Shared 2-player link for every arcade game.
//
// How it connects:
//   1. RELAY: both phones connect to free public MQTT brokers over secure
//      WebSockets. This works on any network (4G/5G, hotel Wi-Fi...), because
//      it's ordinary outbound HTTPS-style traffic. Two brokers are used at once
//      for redundancy.
//   2. DIRECT: in the background the phones also try a WebRTC peer-to-peer link
//      (via PeerJS). If it opens, traffic switches to it for lower latency.
//      If it drops, traffic falls back to the relay automatically.
//
// Usage:
//   const link = new Link('pong');
//   const code = await link.host();      // show code to the other player
//   await link.join('ABCD');             // on the other device
//   link.on('connect', ...).on('data', msg => ...).on('close', ...);
//   link.send({ any: 'json' });
//   link.isDirect                        // true when on the fast P2P path

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L confusion
const PREFIX = 'ogarcade-v1-';
const BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];
const TIMEOUT_MS = 10000; // no traffic for this long = opponent gone

export function makeCode(len = 4) {
  let s = '';
  const r = crypto.getRandomValues(new Uint32Array(len));
  for (let i = 0; i < len; i++) s += ALPHABET[r[i] % ALPHABET.length];
  return s;
}

export function cleanCode(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

const params = new URLSearchParams(location.search);

// Testing overrides: ?peerhost=localhost:9000  ?mqtt=ws://localhost:8888
function peerOptions() {
  const o = { debug: 0 };
  const ph = params.get('peerhost');
  if (ph) {
    const [host, port] = ph.split(':');
    Object.assign(o, { host, port: Number(port) || 443, path: '/', secure: location.protocol === 'https:' && host !== 'localhost' });
  }
  return o;
}
function brokerUrls() {
  const m = params.get('mqtt');
  return m ? m.split(',') : BROKERS;
}

export class Link {
  constructor(game) {
    this.game = game;
    this.me = makeCode(8);
    this.code = null;
    this.isHost = false;
    this.partner = null;      // the other player's id
    this.connected = false;
    this.relays = [];
    this.peer = null;
    this.direct = null;       // open PeerJS DataConnection, if any
    this.handlers = {};
    this.lastIn = 0;
    this.timers = [];
  }

  on(ev, fn) { this.handlers[ev] = fn; return this; }
  emit(ev, ...args) { this.handlers[ev]?.(...args); }
  get isDirect() { return !!(this.direct && this.direct.open); }

  peerId(code) { return `${PREFIX}${this.game}-${code}`; }
  topic(side) { return `ogarcade/v1/${this.game}/${this.code}/${side}`; }

  // ----- Relay (MQTT) -----
  _startRelays(listenSide) {
    if (!window.mqtt) return;
    const sub = this.topic(listenSide);
    for (const url of brokerUrls()) {
      try {
        const c = window.mqtt.connect(url, {
          clientId: 'oga_' + makeCode(10),
          clean: true, keepalive: 30, connectTimeout: 8000, reconnectPeriod: 2000,
        });
        c.on('connect', () => { c.subscribe(sub, { qos: 0 }); this.emit('_relayup'); });
        c.on('message', (_t, payload) => {
          let m; try { m = JSON.parse(payload.toString()); } catch { return; }
          this._onRelay(m);
        });
        c.on('error', () => {});
        this.relays.push(c);
      } catch {}
    }
  }
  get relayReady() { return this.relays.some((c) => c.connected); }

  _pub(obj) {
    const t = this.topic(this.isHost ? 'g' : 'h');
    const s = JSON.stringify({ f: this.me, ...obj });
    for (const c of this.relays) if (c.connected) try { c.publish(t, s, { qos: 0 }); } catch {}
  }

  _onRelay(m) {
    if (!m || m.f === this.me) return;
    if (this.isHost) {
      if (m.c === 'hello') {
        if (!this.partner || this.partner === m.f) {
          const first = !this.partner;
          this.partner = m.f;
          this._pub({ c: 'welcome', to: m.f });
          if (first) this._up();
        } else {
          this._pub({ c: 'busy', to: m.f });
        }
        return;
      }
    } else {
      if (m.to && m.to !== this.me) return;
      if (m.c === 'welcome' && !this.partner) { this.partner = m.f; this._joined?.(); return; }
      if (m.c === 'busy' && !this.partner) { this._joinFail?.({ type: 'busy' }); return; }
    }
    if (m.f !== this.partner) return;
    this.lastIn = performance.now();
    if (m.c === 'bye') { this._down(); return; }
    if ('d' in m && !this.isDirect) this.emit('data', m.d);
  }

  // ----- Direct (WebRTC via PeerJS) -----
  _useDirect(c) {
    c.on('data', (d) => { this.lastIn = performance.now(); this.emit('data', d); });
    c.on('close', () => { if (this.direct === c) { this.direct = null; this.emit('mode'); } });
    c.on('error', () => {});
    this.direct = c;
    this.emit('mode');
  }

  _startPeerHost() {
    if (!window.Peer) return;
    try {
      const peer = new window.Peer(this.peerId(this.code), peerOptions());
      this.peer = peer;
      peer.on('connection', (c) => {
        c.on('open', () => {
          if (this.isDirect || (c.metadata?.from && c.metadata.from !== this.partner)) { c.close(); return; }
          this._useDirect(c);
        });
      });
      let opened = false, retries = 0;
      peer.on('open', () => { opened = true; retries = 0; });
      peer.on('disconnected', () => {
        if (opened && !peer.destroyed && retries++ < 5) setTimeout(() => { try { peer.reconnect(); } catch {} }, 1000 * retries);
      });
      peer.on('error', () => { if (!opened) try { peer.destroy(); } catch {} }); // direct path is optional; relay still works
    } catch {}
  }

  _startPeerGuest() {
    if (!window.Peer) return;
    try {
      const peer = new window.Peer(peerOptions());
      this.peer = peer;
      peer.on('open', () => {
        const c = peer.connect(this.peerId(this.code), { reliable: false, serialization: 'json', metadata: { from: this.me } });
        c.on('open', () => this._useDirect(c));
      });
      peer.on('error', () => { if (!peer.open) try { peer.destroy(); } catch {} });
    } catch {}
  }

  // ----- Lifecycle -----
  host() {
    this.isHost = true;
    this.code = makeCode();
    this._startRelays('h');
    this._startPeerHost();
    return new Promise((resolve, reject) => {
      if (!window.mqtt) { reject({ type: 'browser-incompatible' }); return; }
      const t = setTimeout(() => { if (!this.relayReady) reject({ type: 'network' }); }, TIMEOUT_MS);
      this.on('_relayup', () => { clearTimeout(t); this.on('_relayup', null); resolve(this.code); });
    });
  }

  join(code) {
    this.isHost = false;
    this.code = cleanCode(code);
    this._startRelays('g');
    return new Promise((resolve, reject) => {
      if (!window.mqtt) { reject({ type: 'browser-incompatible' }); return; }
      let done = false;
      const finish = () => { done = true; clearInterval(hello); clearTimeout(t); this._joined = this._joinFail = null; };
      const hello = setInterval(() => this._pub({ c: 'hello' }), 600);
      const t = setTimeout(() => {
        if (done) return; finish();
        reject({ type: this.relayReady ? 'peer-unavailable' : 'network' });
      }, 12000);
      this._joinFail = (e) => { if (!done) { finish(); reject(e); } };
      this._joined = () => {
        if (done) return; finish();
        this._up();
        this._startPeerGuest();
        resolve();
      };
    });
  }

  _up() {
    this.connected = true;
    this.lastIn = performance.now();
    this.timers.push(setInterval(() => {
      if (!this.connected) return;
      if (performance.now() - this.lastIn > TIMEOUT_MS) this._down();
      else if (this.isDirect) this._pub({ c: 'ping' }); // keep relay path warm as a fallback
    }, 2000));
    this.emit('connect');
  }

  _down() {
    if (!this.connected) return;
    this.connected = false;
    this.emit('close');
  }

  send(d) {
    if (!this.connected) return;
    if (this.isDirect) { try { this.direct.send(d); return; } catch {} }
    this._pub({ d });
  }

  destroy() {
    if (this.connected) this._pub({ c: 'bye' });
    this.connected = false;
    this.handlers = {};
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const relays = this.relays; this.relays = [];
    setTimeout(() => relays.forEach((c) => { try { c.end(true); } catch {} }), 300);
    try { this.direct?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.direct = null; this.peer = null;
  }
}

export function describeError(e) {
  switch (e?.type) {
    case 'peer-unavailable': return 'No game found with that code. Is the host still on the code screen?';
    case 'busy': return 'That game already has two players.';
    case 'network': return 'Can’t reach the game servers. Check your internet connection.';
    case 'browser-incompatible': return 'This browser doesn’t support online play.';
    default: return 'Connection failed. Try again.';
  }
}
