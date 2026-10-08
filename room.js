/*
 * The host's side of an online room. There is no game server: the host's browser runs this. It keeps
 * the game, plays the computer seats, and sends each guest only what that guest is allowed to see.
 *
 * A "connection" is anything with send(message) and an `open` flag: a PeerJS connection in the browser,
 * or a stand-in in the tests. Messages are plain JSON objects with a `t` field:
 *   guest -> host:  {t:'join', name, spectate?} | {t:'resume', token} | {t:'action', action} | {t:'leave'}
 *                   | {t:'chat', text} | {t:'ping', at} | {t:'pong', at}
 *   host -> guest:  {t:'joined', code, token, seat, spectator} | {t:'state', view} | {t:'error', error}
 *                   | {t:'gone', reason, keep?} | {t:'ping', at} | {t:'pong', at}
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const api = factory(isNode ? require('./core.js') : root.CrazyEights);
  if (isNode) module.exports = api;
  else root.CrazyEightsRoom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  const MAX_SEATS = 4;
  const MAX_SPECTATORS = 20;
  // A closed browser tab does not always tell its connection, so silence is treated as a drop.
  const HEARTBEAT_TIMEOUT_MS = 12000;
  // How long a dropped player's turn waits before the computer plays it for them.
  const AWAY_AFTER_MS = 15000;
  const CHAT_COOLDOWN_MS = 800;
  const CHAT_LOG = 30;
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
  const cleanText = raw => String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : lo));
  const isOpen = conn => !!conn && conn.open !== false;

  class HostRoom {
    constructor({
      code = randomCode(), hostName, target = 100, botDelayMs = 900, awayMs = AWAY_AFTER_MS,
      onView = () => {}, onChange = () => {},
    } = {}) {
      this.code = code;
      this.target = target;
      this.locked = false;      // when locked, nobody new can join as a player
      this.teams = false;       // 2 vs 2 (needs four seats)
      this.cpuLevel = 'normal'; // how smart the computer players are: 'easy', 'normal' or 'hard'
      this.isPublic = false;    // public rooms are listed for anyone to find
      this.game = null;
      this.botDelayMs = botDelayMs;
      this.awayMs = awayMs;
      this.botTimer = null;
      this.closed = false;
      this.chat = [];           // the most recent messages, shown to everyone in the room
      this.spectators = [];     // people watching without a seat: {name, token, conn}
      this.onView = onView;     // called with the host's own view after every change
      this.onChange = onChange; // called after every change (e.g. to save a copy for a page reload)
      // Seat 0 is the host, who plays from this browser, so it has no connection.
      this.seats = [{ name: cleanName(hostName, 'Player 1'), type: 'human', token: newToken(), conn: null, host: true }];
    }

    // ---------- connections ----------

    handleMessage(conn, msg) {
      if (this.closed || !msg || typeof msg !== 'object') return;
      if (msg.t === 'join') return this.join(conn, msg.name, !!msg.spectate);
      if (msg.t === 'resume') return this.resume(conn, msg.token);
      const idx = this.seats.findIndex(s => s.conn === conn);
      const spec = idx < 0 ? this.spectators.find(s => s.conn === conn) : null;
      if (idx < 0 && !spec) return this.send(conn, { t: 'gone', reason: 'You are not in this room any more.' });
      const who = idx >= 0 ? this.seats[idx] : spec;
      who.seen = Date.now();
      if (msg.t === 'ping') return this.send(conn, { t: 'pong', at: msg.at });
      if (msg.t === 'pong') {
        if (idx >= 0 && Number.isFinite(msg.at)) who.ping = Math.max(0, Date.now() - msg.at);
        return;
      }
      if (msg.t === 'chat') return this.reply(conn, this.chatFrom(who, msg.text));
      if (spec) {
        if (msg.t === 'leave') return this.dropSpectator(spec, 'You left the room.');
        return this.send(conn, { t: 'error', error: 'Watchers can chat, but not play.' });
      }
      if (msg.t === 'action') return this.reply(conn, this.act(idx, msg.action || {}));
      if (msg.t === 'leave') return this.reply(conn, this.act(idx, { type: 'leave' }));
    }

    reply(conn, result) {
      if (result && !result.ok) this.send(conn, { t: 'error', error: result.error });
    }

    join(conn, name, spectate) {
      if (this.seats.some(s => s.conn === conn) || this.spectators.some(s => s.conn === conn)) return;
      if (!spectate && this.game) {
        // A game is under way: a new player takes over a computer seat, if there is one free.
        const free = this.seats.find(s => s.type === 'cpu');
        if (free) return this.takeSeat(conn, name, free);
        return this.watch(conn, name);
      }
      if (spectate || this.game) return this.watch(conn, name);
      if (this.locked) return this.send(conn, { t: 'error', error: 'The host has locked the room.' });
      if (this.seats.length >= MAX_SEATS) return this.send(conn, { t: 'error', error: 'That room is full. You can watch instead.' });
      const seat = { name: cleanName(name, `Player ${this.seats.length + 1}`), type: 'human', token: newToken(), conn, seen: Date.now() };
      this.seats.push(seat);
      this.send(conn, { t: 'joined', code: this.code, token: seat.token, seat: this.seats.length - 1, spectator: false });
      this.changed();
    }

    // A new player takes over a computer seat in a game under way. They keep the cards that seat was holding.
    takeSeat(conn, name, seat) {
      const index = this.seats.indexOf(seat);
      seat.type = 'human';
      seat.name = cleanName(name, `Player ${index + 1}`);
      seat.token = newToken();
      seat.conn = conn;
      seat.seen = Date.now();
      seat.offlineSince = null;
      delete seat.level;
      this.send(conn, { t: 'joined', code: this.code, token: seat.token, seat: index, spectator: false });
      this.changed();
    }

    // Watching: no seat and no cards, but the game and the chat can be followed.
    watch(conn, name) {
      if (this.spectators.length >= MAX_SPECTATORS) return this.send(conn, { t: 'error', error: 'Too many people are watching already.' });
      const spec = { name: cleanName(name, 'Watcher'), token: newToken(), conn, seen: Date.now() };
      this.spectators.push(spec);
      this.send(conn, { t: 'joined', code: this.code, token: spec.token, seat: -1, spectator: true });
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
      this.send(conn, { t: 'joined', code: this.code, token: seat.token, seat: this.seats.indexOf(seat), spectator: false });
      this.changed();
    }

    disconnected(conn) {
      const spec = this.spectators.find(s => s.conn === conn);
      if (spec) {
        this.spectators = this.spectators.filter(s => s !== spec);
        return this.changed();
      }
      const seat = this.seats.find(s => s.conn === conn);
      if (!seat) return;
      seat.conn = null;
      seat.ping = null;
      seat.offlineSince = Date.now();
      this.changed();
    }

    dropSpectator(spec, reason) {
      this.spectators = this.spectators.filter(s => s !== spec);
      this.send(spec.conn, { t: 'gone', reason });
      this.changed();
    }

    send(conn, msg) {
      if (!isOpen(conn)) return;
      try { conn.send(msg); } catch { /* the connection has just gone */ }
    }

    // Called every few seconds by the host's page. Pings everyone (to measure how fast they are) and drops
    // anyone who has gone silent.
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
      for (const spec of [...this.spectators]) {
        if (!spec.conn) continue;
        if (now - (spec.seen || 0) > HEARTBEAT_TIMEOUT_MS) {
          const conn = spec.conn;
          this.disconnected(conn);
          try { if (conn.close) conn.close(); } catch { /* already gone */ }
        } else {
          this.send(spec.conn, { t: 'ping', at: Date.now() });
        }
      }
    }

    // Stops the room. Every guest is told why, so their browser can say so.
    close(reason = 'The host closed the room.') {
      this.closed = true;
      clearTimeout(this.botTimer);
      this.botTimer = null;
      for (const seat of this.seats) if (seat.conn) this.send(seat.conn, { t: 'gone', reason });
      for (const spec of this.spectators) if (spec.conn) this.send(spec.conn, { t: 'gone', reason });
    }

    // ---------- chat ----------

    // Anyone in the room (player, watcher or the host) can send a message. Messages are shared with
    // everyone, and each person can send one every CHAT_COOLDOWN_MS so the chat can't be flooded.
    chatFrom(who, text) {
      const clean = cleanText(text);
      if (!clean) return { ok: false, error: 'Type a message first.' };
      const now = Date.now();
      if (now - (who.lastChat || 0) < CHAT_COOLDOWN_MS) return { ok: false, error: 'Slow down a little.' };
      who.lastChat = now;
      this.chat.push({ from: who.name, text: clean, at: now });
      if (this.chat.length > CHAT_LOG) this.chat.shift();
      this.changed();
      return { ok: true };
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
          this.seats.push({ name: `CPU ${computers + 1}`, type: 'cpu', token: null, conn: null, level: this.cpuLevel });
          break;
        }
        case 'removeSeat': {
          const err = needHost() || needLobby();
          if (err) return err;
          const target = Number(body.seat);
          if (!Number.isInteger(target) || target < 1 || target >= this.seats.length) return fail('Choose a seat to remove.');
          const [removed] = this.seats.splice(target, 1);
          this.send(removed.conn, { t: 'gone', reason: 'The host removed you from the room.' });
          this.teamsNeedFourSeats();
          break;
        }
        case 'setTarget': {
          const err = needHost() || needLobby();
          if (err) return err;
          if (!Core.TARGETS.includes(Number(body.target))) return fail('Pick a valid target score.');
          this.target = Number(body.target);
          break;
        }
        case 'setTeams': {
          const err = needHost() || needLobby();
          if (err) return err;
          if (body.teams && this.seats.length !== MAX_SEATS) return fail('Teams need exactly four players or computer seats.');
          this.teams = !!body.teams;
          break;
        }
        case 'setCpuLevel': {
          const err = needHost() || needLobby();
          if (err) return err;
          if (!Core.LEVELS.includes(body.level)) return fail('Pick easy, normal or hard.');
          this.cpuLevel = body.level;
          for (const s of this.seats) if (s.type === 'cpu') s.level = body.level;
          break;
        }
        case 'setPublic': {
          const err = needHost();
          if (err) return err;
          this.isPublic = !!body.isPublic;
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
          this.game = Core.newMatch(this.seats, this.target, { teams: this.teams });
          break;
        }
        case 'leave': {
          if (!g) {
            if (isHost) return fail('The host closes the room instead.');
            const [left] = this.seats.splice(idx, 1);
            this.send(left.conn, { t: 'gone', reason: 'You left the room.' });
            this.teamsNeedFourSeats();
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
          target.level = this.cpuLevel;
          target.name = `${target.name} (CPU)`;
          break;
        }
        default:
          return fail('Unknown action.');
      }
      this.changed();
      return { ok: true };
    }

    teamsNeedFourSeats() {
      if (this.seats.length !== MAX_SEATS) this.teams = false;
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

    // Everything one seat is allowed to see (idx -1 is a watcher). Other players' tokens and connections
    // never leave the host.
    viewFor(idx) {
      const base = this.game
        ? Core.view(this.game, idx)
        : { phase: 'lobby', target: this.target, viewer: idx, teams: this.teams, seats: this.seats.map(s => ({ name: s.name, type: s.type, team: null })) };
      base.code = this.code;
      base.host = idx === 0;
      base.spectator = idx < 0;
      base.locked = this.locked;
      base.isPublic = this.isPublic;
      base.cpuLevel = this.cpuLevel;
      base.chat = this.chat.slice(-CHAT_LOG);
      base.spectators = this.spectators.length;
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
      for (const spec of this.spectators) {
        if (spec.conn) this.send(spec.conn, { t: 'state', view: this.viewFor(-1) });
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
      // A covering player's turn is played at the computer's level, using the most information the room has.
      Core.applyAction(g, g.current, Core.cpuAction(g, g.current, seat.type === 'cpu' ? seat.level : this.cpuLevel));
      this.changed();
    }

    // Re-sends the current view to the host's own screen (used after the host's page is set up).
    refresh() {
      this.changed();
    }

    // What the public list shows about this room. Nothing private (no tokens, no hands).
    publicInfo() {
      return {
        code: this.code,
        name: this.seats[0].name,
        humans: this.seats.filter(s => s.type === 'human').length,
        cpus: this.seats.filter(s => s.type === 'cpu').length,
        started: !!this.game,
        spectators: this.spectators.length,
        teams: this.teams,
        locked: this.locked,
        target: this.target,
      };
    }

    // ---------- saving the room, so a reloaded host page can reopen it ----------

    // Everything needed to rebuild the room. Connections are not saved: guests reconnect with their tokens.
    snapshot() {
      return {
        code: this.code,
        target: this.target,
        locked: this.locked,
        teams: this.teams,
        cpuLevel: this.cpuLevel,
        isPublic: this.isPublic,
        seats: this.seats.map(s => ({
          name: s.name, type: s.type, token: s.token, host: !!s.host, level: s.level,
          offlineSince: s.offlineSince ?? null, hand: s.hand, score: s.score, team: s.team,
        })),
        game: this.game && { ...this.game, seats: undefined },
      };
    }

    static restore(snap, opts = {}) {
      const room = new HostRoom({ ...opts, code: snap.code, hostName: snap.seats[0].name, target: snap.target });
      room.locked = !!snap.locked;
      room.teams = !!snap.teams;
      room.cpuLevel = snap.cpuLevel || 'normal';
      room.isPublic = !!snap.isPublic;
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

  // The public list. One browser (the "keeper") holds the list; every public host sends its room to it.
  // If the keeper leaves, the next host to announce takes over. Old entries drop off after a while.
  class PublicBoard {
    constructor({ ttlMs = 25000, now = () => Date.now() } = {}) {
      this.rooms = new Map();
      this.ttlMs = ttlMs;
      this.now = now;
    }

    announce(info) {
      if (!info || typeof info.code !== 'string' || !/^[A-Z0-9]{4}$/.test(info.code)) return false;
      this.rooms.set(info.code, {
        code: info.code,
        name: cleanName(info.name, 'Player 1'),
        humans: clampInt(info.humans, 0, 4),
        cpus: clampInt(info.cpus, 0, 4),
        started: !!info.started,
        spectators: clampInt(info.spectators, 0, 99),
        teams: !!info.teams,
        locked: !!info.locked,
        target: Core.TARGETS.includes(info.target) ? info.target : 100,
        updatedAt: this.now(),
      });
      return true;
    }

    remove(code) {
      this.rooms.delete(code);
    }

    list() {
      const cutoff = this.now() - this.ttlMs;
      for (const [code, room] of this.rooms) if (room.updatedAt < cutoff) this.rooms.delete(code);
      return [...this.rooms.values()]
        .map(({ updatedAt, ...rest }) => rest)
        .sort((a, b) => Number(a.started) - Number(b.started) || a.code.localeCompare(b.code));
    }
  }

  return {
    HostRoom, PublicBoard, MAX_SEATS, MAX_SPECTATORS, HEARTBEAT_TIMEOUT_MS, AWAY_AFTER_MS, CHAT_COOLDOWN_MS, randomCode,
  };
});
