# Crazy Eights

A Crazy Eights card game. Play on one device, or online with friends from your own devices. There is no game server to run.

## Play online

1. Open the game and choose **Play online with friends**, then **Create a room**.
2. Click **Copy invite link** and send it to your friends.
3. Friends open the link, type their name, and click **Join room**. The room code is already filled in.
4. You're the host. Add computer players if you like, pick the target score, and click **Start game**.

Things to know:
- **The host's tab runs the game**, so keep it open. Reloading it is fine: the menu then offers **Reopen your room XXXX**, and the game carries on. Guests get their seats back automatically.
- **Dropped out?** Reopen the game and click **Rejoin room XXXX**. Your seat and cards are kept.
- **No one holds up the table:** if a player is gone for about 15 seconds, the computer plays their turns until they come back.
- The host can **lock the room** in the lobby so nobody new can join, even with the code.
- Each seat shows its connection speed (green is fast, yellow is OK, red is slow).
- Joining retries automatically if the connection is slow, and you can press **Cancel** while it tries.
- Players connect straight to each other's browsers (WebRTC). The matchmaking that introduces them uses PeerJS's free public service, the same one as the other games. Strict networks (some VPNs and school Wi-Fi) can block the connection.

**▶ Play in the browser: https://trickernoxics14.github.io/crazy-eights/**

## Playing from the HTML file

You don't need a website to play online. Double-click `index.html` to open it in Chrome or Edge, then use **Play online with friends** as above.

The invite link only works on your computer, so when the game is opened from a file, the lobby shows the room code instead. Friends need their own copy of the game: send them `index.html`, `core.js` and `room.js`. They open it, choose **Play online with friends**, and type the code.

## Put the game online for everyone

Upload these three files to any static host (GitHub Pages, Netlify, or similar):

- `index.html`
- `core.js`
- `room.js`

Then share the link. Nothing else is needed: no Node.js, no server, no install.

## Play on one device

Open `index.html` and choose **Play on this device**. Pass the screen around for human players; computer seats fill the rest.

## Tests

Needs Node.js 18 or newer:

```bash
npm test
```

The tests check the card rules, a full computer-only match, and a host with two guests playing a complete match through the room logic.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The game page (local and online). |
| `core.js` | The card rules, shared by the browser and the tests. |
| `room.js` | The host's side of an online room. |
| `test/` | Automated tests. |
