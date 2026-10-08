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
  const LEVELS = ['easy', 'normal', 'hard'];

  const fail = error => ({ ok: false, error });
  const ok = () => ({ ok: true });

  function newDeck() {
    const deck = [];
    let id = 0;
    for (const suit of SUITS) for (const rank of RANKS) deck.push({ id: id++, rank, suit });
    return deck;
  }

  const ALL_CARDS = newDeck();

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
  const teamName = team => (team === 0 ? 'Team A' : 'Team B');

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

  const emptyVoids = () => ({ suits: [], ranks: [] });

  // Starts a match and deals the first round. Seats are updated in place, so callers can keep their own
  // fields (tokens, connection flags) on them. With options.teams (four seats only), seats 1 & 3 are one
  // team and seats 2 & 4 the other: a team's round score is taken from the other team's hands only.
  function newMatch(seats, target, options = {}) {
    for (const seat of seats) {
      seat.hand = [];
      seat.score = 0;
    }
    const teams = !!options.teams && seats.length === 4;
    seats.forEach((seat, i) => { seat.team = teams ? i % 2 : null; });
    const g = {
      seats, target, round: 1, teams, teamScores: [0, 0],
      stock: [], discard: [], activeSuit: null,
      current: 0, drawn: false, passes: 0, turn: 0, voids: [],
      phase: 'playing', result: null, log: [],
    };
    say(g, `Match started. First to ${target} points${teams ? ' (teams: Team A is seats 1 & 3, Team B is seats 2 & 4)' : ''}.`);
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
    g.voids = g.seats.map(emptyVoids);
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
    const winnerTeam = g.teams ? g.seats[winner].team : null;
    const gained = g.seats.reduce((total, seat, i) => {
      if (i === winner || (g.teams && seat.team === winnerTeam)) return total;
      return total + handPoints(seat.hand);
    }, 0);
    if (g.teams) g.teamScores[winnerTeam] += gained;
    else g.seats[winner].score += gained;
    g.result = { winner, gained, blocked };
    const who = g.teams ? `${g.seats[winner].name} (${teamName(winnerTeam)})` : g.seats[winner].name;
    say(g, `${who} ${blocked ? 'had the lowest hand' : 'went out'} and scored ${gained}.`);
    const scores = g.teams ? g.teamScores : g.seats.map(seat => seat.score);
    const top = Math.max(...scores);
    const leaders = scores.filter(score => score === top).length;
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
    g.voids[si] = emptyVoids(); // a new card may match anything again
    g.drawn = true;
    say(g, `${g.seats[si].name} drew a card.`);
    return ok();
  }

  function pass(g, si) {
    if (g.phase !== 'playing') return fail('The round is not in progress.');
    if (si !== g.current) return fail('It is not your turn.');
    if (!g.drawn && (legalPlays(g, si).length || canDraw(g))) return fail('Play a card or draw first.');
    // Passing with no playable card tells everyone (and the computer) that this player holds no card of
    // the current suit or rank. That is useful information for smarter play.
    if (legalPlays(g, si).length === 0) {
      const v = g.voids[si];
      if (!v.suits.includes(g.activeSuit)) v.suits.push(g.activeSuit);
      if (!v.ranks.includes(topCard(g).rank)) v.ranks.push(topCard(g).rank);
    }
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
    g.teamScores = [0, 0];
    g.round = 1;
    say(g, '--- Rematch ---');
    startRound(g);
    return ok();
  }

  // ---------- computer players ----------

  const playMove = (card, suit) => (card.rank === '8' ? { type: 'play', cardId: card.id, suit } : { type: 'play', cardId: card.id });
  const randomSuit = () => SUITS[Math.floor(Math.random() * SUITS.length)];

  // Normal: dump the most valuable card first and keep 8s for when nothing else works.
  function bestPlay(g, hand) {
    const plays = hand.filter(card => canPlay(g, card));
    const normal = plays.filter(card => card.rank !== '8').sort((a, b) => points(b) - points(a));
    return normal[0] || plays[0] || null;
  }

  // Normal: call the suit the computer holds the most of.
  function pickSuit(hand) {
    const counts = Object.fromEntries(SUITS.map(s => [s, 0]));
    for (const card of hand) if (card.rank !== '8') counts[card.suit]++;
    return SUITS.reduce((best, s) => (counts[s] > counts[best] ? s : best), SUITS[0]);
  }

  // Hard: looks ahead. For each way it could play, it plays the rest of the round out many times, dealing
  // the hidden cards at random (but never to a player known to be unable to hold them, see pass()), and keeps
  // the play that does best on average. The opponents in those imagined rounds play the normal strategy.
  const HARD = { rollouts: 100, maxSteps: 400 };

  // Deals the cards nobody can see (everything except our hand and the discard pile) to the other players
  // and the draw pile, at random. Players known to be void of a suit or rank get none of those cards.
  function imagineHands(g, si) {
    const known = new Set([...g.seats[si].hand.map(c => c.id), ...g.discard.map(c => c.id)]);
    const unknown = shuffle(ALL_CARDS.filter(c => !known.has(c.id)));
    const hands = g.seats.map(() => []);
    g.seats.forEach((seat, j) => {
      if (j === si) return;
      const need = seat.hand.length;
      const v = g.voids[j] || emptyVoids();
      const allowed = c => !v.suits.includes(c.suit) && !v.ranks.includes(c.rank);
      for (const wanted of [allowed, () => true]) { // first honour what we know, then fill any gap
        for (let k = 0; hands[j].length < need && k < unknown.length;) {
          if (wanted(unknown[k])) hands[j].push(...unknown.splice(k, 1));
          else k++;
        }
      }
    });
    return { hands, stock: unknown };
  }

  // Plays one imagined round after `move`, and returns how good it was for seat si: the points it gained if
  // it won, or minus the points left in its hand if someone else won.
  function rollout(g, si, move) {
    const sim = {
      ...g,
      seats: g.seats.map(s => ({ name: s.name, type: 'cpu', level: 'normal', team: s.team, score: s.score, hand: s.hand.slice() })),
      teamScores: g.teamScores.slice(),
      stock: g.stock.slice(),
      discard: g.discard.slice(),
      voids: g.voids.map(v => ({ suits: v.suits.slice(), ranks: v.ranks.slice() })),
      log: [],
      result: null,
    };
    const dealt = imagineHands(g, si);
    sim.seats.forEach((s, j) => { if (j !== si) s.hand = dealt.hands[j]; });
    sim.stock = dealt.stock;
    applyAction(sim, si, move);
    for (let steps = 0; sim.phase === 'playing' && steps < HARD.maxSteps; steps++) {
      applyAction(sim, sim.current, cpuAction(sim, sim.current, 'normal'));
    }
    if (!sim.result) return 0;
    if (sim.result.winner === si) return sim.result.gained;
    return -handPoints(sim.seats[si].hand);
  }

  function hardPlay(g, si, plays) {
    const moves = [];
    for (const card of plays) {
      if (card.rank === '8') for (const s of SUITS) moves.push(playMove(card, s));
      else moves.push(playMove(card));
    }
    if (moves.length === 1) return moves[0];
    let best = moves[0];
    let bestValue = -Infinity;
    for (const move of moves) {
      let total = 0;
      for (let r = 0; r < HARD.rollouts; r++) total += rollout(g, si, move);
      if (total / HARD.rollouts > bestValue) {
        bestValue = total / HARD.rollouts;
        best = move;
      }
    }
    return best;
  }

  // Returns the next action a computer player should take in its turn.
  // level: 'easy' (plays at random), 'normal' (the original strategy) or 'hard' (looks ahead).
  function cpuAction(g, si, level) {
    const lvl = level || g.seats[si].level || 'normal';
    const plays = legalPlays(g, si);
    if (plays.length === 0) return !g.drawn && canDraw(g) ? { type: 'draw' } : { type: 'pass' };
    if (lvl === 'easy') {
      const card = plays[Math.floor(Math.random() * plays.length)];
      return playMove(card, card.rank === '8' ? randomSuit() : undefined);
    }
    if (lvl === 'hard') return hardPlay(g, si, plays);
    const hand = g.seats[si].hand;
    const best = bestPlay(g, hand);
    return playMove(best, best.rank === '8' ? pickSuit(hand) : undefined);
  }

  // What one viewer is allowed to see. viewer -1 is a spectator: no hands are shown until the round ends.
  function view(g, viewer) {
    const reveal = g.phase !== 'playing';
    return {
      phase: g.phase,
      round: g.round,
      target: g.target,
      turn: g.turn,
      current: g.current,
      viewer,
      teams: g.teams,
      teamScores: g.teams ? g.teamScores.slice() : null,
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
        team: g.teams ? seat.team : null,
        score: g.teams ? g.teamScores[seat.team] : seat.score,
        handCount: seat.hand.length,
        hand: reveal || i === viewer ? seat.hand : undefined,
      })),
    };
  }

  return {
    SUITS, RANKS, TARGETS, LEVELS, HARD,
    newDeck, shuffle, isRed, label, points, handPoints, topCard, teamName,
    canPlay, canPlayWith, legalPlays, canDraw,
    newMatch, applyAction, nextRound, rematch, cpuAction, view,
  };
});
