// ===================== HitsterWeb player screen =====================
import { $, sleep, makeCard, makeMystery, revealInto } from './common.js';
import { net, configured } from './net.js';

const q = new URLSearchParams(location.search);
const gid = q.get('g');
const token = q.get('t');
const root = 'games/' + gid;
const secretKey = 'hw_secret_' + token;
let secret = localStorage.getItem(secretKey);
if (!secret) {
  secret = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(secretKey, secret);
}

const tl = $('#timeline');
let state = null;
let pending = null;        // a state that arrived during an animation
let animating = false;
let lastKey = '';
let mystery = null;        // the face-down card element (only on my turn)
let mysteryTurn = null;
let myIndex = 0;
let dragging = false;
let lastY = 0;
const revealed = new Set();

function view(name) {
  for (const v of ['msg', 'lobby', 'game', 'over']) $('#v-' + v).classList.toggle('hidden', v !== name);
}
function message(text) { view('msg'); $('#msg').textContent = text; }
function border(color) {
  document.body.classList.remove('b-blue', 'b-green', 'b-red');
  if (color) document.body.classList.add('b-' + color);
}

// ---------------- joining ----------------
let pub, myCards = [], me = null, joinError = '', mergeTimer = null;

// The game state comes in three parts; combine them into one picture of the game.
function merge() {
  clearTimeout(mergeTimer);
  mergeTimer = setTimeout(() => {
    if (joinError) return message(joinError);
    if (pub === null) return message('This game is over. Ask the host for a new QR code.');
    if (!pub || me == null) return message('Joining…');
    const s = { ...pub, players: pub.players || [], me, timeline: myCards || [] };
    if (animating) { pending = s; return; }
    state = s;
    render();
  }, 40);
}

(async function join() {
  if (!configured) return message('This game is not set up yet (Firebase settings missing).');
  if (!gid || !token) return message('Scan the QR code on the host phone to join.');
  let ok = false;
  try { ok = await net.claim(`${root}/joins/${token}`, secret); }
  catch (e) { return message('Could not connect to the game. Check your internet connection.'); }
  if (!ok) return message('This QR code was already used by another phone. Ask the host for a new one.');
  net.presence(`${root}/presence/${token}`);
  net.on(`${root}/members/${token}`, v => {
    if (v === -1) joinError = 'This QR code is old. Scan the one on the host screen now.';
    else me = v;
    merge();
  });
  net.on(`${root}/public`, v => { pub = v; merge(); });
  net.on(`${root}/timelines/${token}`, v => { myCards = v || []; merge(); });
})();

// ---------------- drawing ----------------
function needsReveal(s) {
  const t = s.turn;
  return t && mystery && mysteryTurn === t.id && t.stage === 'revealed' && t.playerNum === s.me && !revealed.has(t.id);
}

function render() {
  const s = state;
  if (!s || s.phase === 'none') { border(null); return message('This game is over. Ask the host for a new QR code.'); }
  if (s.phase === 'lobby' || s.phase === 'playlist' || s.phase === 'years') {
    border(null); view('lobby'); $('#lobbyNum').textContent = 'Player ' + s.me; return;
  }
  if (s.phase === 'game' || needsReveal(s)) return renderGame(s);
  if (s.phase === 'over') {
    border(null); view('over');
    const won = s.winner === s.me;
    $('#overIcon').textContent = won ? '🏆' : s.winner ? '🎵' : '🤝';
    $('#overText').textContent = won ? 'You win!' : s.winner ? `Player ${s.winner} wins!` : "It's a tie!";
    $('#overSub').textContent = `You finished with ${s.timeline.length} cards. ${s.endReason || ''}`;
  }
}

function renderGame(s) {
  view('game');
  const t = s.turn;
  const mine = t.playerNum === s.me;
  $('#meText').textContent = 'Player ' + s.me;
  $('#countText').textContent = `${s.timeline.length} / ${s.winCards} cards`;

  let status = '';
  if (mine) {
    if (t.stage === 'ready') { border(null); status = "You're up! Get ready to listen 🎧"; }
    if (t.stage === 'playing') { border('blue'); status = 'Your turn — listen! 🎧'; }
    if (t.stage === 'placing') { border('green'); status = 'Drag the card ↕ into place, then flip it on the host phone'; }
    if (t.stage === 'revealed') { border(t.correct ? 'green' : 'red'); status = t.correct ? 'Correct! The card is yours 🎉' : 'Wrong year — the card is lost'; }
  } else {
    border(null);
    status = t.stage === 'placing' ? `Player ${t.playerNum} is placing a card…`
      : t.stage === 'revealed' ? `Player ${t.playerNum} was ${t.correct ? 'right ✓' : 'wrong ✗'}`
      : `Player ${t.playerNum}'s turn 🎧`;
  }
  $('#status').textContent = status;

  if (needsReveal(s)) return animateReveal(t);

  const withMystery = mine && t.stage === 'placing';
  const key = s.timeline.map(c => c.id).join(',') + (withMystery ? '|M' + t.id : '');
  if (key === lastKey) return;
  lastKey = key;

  if (withMystery && mysteryTurn !== t.id) { mysteryTurn = t.id; myIndex = t.placeIndex; sendPlace(); }
  if (!withMystery) { mystery = null; }
  build(s.timeline, withMystery);
}

function build(timeline, withMystery) {
  tl.innerHTML = '';
  sizeCards(timeline.length + (withMystery ? 1 : 0));
  timeline.forEach(song => tl.appendChild(makeCard(song)));
  if (withMystery) {
    mystery = makeMystery('drag ↕');
    attachDrag(mystery);
    myIndex = Math.max(0, Math.min(timeline.length, myIndex));
    tl.insertBefore(mystery, tl.children[myIndex] || null);
    mystery.classList.add('newcard');
    setTimeout(() => mystery && mystery.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
  }
}

function sizeCards(n) {
  const header = $('.pHeader').offsetHeight || 90;
  const avail = innerHeight - header - 50;
  const gap = 10;
  const s = Math.max(92, Math.min((avail - gap * (n - 1)) / Math.max(1, n), innerWidth * 0.62, 230));
  tl.style.setProperty('--s', Math.floor(s) + 'px');
}
addEventListener('resize', () => { if (state && state.phase === 'game') sizeCards(tl.children.length); });

// ---------------- flipping ----------------
async function animateReveal(t) {
  animating = true;
  revealed.add(t.id);
  const el = mystery;
  el.classList.remove('dragging');
  revealInto(el, t.song);
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(850);
  if (t.correct) {
    el.classList.add('good');
    await sleep(1800);
  } else {
    el.classList.add('bad');
    await sleep(800);
    el.classList.add('fade');            // fades away…
    await sleep(1350);
    el.style.height = el.offsetHeight + 'px';
    void el.offsetWidth;
    el.classList.add('collapse');        // …then the other cards close the gap
    await sleep(500);
    el.remove();
  }
  mystery = null;
  lastKey = '';
  animating = false;
  if (pending) { state = pending; pending = null; }
  render();
}

// ---------------- dragging (up/down only) ----------------
let placeTimer = null;
function sendPlace() {
  clearTimeout(placeTimer);
  const turnId = state && state.turn ? state.turn.id : null;
  placeTimer = setTimeout(() => net.set(`${root}/places/${token}`, { index: myIndex, turnId }), 120);
}

function canDrag() {
  return state && state.turn && state.turn.stage === 'placing' && state.turn.playerNum === state.me && !animating;
}

// Smoothly slides cards to their new spots when the order changes.
function flipMove(mutate) {
  const els = [...tl.children];
  const before = new Map(els.map(e => [e, e.getBoundingClientRect().top]));
  mutate();
  for (const e of els) {
    const dy = before.get(e) - e.getBoundingClientRect().top;
    if (!dy) continue;
    e.style.transition = 'none';
    e.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => { e.style.transition = 'transform .22s ease'; e.style.transform = ''; }));
  }
}

function reposition(y) {
  const others = [...tl.children].filter(c => c !== mystery);
  let idx = 0;
  for (const c of others) {
    const r = c.getBoundingClientRect();
    if (r.top + r.height / 2 < y) idx++;
  }
  if (idx !== myIndex) {
    myIndex = idx;
    flipMove(() => tl.insertBefore(mystery, others[idx] || null));
    if (navigator.vibrate) navigator.vibrate(8);
    sendPlace();
  }
}

function autoScroll() {
  if (!dragging) return;
  const top = ($('.pHeader').offsetHeight || 90) + 40;
  if (lastY < top) scrollBy(0, -12);
  else if (lastY > innerHeight - 60) scrollBy(0, 12);
  reposition(lastY);
  requestAnimationFrame(autoScroll);
}

function attachDrag(el) {
  el.addEventListener('pointerdown', e => {
    if (!canDrag()) return;
    e.preventDefault();
    dragging = true;
    lastY = e.clientY;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    requestAnimationFrame(autoScroll);
  });
  el.addEventListener('pointermove', e => { if (dragging) { lastY = e.clientY; reposition(lastY); } });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    sendPlace();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
