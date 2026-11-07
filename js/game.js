// All the game rules live here. The server keeps ONE game at a time.
import { cleanTitle } from './musicbrainz.js';

export const WIN_CARDS = 10;      // cards needed to win (counted at the end of a round)
export const CLIP_SECONDS = Number(localStorage.getItem('hw_clip_seconds')) || 30; // how long each song clip plays

export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(9)), b => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 57]).join('');

// Where to start the clip. We can't analyse Spotify's audio, so we aim for the
// typical first chorus: about a third of the way into the song (never in the
// first 20 seconds, and always leaving room for the full clip).
export function clipStart(song) {
  const dur = Math.round((song.durationMs || 0) / 1000);
  if (!dur) return 45;
  const latest = Math.max(0, dur - CLIP_SECONDS - 5);
  return Math.max(0, Math.min(latest, Math.max(20, Math.round(dur * 0.33))));
}

export class Game {
  constructor() {
    this.id = newId();
    this.phase = 'playlist';     // playlist -> years -> lobby -> game -> over
    this.songs = [];
    this.players = [];           // {num, token, secret, timeline:[song]}
    this.openSlot = null;        // token of the QR code currently on screen
    this.yearProgress = { done: 0, total: 0, skip: false };
    this.deck = [];              // songs to be played, in playlist order
    this.playlistPos = -1;       // index (in the playlist) of the song now loaded in Spotify
    this.current = 0;            // index into players
    this.round = 1;
    this.turn = null;            // {id, song, stage, placeIndex, placed, correct}
    this.turnCounter = 0;
    this.winner = null;
    this.endReason = '';
  }

  // ---------- saving (so an iPhone reload never loses the game) ----------
  toJSON() {
    const idx = s => (s ? s.id : null);
    return {
      v: 1, id: this.id, phase: this.phase, songs: this.songs, openSlot: this.openSlot,
      yearProgress: this.yearProgress, playlistPos: this.playlistPos, current: this.current,
      round: this.round, turnCounter: this.turnCounter, endReason: this.endReason,
      winner: this.winner ? this.winner.num : null,
      deck: this.deck.map(idx),
      players: this.players.map(p => ({ num: p.num, token: p.token, secret: p.secret, timeline: p.timeline.map(idx) })),
      turn: this.turn ? { ...this.turn, song: idx(this.turn.song) } : null,
    };
  }

  static from(o) {
    const g = new Game();
    const byId = new Map(o.songs.map(s => [s.id, s]));
    Object.assign(g, {
      id: o.id, phase: o.phase, songs: o.songs, openSlot: o.openSlot, yearProgress: o.yearProgress,
      playlistPos: o.playlistPos, current: o.current, round: o.round, turnCounter: o.turnCounter, endReason: o.endReason,
    });
    g.deck = o.deck.map(i => byId.get(i));
    g.players = o.players.map(p => ({ ...p, timeline: p.timeline.map(i => byId.get(i)) }));
    g.turn = o.turn ? { ...o.turn, song: o.turn.song == null ? null : byId.get(o.turn.song) } : null;
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
    if (this.phase !== 'lobby' || token !== this.openSlot) {
      return { ok: false, error: this.phase === 'lobby' ? 'This QR code is old. Scan the one on the host screen.' : 'The game has already started.' };
    }
    const player = { num: this.players.length + 1, token, secret, timeline: [] };
    this.players.push(player);
    this.makeSlot();
    return { ok: true, player, joinedNow: true };
  }

  start() {
    if (this.phase !== 'lobby') return 'Not in the lobby.';
    if (!this.players.length) return 'At least one player has to join first.';
    const usable = this.songs.filter(s => s.year);
    if (usable.length < this.players.length + 1) return 'Not enough songs in the playlist.';
    // Songs are PLAYED in playlist order from the top (that's what Spotify will play).
    // Each player's starting card is taken from the END of the playlist, so those never play.
    this.deck = this.songs.slice();
    for (const p of this.players) {
      let s;
      do { s = this.deck.pop(); } while (s && !s.year);
      p.timeline = [s];
    }
    this.openSlot = null;
    this.phase = 'game';
    this.current = 0;
    this.round = 1;
    this.playlistPos = -1;
    this.newTurn();
    return null;
  }

  newTurn() {
    this.turnCounter++;
    this.turn = { id: this.turnCounter, song: null, stage: 'ready', placeIndex: 0, placed: false, correct: null, clip: null };
  }

  // ---------- turns ----------
  // Host pressed the big play button.
  play() {
    if (this.phase !== 'game') return { error: 'The game is not running.' };
    if (this.turn.stage === 'revealed') this.advance();
    if (this.phase !== 'game') return { over: true };
    if (this.turn.stage !== 'ready') return { error: 'A song is already playing.' };

    // Next song in the playlist. Songs without any known year are skipped in Spotify too.
    // nexts = how many times to press "next" in Spotify (0 = play the song that's already loaded).
    let nexts = 0, song = null;
    while (this.deck.length > this.playlistPos + 1) {
      if (this.playlistPos >= 0) nexts++;
      this.playlistPos++;
      const s = this.deck[this.playlistPos];
      if (s.year) { song = s; break; }
    }
    if (!song) { this.finish('The playlist ran out of songs.'); return { over: true }; }
    this.turn.song = song;
    this.turn.stage = 'playing';
    this.turn.clip = { mode: nexts ? 'next' : 'first', nexts, start: clipStart(song), length: CLIP_SECONDS, turnId: this.turn.id };
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

  place(player, index) {
    if (this.phase !== 'game' || this.turn.stage !== 'placing') return false;
    if (player !== this.currentPlayer()) return false;
    const max = player.timeline.length;
    this.turn.placeIndex = Math.max(0, Math.min(max, index | 0));
    this.turn.placed = true;
    return true;
  }

  flip() {
    if (this.phase !== 'game' || this.turn.stage !== 'placing') return false;
    const p = this.currentPlayer();
    const tl = p.timeline;
    const i = this.turn.placeIndex;
    const y = this.turn.song.year;
    const correct = (i === 0 || tl[i - 1].year <= y) && (i === tl.length || y <= tl[i].year);
    this.turn.correct = correct;
    this.turn.stage = 'revealed';
    if (correct) tl.splice(i, 0, this.turn.song);

    // End of a round = the last player just finished.
    if (this.current === this.players.length - 1) {
      const counts = this.players.map(pl => pl.timeline.length);
      const max = Math.max(...counts);
      const leaders = this.players.filter(pl => pl.timeline.length === max);
      if (max >= WIN_CARDS && leaders.length === 1) this.finish('', leaders[0]);
    }
    return true;
  }

  advance() {
    this.current++;
    if (this.current >= this.players.length) { this.current = 0; this.round++; }
    this.newTurn();
  }

  finish(reason, winner) {
    this.phase = 'over';
    this.endReason = reason || '';
    if (winner) { this.winner = winner; return; }
    const max = Math.max(...this.players.map(p => p.timeline.length));
    const leaders = this.players.filter(p => p.timeline.length === max);
    this.winner = leaders.length === 1 ? leaders[0] : null; // null = tie
  }

  currentPlayer() { return this.players[this.current]; }

  // ---------- what each screen is allowed to see ----------
  publicTurn() {
    if (!this.turn || this.phase === 'lobby') return null;
    const t = this.turn;
    return {
      id: t.id,
      playerNum: this.currentPlayer() ? this.currentPlayer().num : null,
      stage: t.stage,
      placed: t.placed,
      placeIndex: t.placeIndex,
      correct: t.correct,
      // The song stays secret until the card is flipped (no peeking in the browser tools!)
      song: t.stage === 'revealed' ? card(t.song) : null,
    };
  }

  scoreboard() {
    return this.players.map(p => ({ num: p.num, cards: p.timeline.length }));
  }

  hostView(playerUrl, connected) {
    return {
      role: 'host',
      phase: this.phase,
      winCards: WIN_CARDS,
      songsTotal: this.songs.length,
      yearProgress: this.yearProgress,
      slot: this.phase === 'lobby' ? { num: this.players.length + 1, url: playerUrl(this.openSlot) } : null,
      players: this.scoreboard().map(p => ({ ...p, online: connected.has(this.players[p.num - 1].token) })),
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

  playerView(player) {
    return {
      role: 'player',
      phase: this.phase,
      winCards: WIN_CARDS,
      me: player.num,
      timeline: player.timeline.map(card),
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

