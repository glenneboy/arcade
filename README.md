# Neon Arcade

Modern-ish remakes of classic arcade games. They run in a mobile browser, and two players can play on separate phones.

## Games
- **Pong** (`/pong/`): play against the CPU, two players on one device, or phone vs phone online.

## Online 2-player
Phones connect in two ways at once:
1. **Relay**: both phones connect to free public MQTT brokers (EMQX and HiveMQ) over secure WebSockets. This works on any network, including mobile data.
2. **Direct**: the phones also try a WebRTC peer-to-peer link through PeerJS. If it opens, traffic switches to it for lower lag. If it drops, traffic falls back to the relay.

The in-game HUD shows which link is in use: ⚡ Direct or ☁ Relay.
One phone taps **Host** and gets a 4-letter code. The other phone types the code, or opens the shared invite link.

## Structure
- `shared/net.js`: the 2-player link that every game reuses
- `lib/`: PeerJS 1.5.4 and MQTT.js 5.16.1, included in the repo
- `<game>/`: one folder per game

## Run locally
`python3 -m http.server` then open http://localhost:8000
