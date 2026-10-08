'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../core.js');

const card = (id, rank, suit) => ({ id, rank, suit });

// Builds a match, then replaces the deal with a fixed position so each rule can be checked exactly.
function position(hands, { top, stock = [], current = 0, suit }) {
  const seats = hands.map((_, i) => ({ name: `P${i + 1}`, type: i === 0 ? 'human' : 'cpu' }));
  const g = Core.newMatch(seats, 100);
  g.seats.forEach((seat, i) => { seat.hand = hands[i]; });
  g.discard = [top];
  g.stock = stock;
  g.activeSuit = suit ?? top.suit;
  g.current = current;
  g.drawn = false;
  g.passes = 0;
  g.phase = 'playing';
  return g;
}

function countCards(g) {
  return g.stock.length + g.discard.length + g.seats.reduce((n, seat) => n + seat.hand.length, 0);
}

test('a fresh deck has 52 unique cards', () => {
  const deck = Core.newDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map(c => c.id)).size, 52);
  assert.equal(new Set(deck.map(c => c.rank + c.suit)).size, 52);
});

test('two players are dealt 7 cards and larger tables 5 each', () => {
  const two = Core.newMatch([{ name: 'A', type: 'human' }, { name: 'B', type: 'cpu' }], 100);
  assert.deepEqual(two.seats.map(s => s.hand.length), [7, 7]);
  assert.equal(countCards(two), 52);

  const four = Core.newMatch(['A', 'B', 'C', 'D'].map(name => ({ name, type: 'cpu' })), 100);
  assert.deepEqual(four.seats.map(s => s.hand.length), [5, 5, 5, 5]);
  assert.equal(countCards(four), 52);
});

test('a play must match the top card, and only the current player may play', () => {
  const g = position(
    [[card(1, '5', '♥'), card(2, '9', '♣')], [card(3, 'K', '♠')]],
    { top: card(90, '5', '♠') },
  );
  assert.equal(Core.applyAction(g, 0, { type: 'play', cardId: 2 }).ok, false);
  assert.equal(Core.applyAction(g, 1, { type: 'play', cardId: 3 }).ok, false);
  assert.equal(Core.applyAction(g, 0, { type: 'play', cardId: 1 }).ok, true);
  assert.equal(g.activeSuit, '♥');
  assert.equal(g.current, 1);
});

test('an 8 is wild, needs a suit, and sets the suit for the next player', () => {
  const g = position(
    [[card(1, '8', '♦'), card(2, '2', '♣')], [card(3, '3', '♠'), card(4, 'K', '♣')]],
    { top: card(90, '5', '♠') },
  );
  assert.equal(Core.applyAction(g, 0, { type: 'play', cardId: 1 }).ok, false);
  assert.equal(Core.applyAction(g, 0, { type: 'play', cardId: 1, suit: '♣' }).ok, true);
  assert.equal(g.activeSuit, '♣');
  // The next player must follow clubs: 3♠ does not match, K♣ does.
  assert.equal(Core.applyAction(g, 1, { type: 'play', cardId: 3 }).ok, false);
  assert.equal(Core.applyAction(g, 1, { type: 'play', cardId: 4 }).ok, true);
});

test('a player with no match draws once, then may only play or pass', () => {
  const g = position(
    [[card(1, '2', '♣')], [card(3, '3', '♠')]],
    { top: card(90, '5', '♠'), stock: [card(9, 'Q', '♦')] },
  );
  assert.equal(Core.applyAction(g, 0, { type: 'pass' }).ok, false, 'must draw before passing');
  assert.equal(Core.applyAction(g, 0, { type: 'draw' }).ok, true);
  assert.equal(Core.applyAction(g, 0, { type: 'draw' }).ok, false, 'only one draw per turn');
  assert.equal(Core.applyAction(g, 0, { type: 'pass' }).ok, true);
  assert.equal(g.current, 1);
});

test('going out ends the round and scores every card left in the other hands', () => {
  const g = position(
    [[card(1, 'K', '♥')], [card(2, '8', '♣'), card(3, '2', '♦')]],
    { top: card(90, 'K', '♠') },
  );
  assert.equal(Core.applyAction(g, 0, { type: 'play', cardId: 1 }).ok, true);
  assert.equal(g.phase, 'roundOver');
  assert.deepEqual(g.result, { winner: 0, gained: 52, blocked: false });
  assert.equal(g.seats[0].score, 52);
});

test('a blocked round goes to the player with the lowest hand', () => {
  const g = position(
    [[card(1, '2', '♥')], [card(2, 'K', '♣')]],
    { top: card(90, '5', '♠'), stock: [] },
  );
  assert.equal(Core.canDraw(g), false);
  assert.equal(Core.applyAction(g, 0, { type: 'pass' }).ok, true);
  assert.equal(g.phase, 'playing', 'one pass is not yet a block');
  assert.equal(Core.applyAction(g, 1, { type: 'pass' }).ok, true);
  assert.equal(g.phase, 'roundOver');
  assert.deepEqual(g.result, { winner: 0, gained: 10, blocked: true });
});

test('a player view hides other hands until the round is over', () => {
  const g = Core.newMatch([{ name: 'A', type: 'human' }, { name: 'B', type: 'human' }], 100);
  const during = Core.view(g, 0);
  assert.equal(Array.isArray(during.seats[0].hand), true);
  assert.equal(during.seats[1].hand, undefined);
  assert.equal(during.seats[1].handCount, 7);

  g.phase = 'roundOver';
  assert.equal(Array.isArray(Core.view(g, 0).seats[1].hand), true);
});

test('in team mode the winning team scores the other team\'s cards only', () => {
  const seats = ['A', 'B', 'C', 'D'].map((name, i) => ({ name, type: i === 0 ? 'human' : 'cpu' }));
  const g = Core.newMatch(seats, 100, { teams: true });
  g.seats[0].hand = [card(1, 'K', '♥')];
  g.seats[1].hand = [card(2, '8', '♣'), card(3, '2', '♦')]; // opponent: 50 + 2
  g.seats[2].hand = [card(4, '3', '♠')];                    // teammate: not counted
  g.seats[3].hand = [card(5, 'A', '♣')];                    // opponent: 1
  g.discard = [card(9, 'K', '♠')];
  g.activeSuit = '♠';
  g.current = 0;
  g.drawn = false;
  g.phase = 'playing';
  assert.equal(g.seats[0].team, g.seats[2].team);
  assert.equal(Core.applyAction(g, 0, { type: 'play', cardId: 1 }).ok, true);
  assert.deepEqual(g.teamScores, [53, 0]);
  assert.equal(g.result.gained, 53);
  assert.equal(g.phase, 'roundOver');
});

test('a player who has to pass is known to hold no card of that suit or rank', () => {
  const g = position([[card(1, '2', '♣')], [card(3, '3', '♠')]], { top: card(90, '5', '♠'), stock: [card(9, 'Q', '♦')] });
  assert.equal(Core.applyAction(g, 0, { type: 'draw' }).ok, true);
  assert.equal(Core.applyAction(g, 0, { type: 'pass' }).ok, true);
  assert.deepEqual(g.voids[0], { suits: ['♠'], ranks: ['5'] });
});

test('computer players at every level, with and without teams, always finish a match with valid moves', () => {
  const savedRollouts = Core.HARD.rollouts;
  Core.HARD.rollouts = 6; // (fewer imagined rounds keeps this test quick; the real game uses more)
  for (const level of Core.LEVELS) {
    for (const teams of [false, true]) {
      for (let trial = 0; trial < 25; trial++) {
        const seats = [0, 1, 2, 3].map(i => ({ name: `CPU ${i + 1}`, type: 'cpu', level }));
        const g = Core.newMatch(seats, 50, { teams });
        let steps = 0;
        while (g.phase !== 'matchOver') {
          assert.equal(countCards(g), 52);
          steps++;
          assert.ok(steps < 20000, 'the match did not finish');
          if (g.phase === 'roundOver') {
            assert.equal(Core.nextRound(g).ok, true);
            continue;
          }
          const si = g.current;
          const result = Core.applyAction(g, si, Core.cpuAction(g, si));
          assert.equal(result.ok, true, `${level}${teams ? ' teams' : ''}: ${result.error}`);
        }
      }
    }
  }
  Core.HARD.rollouts = savedRollouts;
});

test('computer-only matches always finish and never lose or duplicate cards', () => {
  for (let trial = 0; trial < 200; trial++) {
    const count = 2 + (trial % 3);
    const seats = Array.from({ length: count }, (_, i) => ({ name: `CPU ${i + 1}`, type: 'cpu' }));
    const g = Core.newMatch(seats, 50);
    let steps = 0;
    while (g.phase !== 'matchOver') {
      assert.equal(countCards(g), 52);
      steps++;
      assert.ok(steps < 20000, 'the match did not finish');
      if (g.phase === 'roundOver') {
        assert.equal(Core.nextRound(g).ok, true);
        continue;
      }
      const si = g.current;
      const result = Core.applyAction(g, si, Core.cpuAction(g, si));
      assert.equal(result.ok, true, result.error);
    }
    assert.equal(countCards(g), 52);
    assert.ok(Math.max(...g.seats.map(s => s.score)) >= 50);
  }
});
