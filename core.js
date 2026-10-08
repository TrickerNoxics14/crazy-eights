/*
 * Crazy Eights rules. This file is shared: the browser loads it with a
 * <script> tag and the server loads it with require(), so both sides follow
 * exactly the same rules.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrazyEights = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const TARGETS = [50, 100, 200];

  const fail = error => ({ ok: false, error });
  const ok = () => ({ ok: true });

  function newDeck() {
    const deck = [];
    let id = 0;
    for (const suit of SUITS) for (const rank of RANKS) deck.push({ id: id++, rank, suit });
    return deck;
  }

  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  const isRed = card => card.suit === '♥' || card.suit === '♦';
  const label = card => card.rank + card.suit;
  const points = card => (card.rank === '8' ? 50 : card.rank === 'A' ? 1 : 'JQK'.includes(card.rank) ? 10 : Number(card.rank));
  const handPoints = hand => hand.reduce((sum, card) => sum + points(card), 0);

  const topCard = g => g.discard[g.discard.length - 1];
  const canPlayWith = (card, top, activeSuit) =>
    card.rank === '8' || card.suit === activeSuit || card.rank === top.rank;
  const canPlay = (g, card) => canPlayWith(card, topCard(g), g.activeSuit);
  const legalPlays = (g, si) => g.seats[si].hand.filter(card => canPlay(g, card));
  const canDraw = g => g.stock.length > 0 || g.discard.length > 1;

  function say(g, text) {
    g.log.push(text);
    if (g.log.length > 100) g.log.shift();
  }

  // Starts a match and deals the first round. Seats are updated in place, so
  // callers can keep their own fields (tokens, connection flags) on them.
  function newMatch(seats, target) {
    for (const seat of seats) {
      seat.hand = [];
      seat.score = 0;
    }
    const g = {
      seats, target, round: 1,
      stock: [], discard: [], activeSuit: null,
      current: 0, drawn: false, passes: 0, turn: 0,
      phase: 'playing', result: null, log: [],
    };
    say(g, `Match started. First to ${target} points.`);
    startRound(g);
    return g;
  }

  function startRound(g) {
    const n = g.seats.length;
    const deck = shuffle(newDeck());
    const size = n === 2 ? 7 : 5;
    for (const seat of g.seats) seat.hand = [];
    for (let i = 0; i < size; i++) for (const seat of g.seats) seat.hand.push(deck.pop());
    g.discard = [deck.pop()];
    g.stock = deck;
    g.activeSuit = topCard(g).suit;
    g.current = (g.round - 1) % n;
    g.drawn = false;
    g.passes = 0;
    g.phase = 'playing';
    g.result = null;
    g.turn++;
    say(g, `Round ${g.round}: ${g.seats[g.current].name} leads. Top card is ${label(topCard(g))}.`);
  }

  // Draws one card for a seat, reshuffling the discard pile if the draw pile is empty.
  function drawFor(g, si) {
    if (g.stock.length === 0) {
      const keep = g.discard.pop();
      g.stock = shuffle(g.discard);
      g.discard = [keep];
      say(g, 'The draw pile ran out, so the discard pile was reshuffled.');
    }
    const card = g.stock.pop();
    g.seats[si].hand.push(card);
    return card;
  }

  function advance(g) {
    g.current = (g.current + 1) % g.seats.length;
    g.drawn = false;
    g.turn++;
  }

  function endRound(g, winner, blocked) {
    const gained = g.seats.reduce((total, seat, i) => (i === winner ? total : total + handPoints(seat.hand)), 0);
    g.seats[winner].score += gained;
    g.result = { winner, gained, blocked };
    say(g, `${g.seats[winner].name} ${blocked ? 'had the lowest hand' : 'went out'} and scored ${gained}.`);
    const top = Math.max(...g.seats.map(seat => seat.score));
    const leaders = g.seats.filter(seat => seat.score === top).length;
    g.phase = top >= g.target && leaders === 1 ? 'matchOver' : 'roundOver';
  }

  // Every action returns { ok: true } or { ok: false, error }. Invalid actions change nothing.
  function play(g, si, cardId, suit) {
    if (g.phase !== 'playing') return fail('The round is not in progress.');
    if (si !== g.current) return fail('It is not your turn.');
    const seat = g.seats[si];
    const card = seat.hand.find(c => c.id === cardId);
    if (!card) return fail('That card is not in your hand.');
    if (!canPlay(g, card)) return fail('That card does not match the top card.');
    if (card.rank === '8' && !SUITS.includes(suit)) return fail('Choose a suit for the 8.');
    seat.hand.splice(seat.hand.indexOf(card), 1);
    g.discard.push(card);
    g.activeSuit = card.rank === '8' ? suit : card.suit;
    g.passes = 0;
    say(g, `${seat.name} played ${label(card)}${card.rank === '8' ? `, calling ${suit}` : ''}.`);
    if (seat.hand.length === 0) endRound(g, si, false);
    else advance(g);
    return ok();
  }

  function draw(g, si) {
    if (g.phase !== 'playing') return fail('The round is not in progress.');
    if (si !== g.current) return fail('It is not your turn.');
    if (g.drawn) return fail('You have already drawn this turn.');
    if (legalPlays(g, si).length) return fail('You have a playable card.');
    if (!canDraw(g)) return fail('The draw pile is empty.');
    drawFor(g, si);
    g.drawn = true;
    say(g, `${g.seats[si].name} drew a card.`);
    return ok();
  }

  function pass(g, si) {
    if (g.phase !== 'playing') return fail('The round is not in progress.');
    if (si !== g.current) return fail('It is not your turn.');
    if (!g.drawn && (legalPlays(g, si).length || canDraw(g))) return fail('Play a card or draw first.');
    g.passes++;
    say(g, `${g.seats[si].name} passed.`);
    // Nobody can draw, and every player has passed since the last play: nothing can change.
    if (!canDraw(g) && g.passes >= g.seats.length) {
      let lowest = 0;
      g.seats.forEach((seat, i) => {
        if (handPoints(seat.hand) < handPoints(g.seats[lowest].hand)) lowest = i;
      });
      say(g, 'Nobody can play and the draw pile is empty, so the round is blocked.');
      endRound(g, lowest, true);
    } else {
      advance(g);
    }
    return ok();
  }

  // action: { type: 'play', cardId, suit? } | { type: 'draw' } | { type: 'pass' }
  function applyAction(g, si, action) {
    switch (action && action.type) {
      case 'play': return play(g, si, action.cardId, action.suit);
      case 'draw': return draw(g, si);
      case 'pass': return pass(g, si);
      default: return fail('Unknown action.');
    }
  }

  function nextRound(g) {
    if (g.phase !== 'roundOver') return fail('The round is not over yet.');
    g.round++;
    startRound(g);
    return ok();
  }

  function rematch(g) {
    if (g.phase !== 'matchOver') return fail('The match is not over yet.');
    for (const seat of g.seats) seat.score = 0;
    g.round = 1;
    say(g, '--- Rematch ---');
    startRound(g);
    return ok();
  }

  // Computer player: dump the most valuable card first and keep 8s for when nothing else works.
  function bestPlay(g, hand) {
    const plays = hand.filter(card => canPlay(g, card));
    const normal = plays.filter(card => card.rank !== '8').sort((a, b) => points(b) - points(a));
    return normal[0] || plays[0] || null;
  }

  // Call the suit the computer holds the most of.
  function pickSuit(hand) {
    const counts = Object.fromEntries(SUITS.map(s => [s, 0]));
    for (const card of hand) if (card.rank !== '8') counts[card.suit]++;
    return SUITS.reduce((best, s) => (counts[s] > counts[best] ? s : best), SUITS[0]);
  }

  // Returns the next action a computer player should take in its current turn.
  function cpuAction(g, si) {
    const hand = g.seats[si].hand;
    const best = bestPlay(g, hand);
    if (best) return { type: 'play', cardId: best.id, suit: best.rank === '8' ? pickSuit(hand) : undefined };
    if (!g.drawn && canDraw(g)) return { type: 'draw' };
    return { type: 'pass' };
  }

  // What one viewer is allowed to see: their own hand, plus everyone's hands once the round is over.
  function view(g, viewer) {
    const reveal = g.phase !== 'playing';
    return {
      phase: g.phase,
      round: g.round,
      target: g.target,
      turn: g.turn,
      current: g.current,
      viewer,
      activeSuit: g.activeSuit,
      top: topCard(g),
      stockCount: g.stock.length,
      canDraw: canDraw(g),
      drawn: g.drawn,
      result: g.result,
      log: g.log.slice(-40),
      seats: g.seats.map((seat, i) => ({
        name: seat.name,
        type: seat.type,
        score: seat.score,
        handCount: seat.hand.length,
        hand: reveal || i === viewer ? seat.hand : undefined,
      })),
    };
  }

  return {
    SUITS, RANKS, TARGETS,
    newDeck, shuffle, isRed, label, points, handPoints, topCard,
    canPlay, canPlayWith, legalPlays, canDraw,
    newMatch, applyAction, nextRound, rematch, cpuAction, view,
  };
});
