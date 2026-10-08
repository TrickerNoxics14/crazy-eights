/*
 * The host's side of an online room. There is no game server: the host's browser runs this. It keeps
 * the game, plays the computer seats, and sends each guest only what that guest is allowed to see.
 *
 * A "connection" is anything with send(message) and an `open` flag: a PeerJS connection in the browser,
 * or a stand-in in the tests. Messages are plain JSON objects with a `t` field:
 *   guest -> host:  {t:'join', name} | {t:'resume', token} | {t:'action', action} | {t:'leave'}
 *                   | {t:'ping', at} | {t:'pong', at}
 *   host -> guest:  {t:'joined', code, token, seat} | {t:'state', view} | {t:'error', error} | {t:'gone', reason}
 *                   | {t:'ping', at} | {t:'pong', at}
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./core.js') : root.CrazyEights);
  if (isNode) module.exports = api;
  else root.CrazyEightsRoom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  const MAX_SEATS = 4;
  // A closed browser tab does not always tell its connection, so silence is treated as a drop.
  const HEARTBEAT_TIMEOUT_MS = 12000;
  // How long a dropped player's turn waits before the computer plays it for them.
  const AWAY_AFTER_MS = 15000;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function randomBytes(n) {
    const buf = new Uint8Array(n);
    const source = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : require('crypto').webcrypto;
    source.getRandomValues(buf);
    return buf;
  }

  // Tokens are a guest's proof of their seat, so they must be unguessable.
  const newToken = () => Array.from(randomBytes(16), b => b.toString(16).padStart(2, '0')).join('');
  const randomCode = () => Array.from(randomBytes(4), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  const cleanName = (raw, fallback) =>
    String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 16) || fallback;
  const isOpen = conn => !!conn && conn.open !== false;

  class HostRoom {
    constructor({
      code = randomCode(), hostName, target = 100, botDelayMs = 900, awayMs = AWAY_AFTER_MS,
      onView = () => {}, onChange = () => {},
    } = {}) {
      this.code = code;
      this.target = target;
      this.locked = false;      // when locked, nobody new can join the lobby
      this.game = null;
      this.botDelayMs = botDelayMs;
      this.awayMs = awayMs;
      this.botTimer = null;
      this.closed = false;
      this.onView = onView;     // called with the host's own view after every change
      this.onChange = onChange; // called after every change (e.g. to save a copy for a page reload)
      // Seat 0 is the host, who plays from this browser, so it has no connection.
      this.seats = [{ name: cleanName(hostName, 'Player 1'), type: 'human', token: newToken(), conn: null, host: true }];
    }

    // ---------- connections ----------

    handleMessage(conn, msg) {
      if (this.closed || !msg || typeof msg !== 'object') return;
      if (msg.t === 'join') return this.join(conn, msg.name);
      if (msg.t === 'resume') return this.resume(conn, msg.token);
      const idx = this.seats.findIndex(s => s.conn === conn);
      if (idx < 0) return this.send(conn, { t: 'gone', reason: 'You are not in this room any more.' });
      const seat = this.seats[idx];
      seat.seen = Date.now();
      if (msg.t === 'ping') return this.send(conn, { t: 'pong', at: msg.at });
      if (msg.t === 'pong') {
        if (Number.isFinite(msg.at)) seat.ping = Math.max(0, Date.now() - msg.at);
        return;
      }
      if (msg.t === 'action') {
        const result = this.act(idx, msg.action || {});
        if (!result.ok) this.send(conn, { t: 'error', error: result.error });
      } else if (msg.t === 'leave') {
        const result = this.act(idx, { type: 'leave' });
        if (!result.ok) this.send(conn, { t: 'error', error: result.error });
      }
    }

    join(conn, name) {
      if (this.seats.some(s => s.conn === conn)) return;
      if (this.game) return this.send(conn, { t: 'error', error: 'That game has already started.' });
      if (this.locked) return this.send(conn, { t: 'error', error: 'The host has locked the room.' });
      if (this.seats.length >= MAX_SEATS) return this.send(conn, { t: 'error', error: 'That room is full.' });
      const seat = { name: cleanName(name, `Player ${this.seats.length + 1}`), type: 'human', token: newToken(), conn, seen: Date.now() };
      this.seats.push(seat);
      this.send(conn, { t: 'joined', code: this.code, token: seat.token, seat: this.seats.length - 1 });
      this.changed();
    }

    // A guest who lost their connection comes back with the token they were given when they joined.
    resume(conn, token) {
      const seat = this.seats.find(s => !s.host && s.token && s.token === token);
      if (!seat) return this.send(conn, { t: 'gone', reason: 'Your seat in this room is no longer available.' });
      if (seat.conn && seat.conn !== conn) {
        // (keep: the seat is still ours, just in another window, so the old window should not forget it)
        this.send(seat.conn, { t: 'gone', reason: 'This seat was opened in another window.', keep: true });
      }
      seat.conn = conn;
      seat.seen = Date.now();
      seat.offlineSince = null;
      this.send(conn, { t: 'joined', code: this.code, token: seat.token, seat: this.seats.indexOf(seat) });
      this.changed();
    }

    disconnected(conn) {
      const seat = this.seats.find(s => s.conn === conn);
      if (!seat) return;
      seat.conn = null;
      seat.ping = null;
      seat.offlineSince = Date.now();
      this.changed();
    }

    send(conn, msg) {
      if (!isOpen(conn)) return;
      try { conn.send(msg); } catch { /* the connection has just gone */ }
    }

    // Called every few seconds by the host's page. Pings the guests (to measure how fast they are) and
    // drops any guest who has gone silent.
    heartbeat(now = Date.now()) {
      if (this.closed) return;
      for (const seat of this.seats) {
        if (!seat.conn) continue;
        if (now - (seat.seen || 0) > HEARTBEAT_TIMEOUT_MS) {
          const conn = seat.conn;
          this.disconnected(conn);
          try { if (conn.close) conn.close(); } catch { /* already gone */ }
        } else {
          this.send(seat.conn, { t: 'ping', at: Date.now() });
        }
      }
    }

    // Stops the room. Every guest is told why, so their browser can say so.
    close(reason = 'The host closed the room.') {
      this.closed = true;
      clearTimeout(this.botTimer);
      this.botTimer = null;
      for (const seat of this.seats) if (seat.conn) this.send(seat.conn, { t: 'gone', reason });
    }

    // ---------- what everyone is allowed to do ----------

    // Applies one player's action (seat index idx). Returns {ok: true} or {ok: false, error}.
    act(idx, body) {
      const seat = this.seats[idx];
      if (!seat) return { ok: false, error: 'You are not in this room.' };
      const isHost = idx === 0;
      const g = this.game;
      const fail = error => ({ ok: false, error });
      const needHost = () => (isHost ? null : fail('Only the host can do that.'));
      const needLobby = () => (g ? fail('The game has already started.') : null);
      const needGame = () => (g ? null : fail('No game is in progress.'));

      switch (body.type) {
        case 'addCpu': {
          const err = needHost() || needLobby();
          if (err) return err;
          if (this.seats.length >= MAX_SEATS) return fail('The room is full.');
          const computers = this.seats.filter(s => s.type === 'cpu').length;
          this.seats.push({ name: `CPU ${computers + 1}`, type: 'cpu', token: null, conn: null });
          break;
        }
        case 'removeSeat': {
          const err = needHost() || needLobby();
          if (err) return err;
          const target = Number(body.seat);
          if (!Number.isInteger(target) || target < 1 || target >= this.seats.length) return fail('Choose a seat to remove.');
          const [removed] = this.seats.splice(target, 1);
          this.send(removed.conn, { t: 'gone', reason: 'The host removed you from the room.' });
          break;
        }
        case 'setTarget': {
          const err = needHost() || needLobby();
          if (err) return err;
          if (!Core.TARGETS.includes(Number(body.target))) return fail('Pick a valid target score.');
          this.target = Number(body.target);
          break;
        }
        case 'lock': {
          const err = needHost();
          if (err) return err;
          this.locked = !!body.locked;
          break;
        }
        case 'start': {
          const err = needHost() || needLobby();
          if (err) return err;
          if (this.seats.length < 2) return fail('Add at least one more seat before starting.');
          this.game = Core.newMatch(this.seats, this.target);
          break;
        }
        case 'leave': {
          if (!g) {
            if (isHost) return fail('The host closes the room instead.');
            const [left] = this.seats.splice(idx, 1);
            this.send(left.conn, { t: 'gone', reason: 'You left the room.' });
            break;
          }
          return fail('You can only leave the lobby.');
        }
        case 'play':
        case 'draw':
        case 'pass': {
          const err = needGame();
          if (err) return err;
          const action = body.type === 'play' ? { type: 'play', cardId: body.cardId, suit: body.suit } : { type: body.type };
          const result = Core.applyAction(g, idx, action);
          if (!result.ok) return result;
          break;
        }
        case 'next': {
          const err = needGame();
          if (err) return err;
          if (g.phase === 'roundOver') Core.nextRound(g); // (if two players click at once, the second is a no-op)
          break;
        }
        case 'rematch': {
          const err = needGame();
          if (err) return err;
          if (g.phase === 'matchOver') Core.rematch(g);
          break;
        }
        case 'lobby': {
          const err = needGame();
          if (err) return err;
          if (g.phase !== 'matchOver') return fail('Finish the match first.');
          this.game = null;
          break;
        }
        case 'replace': {
          // Hands a seat to a computer for good (the away covering below is only a temporary stand-in).
          const err = needGame();
          if (err) return err;
          const target = this.seats[Number(body.seat)];
          if (!target || target.host || target.type !== 'human' || target.conn) return fail('That player is still connected.');
          target.type = 'cpu';
          target.token = null;
          target.offlineSince = null;
          target.name = `${target.name} (CPU)`;
          break;
        }
        default:
          return fail('Unknown action.');
      }
      this.changed();
      return { ok: true };
    }

    // ---------- views and broadcasts ----------

    isConnected(i) {
      const seat = this.seats[i];
      return seat.type === 'cpu' || !!seat.host || !!seat.conn;
    }

    // A player who has been gone for a while: the computer plays their turns until they come back.
    covering(seat, now = Date.now()) {
      return seat.type === 'human' && !seat.host && !seat.conn && seat.offlineSince != null
        && now - seat.offlineSince >= this.awayMs;
    }

    // Everything one seat is allowed to see. Other players' tokens and connections never leave the host.
    viewFor(idx) {
      const base = this.game
        ? Core.view(this.game, idx)
        : { phase: 'lobby', target: this.target, viewer: idx, seats: this.seats.map(s => ({ name: s.name, type: s.type })) };
      base.code = this.code;
      base.host = idx === 0;
      base.locked = this.locked;
      base.seats = base.seats.map((seat, i) => ({
        ...seat,
        connected: this.isConnected(i),
        away: this.covering(this.seats[i]),
        ping: this.seats[i].ping ?? null,
      }));
      return base;
    }

    changed() {
      if (this.closed) return;
      this.scheduleBot();
      for (let i = 1; i < this.seats.length; i++) {
        if (this.seats[i].conn) this.send(this.seats[i].conn, { t: 'state', view: this.viewFor(i) });
      }
      this.onView(this.viewFor(0));
      this.onChange(this);
    }

    // Computer seats play themselves, one step at a time, so people can follow along. So does a player
    // who has dropped out, once they have been away long enough.
    scheduleBot() {
      clearTimeout(this.botTimer);
      this.botTimer = null;
      const g = this.game;
      if (!g || this.closed || g.phase !== 'playing') return;
      const seat = g.seats[g.current];
      if (seat.type === 'cpu') {
        this.botTimer = setTimeout(() => this.botStep(), this.botDelayMs);
      } else if (!seat.host && !seat.conn && seat.offlineSince != null) {
        const wait = Math.max(10, seat.offlineSince + this.awayMs - Date.now());
        this.botTimer = setTimeout(() => this.botStep(), wait);
      }
    }

    botStep() {
      this.botTimer = null;
      const g = this.game;
      if (!g || this.closed || g.phase !== 'playing') return;
      const seat = g.seats[g.current];
      if (seat.type !== 'cpu' && !this.covering(seat)) return this.scheduleBot();
      Core.applyAction(g, g.current, Core.cpuAction(g, g.current));
      this.changed();
    }

    // Re-sends the current view to the host's own screen (used after the host's page is set up).
    refresh() {
      this.changed();
    }

    // ---------- saving the room, so a reloaded host page can reopen it ----------

    // Everything needed to rebuild the room. Connections are not saved: guests reconnect with their tokens.
    snapshot() {
      return {
        code: this.code,
        target: this.target,
        locked: this.locked,
        seats: this.seats.map(s => ({
          name: s.name, type: s.type, token: s.token, host: !!s.host,
          offlineSince: s.offlineSince ?? null, hand: s.hand, score: s.score,
        })),
        game: this.game && { ...this.game, seats: undefined },
      };
    }

    static restore(snap, opts = {}) {
      const room = new HostRoom({ ...opts, code: snap.code, hostName: snap.seats[0].name, target: snap.target });
      room.locked = !!snap.locked;
      room.seats = snap.seats.map((s, i) => ({
        ...s,
        host: i === 0,
        conn: null,
        // Nobody is connected yet. Each guest who was in the room is away from now, until they rejoin.
        offlineSince: i === 0 || s.type === 'cpu' ? null : (s.offlineSince ?? Date.now()),
      }));
      room.game = snap.game ? { ...snap.game, seats: room.seats } : null;
      return room; // (the computer players start once the room is open: see refresh())
    }
  }

  return { HostRoom, MAX_SEATS, HEARTBEAT_TIMEOUT_MS, AWAY_AFTER_MS, randomCode };
});
