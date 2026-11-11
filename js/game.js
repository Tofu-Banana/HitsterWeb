// All the game rules live here. The host phone keeps ONE game at a time.
import { cleanTitle } from './musicbrainz.js';

export const WIN_CARDS = 10;      // cards needed to win (counted at the end of a round)
export const START_TOKENS = 2;    // tokens every player starts with
export const CLIP_SECONDS = Number(localStorage.getItem('hw_clip_seconds')) || 30; // how long each song clip plays

export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), b => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 57]).join('');

// Where to start the clip. We can't analyse the audio, so we aim for the
// typical first chorus: about a third of the way into the song (never in the
// first 20 seconds, and always leaving room for the full clip).
export function clipStart(song) {
  const dur = Math.round((song.durationMs || 0) / 1000);
  if (!dur) return 45;
  const latest = Math.max(0, dur - CLIP_SECONDS - 5);
  return Math.max(0, Math.min(latest, Math.max(20, Math.round(dur * 0.33))));
}

// ---------- checking a typed guess (for earning a token) ----------
const norm = s => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/&/g, 'and').replace(/^the\s+/, '')
  .replace(/[^a-z0-9֐-׿Ѐ-ӿ]/g, '');

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// Small typos are fine: about 1 wrong letter for every 5.
function close(a, b) {
  if (!a || !b) return false;
  return distance(a, b) <= Math.max(a.length > 3 ? 1 : 0, Math.floor(Math.max(a.length, b.length) * 0.2));
}

// True when the guess names the song AND at least half of its artists.
export function guessMatches(song, guess) {
  if (!guess) return false;
  const gt = norm(guess.title), ga = norm(guess.artist);
  if (!gt || !ga) return false;
  if (!close(gt, norm(cleanTitle(song.title))) && !close(gt, norm(song.title))) return false;
  const artists = (song.artists && song.artists.length ? song.artists : [song.artist]).map(norm).filter(Boolean);
  if (!artists.length) return false;
  if (close(ga, norm(song.artist))) return true;
  const parts = String(guess.artist).split(/\s*(?:,|;|&|\/|\+| and | feat\.? | ft\.? )\s*/i).map(norm).filter(Boolean);
  const hit = artists.filter(a => parts.some(p => close(p, a) || (p.length >= 4 && a.includes(p))) || (a.length >= 3 && ga.includes(a))).length;
  return hit >= Math.ceil(artists.length / 2);
}

export class Game {
  constructor() {
    this.id = newId();
    this.phase = 'playlist';     // playlist -> years -> fix -> lobby -> game -> over
    this.source = 'Spotify';     // the music app the playlist comes from (only used in the on-screen texts)
    this.songs = [];
    this.players = [];           // {num, token, secret, timeline:[song], tokens}
    this.removed = [];           // tokens of players who left or were removed
    this.openSlot = null;        // token of the QR code currently on screen
    this.yearProgress = { done: 0, total: 0, skip: false };
    this.deck = [];              // songs to be played, in playlist order
    this.playlistPos = -1;       // index (in the playlist) of the song now loaded in the music app
    this.current = 0;            // index into players
    this.round = 1;
    this.turn = null;
    this.turnCounter = 0;
    this.winner = null;
    this.endReason = '';
  }

  // ---------- saving (so an iPhone reload never loses the game) ----------
  toJSON() {
    const idx = s => (s ? s.id : null);
    return {
      v: 2, id: this.id, phase: this.phase, source: this.source, songs: this.songs, openSlot: this.openSlot,
      yearProgress: this.yearProgress, playlistPos: this.playlistPos, current: this.current,
      round: this.round, turnCounter: this.turnCounter, endReason: this.endReason, removed: this.removed,
      winner: this.winner ? this.winner.num : null,
      deck: this.deck.map(idx),
      players: this.players.map(p => ({ ...p, timeline: p.timeline.map(idx) })),
      turn: this.turn ? { ...this.turn, song: idx(this.turn.song) } : null,
    };
  }

  static from(o) {
    const g = new Game();
    const byId = new Map(o.songs.map(s => [s.id, s]));
    Object.assign(g, {
      id: o.id, phase: o.phase, source: o.source || 'Spotify', songs: o.songs, openSlot: o.openSlot, yearProgress: o.yearProgress,
      playlistPos: o.playlistPos, current: o.current, round: o.round, turnCounter: o.turnCounter, endReason: o.endReason,
      removed: o.removed || [],
    });
    g.deck = o.deck.map(i => byId.get(i));
    g.players = o.players.map(p => ({ tokens: START_TOKENS, ...p, timeline: p.timeline.map(i => byId.get(i)) }));
    g.turn = o.turn ? { bets: [], marks: {}, ...o.turn, song: o.turn.song == null ? null : byId.get(o.turn.song) } : null;
    g.winner = o.winner ? g.players.find(p => p.num === o.winner) : null;
    return g;
  }

  // ---------- lobby ----------
  makeSlot() {
    this.openSlot = newId();
    return this.openSlot;
  }

  join(token, secret) {
    const existing = this.players.find(p => p.token === token);
    if (existing) {
      if (existing.secret === secret) return { ok: true, player: existing };
      return { ok: false, error: 'This QR code was already used by another phone. Ask the host for a new one.' };
    }
    if (this.phase !== 'lobby' || token !== this.openSlot || this.removed.includes(token)) {
      return { ok: false, error: this.phase === 'lobby' ? 'This QR code is old. Scan the one on the host screen.' : 'The game has already started.' };
    }
    const num = Math.max(0, ...this.players.map(p => p.num)) + 1;
    const player = { num, token, secret, timeline: [], tokens: START_TOKENS };
    this.players.push(player);
    this.makeSlot();
    return { ok: true, player, joinedNow: true };
  }

  start() {
    if (this.phase !== 'lobby') return 'Not in the lobby.';
    if (!this.players.length) return 'At least one player has to join first.';
    const missing = this.songs.filter(s => !s.year);
    if (missing.length) return 'These songs have no year: ' + missing.map(s => s.title).join(', ') + '.';
    if (this.songs.length < this.players.length + 1) return 'Not enough songs in the playlist.';
    // Song 1 is already loaded (and paused) in the music app, so it becomes the first player's starting card.
    // Every turn then presses "next" exactly once, so the songs play in playlist order from song 2.
    // The other players' starting cards come from the END of the playlist, so those never play.
    this.deck = this.songs.slice();
    this.players.forEach((p, i) => { p.timeline = [i === 0 ? this.deck[0] : this.deck.pop()]; p.tokens = START_TOKENS; });
    this.openSlot = null;
    this.phase = 'game';
    this.current = 0;
    this.round = 1;
    this.playlistPos = 0; // song 1 is loaded in the music app
    this.newTurn();
    return null;
  }

  newTurn() {
    this.turnCounter++;
    this.turn = {
      id: this.turnCounter, song: null, stage: 'ready', // ready -> playing -> placing -> revealed -> (bets) -> next turn
      placeIndex: 0, placed: false, confirmed: false, correct: null, clip: null,
      bets: [],          // gaps where other players left a token on the active player's screen
      goodBets: [],      // which of those turned out to be right
      guess: null, guessOk: null,
      marks: {},         // host's bet marks: player number -> 1 (bet) or 2 (bet and won the card)
    };
  }

  // ---------- turns ----------
  // Host pressed the big play button (or "Next" after a player traded a token for a new song).
  play() {
    if (this.phase !== 'game') return { error: 'The game is not running.' };
    if (this.turn.stage === 'swapped') this.newTurn(); // same player, new song
    if (this.turn.stage !== 'ready') return { error: 'A song is already playing.' };

    // Next song in the playlist = one press of "next" in the music app.
    if (this.playlistPos + 1 >= this.deck.length) { this.finish('The playlist ran out of songs.'); return { over: true }; }
    this.playlistPos++;
    const song = this.deck[this.playlistPos];
    this.turn.song = song;
    this.turn.stage = 'playing';
    this.turn.clip = { mode: 'next', nexts: 1, start: clipStart(song), length: CLIP_SECONDS, turnId: this.turn.id };
    return { clip: this.turn.clip };
  }

  clipEnded(turnId) {
    if (this.phase !== 'game' || this.turn.stage !== 'playing') return false;
    if (turnId && Number(turnId) !== this.turn.id) return false;
    this.turn.stage = 'placing';
    const tl = this.currentPlayer().timeline;
    this.turn.placeIndex = Math.floor(tl.length / 2 + 0.5); // start in the middle
    return true;
  }

  // Everything the active player's phone can do during their turn. Returns true if something changed.
  playerAct(player, act) {
    const t = this.turn;
    if (this.phase !== 'game' || !t || t.stage !== 'placing' || player !== this.currentPlayer()) return false;
    if (!act || act.turnId !== t.id) return false;
    let changed = false;

    // Trade a token for a new song (only before the placement is confirmed).
    if (act.swap && !t.confirmed) {
      if (player.tokens < 1) return false;
      player.tokens--;
      t.stage = 'swapped';
      return true;
    }
    if (!t.confirmed && Number.isInteger(act.index)) {
      const index = Math.max(0, Math.min(player.timeline.length, act.index));
      if (!t.placed || index !== t.placeIndex) { t.placeIndex = index; t.placed = true; changed = true; }
    }
    if (act.guess && (act.guess.artist || act.guess.title)) {
      const g = { artist: String(act.guess.artist || '').slice(0, 120), title: String(act.guess.title || '').slice(0, 120) };
      if (!t.guess || t.guess.artist !== g.artist || t.guess.title !== g.title) { t.guess = g; changed = true; }
    }
    if (act.confirmed && t.placed && !t.confirmed) { t.confirmed = true; changed = true; }
    if (t.confirmed) {
      const raw = Array.isArray(act.bets) ? act.bets : []; // (an empty list arrives as "nothing")
      const bets = [...new Set(raw.filter(i => Number.isInteger(i) && i >= 0 && i <= player.timeline.length && i !== t.placeIndex))].sort((a, b) => a - b);
      if (bets.join() !== t.bets.join()) { t.bets = bets; changed = true; }
    }
    return changed;
  }

  fits(timeline, i, year) {
    return (i === 0 || timeline[i - 1].year <= year) && (i === timeline.length || year <= timeline[i].year);
  }

  // Host tapped the face-down card: bets are over, show the answer.
  flip() {
    const t = this.turn;
    if (this.phase !== 'game' || t.stage !== 'placing' || !t.confirmed) return false;
    const p = this.currentPlayer();
    const y = t.song.year;
    t.goodBets = t.bets.filter(i => this.fits(p.timeline, i, y));
    t.correct = this.fits(p.timeline, t.placeIndex, y);
    t.stage = 'revealed';
    if (t.correct) p.timeline.splice(t.placeIndex, 0, t.song);
    if (t.guess) {
      t.guessOk = guessMatches(t.song, t.guess);
      if (t.guessOk) p.tokens++;
    }
    return true;
  }

  // Host overrides the automatic "did they name the song?" decision (only after the card is flipped).
  // Gives the active player the token if they didn't get it, or takes it back if they did.
  canOverrideGuess() {
    return this.phase === 'game' && !!this.turn && (this.turn.stage === 'revealed' || this.turn.stage === 'bets');
  }
  overrideGuess() {
    if (!this.canOverrideGuess()) return false;
    const t = this.turn, p = this.currentPlayer();
    if (t.guessOk === true) { t.guessOk = false; p.tokens = Math.max(0, p.tokens - 1); }
    else { t.guessOk = true; p.tokens++; }
    return true;
  }

  // Host pressed "Next" after the card was flipped.
  next() {
    const t = this.turn;
    if (this.phase !== 'game') return false;
    if (t.stage === 'revealed' && t.bets.length && this.bettors().length) { t.stage = 'bets'; return true; }
    if (t.stage === 'revealed' || t.stage === 'bets') { this.resolveBets(); this.endTurn(); return true; }
    return false;
  }

  // Players who could have bet: everyone except the active player, with at least one token.
  bettors() {
    const active = this.currentPlayer();
    return this.players.filter(p => p !== active && p.tokens > 0);
  }

  // Host taps a name: no bet -> bet -> bet and won the card -> no bet.
  cycleMark(num) {
    const t = this.turn;
    if (this.phase !== 'game' || t.stage !== 'bets') return false;
    if (!this.bettors().some(p => p.num === num)) return false;
    const canWin = !t.correct; // the card can only be stolen if the active player got it wrong
    let m = ((t.marks[num] || 0) + 1) % 3;
    if (m === 2 && !canWin) m = 0;
    if (m === 2) for (const k of Object.keys(t.marks)) if (t.marks[k] === 2) t.marks[k] = 1; // only one winner
    t.marks[num] = m;
    return true;
  }

  resolveBets() {
    const t = this.turn;
    for (const p of this.players) {
      const m = t.marks[p.num] || 0;
      if (!m) continue;
      p.tokens = Math.max(0, p.tokens - 1);
      if (m === 2 && !t.correct) {
        let i = p.timeline.findIndex(s => s.year > t.song.year);
        if (i < 0) i = p.timeline.length;
        p.timeline.splice(i, 0, t.song);
      }
    }
  }

  // Moves on to the next player. The end of a round is where a winner is decided.
  endTurn() {
    this.current++;
    if (this.current >= this.players.length) {
      this.current = 0;
      this.round++;
      this.checkWin();
    }
    if (this.phase === 'game') this.newTurn();
  }

  checkWin() {
    if (!this.players.length) return this.finish('Everyone left the game.');
    const max = Math.max(...this.players.map(p => p.timeline.length));
    const leaders = this.players.filter(p => p.timeline.length === max);
    if (max >= WIN_CARDS && leaders.length === 1) this.finish('', leaders[0]);
  }

  // Host skips the current turn (for example when the player isn't answering).
  skipTurn() {
    if (this.phase !== 'game') return false;
    this.endTurn();
    return true;
  }

  // A player left, or the host removed them.
  removePlayer(token) {
    const i = this.players.findIndex(p => p.token === token);
    if (i < 0) return false;
    const num = this.players[i].num;
    this.players.splice(i, 1);
    this.removed.push(token);
    if (this.phase !== 'game') return true;
    if (!this.players.length) { this.finish('Everyone left the game.'); return true; }
    if (i < this.current) this.current--;
    else if (i === this.current) {
      // It was their turn: drop it and give the turn to whoever is next.
      if (this.current >= this.players.length) { this.current = 0; this.round++; this.checkWin(); }
      if (this.phase === 'game') this.newTurn();
    }
    if (this.turn) delete this.turn.marks[num];
    return true;
  }

  finish(reason, winner) {
    this.phase = 'over';
    this.endReason = reason || '';
    if (winner) { this.winner = winner; return; }
    if (!this.players.length) { this.winner = null; return; }
    const max = Math.max(...this.players.map(p => p.timeline.length));
    const leaders = this.players.filter(p => p.timeline.length === max);
    this.winner = leaders.length === 1 ? leaders[0] : null; // null = tie
  }

  currentPlayer() { return this.players[this.current]; }

  // ---------- what each screen is allowed to see ----------
  publicTurn() {
    if (!this.turn || this.phase === 'lobby') return null;
    const t = this.turn;
    const shown = t.stage === 'revealed' || t.stage === 'bets' || t.stage === 'swapped';
    return {
      id: t.id,
      playerNum: this.currentPlayer() ? this.currentPlayer().num : null,
      stage: t.stage,
      placed: t.placed,
      confirmed: t.confirmed,
      placeIndex: t.placeIndex,
      bets: t.bets,
      goodBets: shown ? t.goodBets : [],
      correct: t.correct,
      guessOk: t.guessOk,
      marks: t.marks,
      // The song stays secret until the card is flipped (no peeking in the browser tools!)
      song: shown ? card(t.song) : null,
    };
  }

  scoreboard() {
    return this.players.map(p => ({ num: p.num, cards: p.timeline.length, tokens: p.tokens }));
  }

  hostView(playerUrl, connected) {
    const next = this.players.length ? this.players[(this.current + 1) % this.players.length] : null;
    return {
      role: 'host',
      phase: this.phase,
      source: this.source,
      winCards: WIN_CARDS,
      songsTotal: this.songs.length,
      yearProgress: this.yearProgress,
      slot: this.phase === 'lobby' ? { num: Math.max(0, ...this.players.map(p => p.num)) + 1, url: playerUrl(this.openSlot) } : null,
      players: this.players.map(p => ({ num: p.num, token: p.token, cards: p.timeline.length, tokens: p.tokens, online: connected.has(p.token) })),
      bettors: this.phase === 'game' ? this.bettors().map(p => p.num) : [],
      nextNum: next ? next.num : null,
      round: this.round,
      turn: this.publicTurn(),
      clip: this.turn && this.turn.stage === 'playing' ? this.turn.clip : null,
      songsLeft: this.phase === 'game' ? Math.max(0, this.deck.length - this.playlistPos - 1) : null,
      winner: this.winner ? this.winner.num : null,
      endReason: this.endReason,
    };
  }

  // Shared with every phone through Firebase. No hidden song info in here.
  publicView() {
    return {
      phase: this.phase,
      winCards: WIN_CARDS,
      players: this.scoreboard(),
      round: this.round,
      turn: this.publicTurn(),
      winner: this.winner ? this.winner.num : null,
      endReason: this.endReason,
    };
  }
}

export function card(s) {
  // Show "Bohemian Rhapsody", not "Bohemian Rhapsody - Remastered 2011"
  return { id: s.id, title: cleanTitle(s.title), artist: s.artist, year: s.year };
}
