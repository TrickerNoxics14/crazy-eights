'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');
const { HostRoom, PublicBoard, HEARTBEAT_TIMEOUT_MS } = require('../room.js');

// A stand-in for a PeerJS connection. Messages are copied, as they would be over a real network.
function fakeConn() {
  return {
    open: true,
    inbox: [],
    send(msg) { this.inbox.push(JSON.parse(JSON.stringify(msg))); },
    close() { this.open = false; },
  };
}

const latestState = conn => [...conn.inbox].reverse().find(m => m.t === 'state')?.view;
const errorsOf = conn => conn.inbox.filter(m => m.t === 'error').map(m => m.error);
const tokenOf = conn => conn.inbox.find(m => m.t === 'joined').token;

// Waits until a condition holds, checking often (the computer players act on timers).
async function until(fn, timeout = 5000) {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting for the room');
    await new Promise(r => setTimeout(r, 1));
  }
}

function lobbyWith(...guestNames) {
  const room = new HostRoom({ code: 'ABCD', hostName: 'Ann', target: 50, botDelayMs: 0 });
  const guests = guestNames.map(name => {
    const conn = fakeConn();
    room.handleMessage(conn, { t: 'join', name });
    return conn;
  });
  return { room, guests };
}

test('guests join, get a token, and see the lobby', () => {
  const { room, guests: [ben] } = lobbyWith('Ben');
  assert.equal(tokenOf(ben).length, 32);
  assert.equal(latestState(ben).phase, 'lobby');
  assert.deepEqual(latestState(ben).seats.map(s => s.name), ['Ann', 'Ben']);
  assert.equal(room.seats.length, 2);
});

test('a guest cannot see the host or another guest in a game, but sees their own hand', () => {
  const { room, guests: [ben, cy] } = lobbyWith('Ben', 'Cy');
  room.act(0, { type: 'addCpu' });
  assert.equal(room.act(0, { type: 'start' }).ok, true);
  const view = latestState(ben);
  assert.equal(view.viewer, 1);
  assert.equal(view.seats[0].hand, undefined, "Ann's hand must stay hidden from Ben");
  assert.equal(view.seats[2].hand, undefined, 'Cy must not see the computer hand either');
  assert.equal(view.seats[1].hand.length, 5);
  assert.equal(latestState(cy).seats[1].hand, undefined, "Ben's hand must stay hidden from Cy");
});

test('an action from the wrong seat is refused and changes nothing', () => {
  const { room, guests: [ben] } = lobbyWith('Ben');
  room.act(0, { type: 'start' });
  const before = JSON.stringify(room.game.discard);
  room.handleMessage(ben, { t: 'action', action: { type: 'draw' } });
  assert.deepEqual(errorsOf(ben), ['It is not your turn.']);
  assert.equal(JSON.stringify(room.game.discard), before);
});

test('a stranger with no seat cannot act or read the room', () => {
  const { room } = lobbyWith('Ben');
  const stranger = fakeConn();
  room.handleMessage(stranger, { t: 'action', action: { type: 'draw' } });
  assert.equal(stranger.inbox[0].t, 'gone');
  room.handleMessage(stranger, { t: 'resume', token: 'not-a-real-token' });
  assert.equal(stranger.inbox.at(-1).t, 'gone');
});

test('a full room refuses new players, and a late guest joins as a watcher once the game has started', () => {
  const { room } = lobbyWith('Ben', 'Cy', 'Dee');
  const late = fakeConn();
  room.handleMessage(late, { t: 'join', name: 'Eve' });
  assert.deepEqual(errorsOf(late), ['That room is full. You can watch instead.']);

  room.act(0, { type: 'start' });
  const later = fakeConn();
  room.handleMessage(later, { t: 'join', name: 'Fay' });
  assert.equal(later.inbox[0].t, 'joined');
  assert.equal(later.inbox[0].spectator, true);
  assert.equal(room.viewFor(0).spectators, 1);
  room.close();
});

test('the lobby rules: at least two seats to start, guests can leave, the host closes instead', () => {
  const { room, guests: [ben] } = lobbyWith('Ben');
  room.handleMessage(ben, { t: 'leave' });
  assert.equal(room.seats.length, 1);
  assert.equal(ben.inbox.at(-1).t, 'gone');
  assert.equal(room.act(0, { type: 'start' }).ok, false, 'one seat is not enough');
  assert.equal(room.act(0, { type: 'leave' }).ok, false, 'the host cannot leave; the room closes instead');
});

test('the host can remove a seat, and the removed guest is told why', () => {
  const { room, guests: [ben, cy] } = lobbyWith('Ben', 'Cy');
  assert.equal(room.act(0, { type: 'removeSeat', seat: 1 }).ok, true);
  assert.equal(ben.inbox.at(-1).t, 'gone');
  assert.match(ben.inbox.at(-1).reason, /removed/);
  assert.deepEqual(room.seats.map(s => s.name), ['Ann', 'Cy']);
  assert.equal(room.act(1, { type: 'removeSeat', seat: 0 }).ok, false, 'only the host can remove seats');
  assert.equal(cy.open, true);
});

test('a guest who loses the connection gets their seat back with their token', () => {
  const { room, guests: [ben] } = lobbyWith('Ben');
  const token = tokenOf(ben);
  room.disconnected(ben);
  assert.equal(room.viewFor(0).seats[1].connected, false);

  const again = fakeConn();
  room.handleMessage(again, { t: 'resume', token });
  assert.equal(again.inbox[0].t, 'joined');
  assert.equal(room.viewFor(0).seats[1].connected, true);

  // The old connection finishing its close must not disconnect the new one.
  room.disconnected(ben);
  assert.equal(room.viewFor(0).seats[1].connected, true);
});

test('opening the same seat in a second window moves it there and tells the first window', () => {
  const { room, guests: [ben] } = lobbyWith('Ben');
  const second = fakeConn();
  room.handleMessage(second, { t: 'resume', token: tokenOf(ben) });
  assert.equal(ben.inbox.at(-1).t, 'gone');
  assert.match(ben.inbox.at(-1).reason, /another window/);
  room.handleMessage(second, { t: 'action', action: { type: 'start' } }); // (not the host: refused)
  assert.deepEqual(errorsOf(second), ['Only the host can do that.']);
});

test('the host can hand a disconnected seat to a computer, and that guest can no longer come back', async () => {
  const { room, guests: [ben, cy] } = lobbyWith('Ben', 'Cy');
  const token = tokenOf(ben);
  room.act(0, { type: 'start' });
  room.disconnected(ben);
  assert.equal(room.act(0, { type: 'replace', seat: 1 }).ok, true);
  assert.equal(room.game.seats[1].type, 'cpu');
  assert.equal(room.game.seats[1].name, 'Ben (CPU)');

  const back = fakeConn();
  room.handleMessage(back, { t: 'resume', token });
  assert.equal(back.inbox[0].t, 'gone');
  assert.equal(room.act(0, { type: 'replace', seat: 2 }).ok, false, 'Cy is still connected');
  assert.equal(cy.open, true);
});

test('closing the room tells every guest why', () => {
  const { room, guests: [ben, cy] } = lobbyWith('Ben', 'Cy');
  room.close('The host closed the room.');
  assert.equal(ben.inbox.at(-1).reason, 'The host closed the room.');
  assert.equal(cy.inbox.at(-1).reason, 'The host closed the room.');
  room.handleMessage(ben, { t: 'action', action: { type: 'draw' } });
  assert.equal(room.closed, true);
});

test('a guest who goes silent for too long is dropped, but a guest who keeps pinging stays', () => {
  const { room, guests: [ben, cy] } = lobbyWith('Ben', 'Cy');
  const start = Date.now();
  // Ben keeps pinging; Cy never says anything again after joining.
  room.handleMessage(ben, { t: 'ping' });
  room.heartbeat(start + HEARTBEAT_TIMEOUT_MS - 1000);
  assert.equal(room.viewFor(0).seats[2].connected, true, 'not silent long enough yet');

  room.seats[1].seen = start + HEARTBEAT_TIMEOUT_MS; // Ben pings again just before the next check
  room.heartbeat(start + HEARTBEAT_TIMEOUT_MS + 1000);
  assert.equal(room.viewFor(0).seats[2].connected, false, 'Cy has gone silent');
  assert.equal(cy.open, false, 'the silent connection is closed');
  assert.equal(room.viewFor(0).seats[1].connected, true, 'Ben was pinging');
  assert.ok(ben.inbox.some(m => m.t === 'ping'), 'live guests are pinged');
});

test('the host sees its own view through onView after every change', () => {
  const views = [];
  const room = new HostRoom({ code: 'WXYZ', hostName: 'Ann', botDelayMs: 0, onView: v => views.push(v) });
  room.refresh();
  room.handleMessage(fakeConn(), { t: 'join', name: 'Ben' });
  assert.equal(views.at(-1).phase, 'lobby');
  assert.equal(views.at(-1).seats.length, 2);
  assert.equal(views.at(-1).host, true);
});

// The host's next move: play a card if one fits, otherwise draw, otherwise pass.
function hostMove(room) {
  const g = room.game;
  const legal = g.seats[0].hand.find(c => Core.canPlayWith(c, Core.topCard(g), g.activeSuit));
  if (legal) return room.act(0, legal.rank === '8' ? { type: 'play', cardId: legal.id, suit: '♠' } : { type: 'play', cardId: legal.id });
  if (!g.drawn && Core.canDraw(g)) return room.act(0, { type: 'draw' });
  return room.act(0, { type: 'pass' });
}

test('a guest who answers a ping has their speed measured, and pings are answered', () => {
  const { room, guests: [ben] } = lobbyWith('Ben');
  room.handleMessage(ben, { t: 'ping', at: 7 });
  assert.deepEqual(ben.inbox.at(-1), { t: 'pong', at: 7 });
  room.handleMessage(ben, { t: 'pong', at: Date.now() - 40 });
  const ping = room.viewFor(0).seats[1].ping;
  assert.ok(ping >= 40 && ping < 1000, `expected about 40 ms, got ${ping}`);
});

test('a locked lobby turns new guests away until the host unlocks it', () => {
  const { room } = lobbyWith('Ben');
  assert.equal(room.act(0, { type: 'lock', locked: true }).ok, true);
  assert.equal(room.viewFor(0).locked, true);
  const late = fakeConn();
  room.handleMessage(late, { t: 'join', name: 'Cy' });
  assert.deepEqual(errorsOf(late), ['The host has locked the room.']);
  assert.equal(room.act(1, { type: 'lock', locked: false }).ok, false, 'only the host can lock the room');
  room.act(0, { type: 'lock', locked: false });
  const again = fakeConn();
  room.handleMessage(again, { t: 'join', name: 'Cy' });
  assert.equal(again.inbox[0].t, 'joined');
});

test('the computer covers the turn of a guest who has dropped out for long enough', async () => {
  const room = new HostRoom({ code: 'COVR', hostName: 'Ann', target: 50, botDelayMs: 0, awayMs: 0 });
  const ben = fakeConn(), cy = fakeConn();
  room.handleMessage(ben, { t: 'join', name: 'Ben' });
  room.handleMessage(cy, { t: 'join', name: 'Cy' });
  room.act(0, { type: 'addCpu' });
  room.disconnected(ben);
  assert.equal(room.act(0, { type: 'start' }).ok, true);
  assert.equal(room.viewFor(0).seats[1].away, true, 'Ben is away and the computer is covering');

  assert.equal(room.game.current, 0);
  for (let i = 0; i < 5 && room.game.current === 0; i++) assert.equal(hostMove(room).ok, true);
  await until(() => room.game.current !== 1);
  assert.ok(room.game.log.some(line => line.startsWith('Ben ')), 'the computer took Ben\'s turn');
  room.close();
});

test('a guest who comes back before the computer covers keeps their turn', async () => {
  const room = new HostRoom({ code: 'BACK', hostName: 'Ann', target: 50, botDelayMs: 0, awayMs: 60000 });
  const ben = fakeConn(), cy = fakeConn();
  room.handleMessage(ben, { t: 'join', name: 'Ben' });
  room.handleMessage(cy, { t: 'join', name: 'Cy' });
  const token = tokenOf(ben);
  room.disconnected(ben);
  room.act(0, { type: 'start' });
  for (let i = 0; i < 5 && room.game.current === 0; i++) assert.equal(hostMove(room).ok, true);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(room.game.current, 1, 'nobody plays for Ben while he is only briefly away');

  const back = fakeConn();
  room.handleMessage(back, { t: 'resume', token });
  assert.equal(back.inbox[0].t, 'joined');
  assert.equal(room.viewFor(0).seats[1].away, false);
  assert.equal(room.viewFor(0).seats[1].connected, true);
  room.close();
});

test('a room can be saved and rebuilt in the middle of a game, and guests can rejoin the rebuilt room', async () => {
  const { room, guests: [ben, cy] } = lobbyWith('Ben', 'Cy');
  const benToken = tokenOf(ben);
  room.act(0, { type: 'start' });
  hostMove(room);

  // Saved as JSON (what localStorage would keep), then rebuilt.
  const saved = JSON.parse(JSON.stringify(room.snapshot()));
  assert.equal(JSON.stringify(saved).includes('"conn"'), false, 'connections are not saved');
  const rebuilt = HostRoom.restore(saved, { botDelayMs: 0, awayMs: 60000 });
  assert.equal(rebuilt.code, room.code);
  assert.equal(rebuilt.game.current, room.game.current);
  assert.deepEqual(rebuilt.game.seats[0].hand, room.game.seats[0].hand);
  assert.equal(rebuilt.seats[1].conn, null, 'nobody is connected to the rebuilt room yet');
  assert.ok(rebuilt.seats[1].offlineSince != null, 'guests count as away until they rejoin');

  const again = fakeConn();
  rebuilt.handleMessage(again, { t: 'resume', token: benToken });
  assert.equal(again.inbox[0].t, 'joined');
  assert.equal(rebuilt.viewFor(0).seats[1].connected, true);
  room.close();
  rebuilt.close();
});

test('a player who joins a game in progress takes over a computer seat, and a later one watches', () => {
  const { room, guests: [ben] } = lobbyWith('Ben');
  room.act(0, { type: 'addCpu' });
  room.act(0, { type: 'start' });
  const dee = fakeConn();
  room.handleMessage(dee, { t: 'join', name: 'Dee' });
  assert.equal(dee.inbox[0].t, 'joined');
  assert.equal(dee.inbox[0].spectator, false);
  assert.equal(dee.inbox[0].seat, 2);
  assert.equal(room.seats[2].type, 'human');
  assert.equal(room.seats[2].name, 'Dee');
  assert.equal(room.game.seats[2].type, 'human', 'the game sees the new player too');
  const v = latestState(dee);
  assert.equal(v.viewer, 2);
  assert.equal(Array.isArray(v.seats[2].hand), true, 'Dee sees their own cards');
  assert.equal(latestState(ben).seats[2].type, 'human');

  const eve = fakeConn();
  room.handleMessage(eve, { t: 'join', name: 'Eve' });
  assert.equal(eve.inbox[0].spectator, true, 'no computer seat is free, so Eve watches');
  room.close();
});

test('a watcher sees the game without any cards, can chat, and cannot play', () => {
  const { room, guests: [ben] } = lobbyWith('Ben');
  room.act(0, { type: 'start' });
  const watcher = fakeConn();
  room.handleMessage(watcher, { t: 'join', name: 'Wes', spectate: true });
  const view = latestState(watcher);
  assert.equal(view.spectator, true);
  assert.equal(view.viewer, -1);
  assert.equal(view.seats[0].hand, undefined);
  assert.equal(view.seats[1].hand, undefined);

  room.handleMessage(watcher, { t: 'action', action: { type: 'draw' } });
  assert.match(errorsOf(watcher)[0], /Watchers can chat/);
  room.handleMessage(watcher, { t: 'chat', text: 'Good luck!' });
  assert.equal(room.chat.at(-1).text, 'Good luck!');
  assert.equal(latestState(ben).chat.at(-1).from, 'Wes', 'players see what watchers say');
  room.close();
});

test('chat is shared with the room, cleaned up, and rate-limited', () => {
  const { room, guests: [ben, cy] } = lobbyWith('Ben', 'Cy');
  room.handleMessage(ben, { t: 'chat', text: '   hello\n\nthere  ' });
  assert.equal(room.chat[0].text, 'hello there');
  room.handleMessage(ben, { t: 'chat', text: 'too fast' });
  assert.match(errorsOf(ben)[0], /Slow down/);
  room.handleMessage(cy, { t: 'chat', text: '   ' });
  assert.match(errorsOf(cy)[0], /Type a message/);
  assert.equal(room.chatFrom(room.seats[0], 'Hi all').ok, true, 'the host can chat too');
  assert.deepEqual(latestState(cy).chat.map(m => m.text), ['hello there', 'Hi all']);
  room.close();
});

test('team games: the teams are shown to everyone, and the host can switch them on for four seats', () => {
  const { room, guests: [ben] } = lobbyWith('Ben');
  assert.equal(room.act(0, { type: 'setTeams', teams: true }).ok, false, 'teams need four seats');
  room.act(0, { type: 'addCpu' });
  room.act(0, { type: 'addCpu' });
  assert.equal(room.act(0, { type: 'setTeams', teams: true }).ok, true);
  room.act(0, { type: 'start' });
  const v = latestState(ben);
  assert.equal(v.teams, true);
  assert.deepEqual(v.teamScores, [0, 0]);
  assert.deepEqual(v.seats.map(s => s.team), [0, 1, 0, 1]);
  room.close();
});

test('the host can set how smart the computer players are, and teams switch off when seats change', () => {
  const { room } = lobbyWith('Ben');
  room.act(0, { type: 'addCpu' });
  room.act(0, { type: 'addCpu' });
  room.act(0, { type: 'setTeams', teams: true });
  assert.equal(room.act(0, { type: 'setCpuLevel', level: 'hard' }).ok, true);
  assert.equal(room.seats[2].level, 'hard');
  assert.equal(room.act(0, { type: 'setCpuLevel', level: 'extreme' }).ok, false);
  assert.equal(room.act(0, { type: 'removeSeat', seat: 3 }).ok, true);
  assert.equal(room.teams, false, 'teams need four seats, so they turn off');
  room.close();
});

test('the public board lists rooms that are announcing, forgets rooms that go quiet, and ignores bad codes', () => {
  let now = 1000;
  const board = new PublicBoard({ ttlMs: 10000, now: () => now });
  const room = new HostRoom({ code: 'PUB1', hostName: 'Ann' });
  assert.equal(board.announce(room.publicInfo()), true);
  assert.equal(board.announce({ code: 'bad code' }), false);
  assert.equal(board.list().length, 1);
  assert.equal(board.list()[0].name, 'Ann');
  now += 11000;
  assert.equal(board.list().length, 0, 'a room that stops announcing drops off the list');
  room.close();
});

test('a host and two guests finish a match through the room, with the computer playing its turns', async () => {
  const { room, guests } = lobbyWith('Ben', 'Cy');
  room.act(0, { type: 'addCpu' });
  room.act(0, { type: 'setTarget', target: 50 });
  assert.equal(room.act(0, { type: 'start' }).ok, true);
  const connOf = [null, guests[0], guests[1]];

  for (let step = 0; step < 5000; step++) {
    const g = room.game;
    if (g.phase === 'matchOver') break;
    if (g.phase === 'roundOver') {
      assert.equal(room.act(0, { type: 'next' }).ok, true);
      continue;
    }
    const seat = g.current;
    if (g.seats[seat].type === 'cpu') {
      const turn = g.turn;
      await until(() => room.game.turn !== turn || room.game.phase !== 'playing');
      continue;
    }
    const me = seat === 0 ? room.viewFor(0) : latestState(connOf[seat]);
    const hand = me.seats[seat].hand;
    const playable = hand.find(c => Core.canPlayWith(c, me.top, me.activeSuit));
    let action;
    if (playable) action = playable.rank === '8' ? { type: 'play', cardId: playable.id, suit: '♠' } : { type: 'play', cardId: playable.id };
    else if (!me.drawn && me.canDraw) action = { type: 'draw' };
    else action = { type: 'pass' };

    if (seat === 0) {
      const result = room.act(0, action);
      assert.equal(result.ok, true, result.error);
    } else {
      const conn = connOf[seat];
      const before = errorsOf(conn).length;
      room.handleMessage(conn, { t: 'action', action });
      assert.equal(errorsOf(conn).length, before, errorsOf(conn).at(-1));
    }
  }

  assert.equal(room.game.phase, 'matchOver');
  assert.ok(Math.max(...room.game.seats.map(s => s.score)) >= 50);
  // Once the match is over every hand is shown to everyone.
  assert.ok(Array.isArray(latestState(guests[0]).seats[2].hand));
});
