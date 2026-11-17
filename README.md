# Neon Arcade

Modern-ish remakes of classic arcade games. They run in a mobile browser, and two players can play on separate phones.

## Games
- **Pong** (`/pong/`): play against the CPU, two players on one device, or phone vs phone online.

## Online 2-player
The phones connect directly to each other over WebRTC. Browsers can't do phone-to-phone Bluetooth: iOS has no Web Bluetooth, and no browser can act as a Bluetooth peripheral.
A free public PeerJS broker (0.peerjs.com) is used only for the initial handshake.
One phone taps **Host** and gets a 4-letter code. The other phone types the code, or opens the shared invite link.

## Structure
- `shared/net.js`: the 2-player link that every game reuses
- `lib/peerjs.min.js`: PeerJS 1.5.4 (MIT), included in the repo
- `<game>/`: one folder per game

## Run locally
`python3 -m http.server` then open http://localhost:8000
