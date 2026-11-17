// Shared 2-player link for every arcade game.
// Uses WebRTC data channels (via PeerJS, vendored in /lib) for a direct
// device-to-device connection. A public PeerJS broker is only used to
// exchange the initial handshake; game traffic flows peer-to-peer.
//
// Usage:
//   const link = new Link('pong');
//   const code = await link.host();      // show code to the other player
//   await link.join('ABCD');             // on the other device
//   link.on('connect', () => ...).on('data', msg => ...).on('close', () => ...);
//   link.send({ any: 'json' });

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L confusion
const PREFIX = 'ogarcade-v1-';

// Optional self-hosted broker for testing: ?peerhost=localhost:9000
function peerOptions() {
  const o = { debug: 0 };
  const ph = new URLSearchParams(location.search).get('peerhost');
  if (ph) {
    const [host, port] = ph.split(':');
    Object.assign(o, { host, port: Number(port) || 443, path: '/', secure: location.protocol === 'https:' && host !== 'localhost' });
  }
  return o;
}

export function makeCode(len = 4) {
  let s = '';
  const r = crypto.getRandomValues(new Uint32Array(len));
  for (let i = 0; i < len; i++) s += ALPHABET[r[i] % ALPHABET.length];
  return s;
}

export function cleanCode(raw) {
  return (raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

export class Link {
  constructor(game) {
    this.game = game;
    this.peer = null;
    this.conn = null;
    this.code = null;
    this.isHost = false;
    this.handlers = {};
  }

  on(ev, fn) { this.handlers[ev] = fn; return this; }
  emit(ev, ...args) { this.handlers[ev]?.(...args); }

  get connected() { return !!(this.conn && this.conn.open); }

  id(code) { return `${PREFIX}${this.game}-${code}`; }

  host() {
    this.isHost = true;
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const code = makeCode();
        const peer = new window.Peer(this.id(code), peerOptions());
        let opened = false;
        peer.on('open', () => {
          opened = true;
          this.peer = peer;
          this.code = code;
          resolve(code);
        });
        peer.on('connection', (c) => {
          if (this.connected) { c.on('open', () => c.close()); return; }
          this._bind(c);
        });
        peer.on('disconnected', () => {
          // Lost the broker (not the opponent). Reconnect so new joins still work.
          if (!peer.destroyed) try { peer.reconnect(); } catch {}
        });
        peer.on('error', (e) => {
          if (!opened) {
            peer.destroy();
            if (e.type === 'unavailable-id' && n < 6) attempt(n + 1);
            else reject(e);
          } else {
            this.emit('error', e);
          }
        });
      };
      attempt(0);
    });
  }

  join(code) {
    this.isHost = false;
    this.code = cleanCode(code);
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(peerOptions());
      this.peer = peer;
      let done = false;
      const fail = (e) => { if (!done) { done = true; reject(e); } };
      const timer = setTimeout(() => fail({ type: 'timeout' }), 15000);
      peer.on('open', () => {
        const c = peer.connect(this.id(this.code), { reliable: false, serialization: 'json' });
        this._bind(c, () => { done = true; clearTimeout(timer); resolve(); });
      });
      peer.on('error', (e) => { clearTimeout(timer); fail(e); if (done) this.emit('error', e); });
    });
  }

  _bind(c, onOpen) {
    this.conn = c;
    c.on('open', () => { onOpen?.(); this.emit('connect'); });
    c.on('data', (d) => this.emit('data', d));
    c.on('close', () => { if (this.conn === c) { this.conn = null; this.emit('close'); } });
    c.on('error', (e) => this.emit('error', e));
  }

  send(msg) {
    if (this.connected) try { this.conn.send(msg); } catch {}
  }

  destroy() {
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.conn = null;
    this.peer = null;
  }
}

export function describeError(e) {
  switch (e?.type) {
    case 'peer-unavailable': return 'No game found with that code.';
    case 'timeout': return 'Couldn’t reach that game. Check the code and try again.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed': return 'Can’t reach the matchmaking server. Check your connection.';
    case 'browser-incompatible': return 'This browser doesn’t support online play.';
    default: return 'Connection failed. Try again.';
  }
}
