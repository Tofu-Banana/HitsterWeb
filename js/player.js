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
let dragging = false;
let lastY = 0;
let leftGame = false;
const revealed = new Set();

// What I did this turn. The whole thing is sent to the host phone every time it changes.
let act = { turnId: null, index: 0, confirmed: false, bets: [] };

function view(name) {
  for (const v of ['msg', 'lobby', 'game', 'over']) $('#v-' + v).classList.toggle('hidden', v !== name);
}
function message(text, offerHosting = false) {
  view('msg');
  border(null);
  $('#msg').textContent = text;
  $('#hostOwn').classList.toggle('hidden', !offerHosting);
}
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
    if (leftGame) return message('You left the game.', true);
    if (joinError) return message(joinError, true);
    if (pub === null) return message('This game has ended.', true);
    if (me === -2) return message("You're no longer in this game.", true);
    if (!pub || me == null) return message('Joining…');
    const s = { ...pub, players: pub.players || [], me, timeline: myCards || [] };
    if (s.turn) s.turn = { bets: [], goodBets: [], ...s.turn };
    if (animating) { pending = s; return; }
    state = s;
    render();
  }, 40);
}

(async function join() {
  if (!configured) return message('This game is not set up yet (Firebase settings missing).');
  if (!gid || !token) return message('Scan the QR code on the host phone to join.', true);
  let ok = false;
  try { ok = await net.claim(`${root}/joins/${token}`, secret); }
  catch (e) { return message('Could not connect to the game. Check your internet connection.'); }
  if (!ok) return message('This QR code was already used by another phone. Ask the host for a new one.', true);
  net.presence(`${root}/presence/${token}`);
  net.on(`${root}/members/${token}`, v => {
    if (v === -1) joinError = 'This QR code is old. Scan the one on the host screen now.';
    else me = v;
    merge();
  });
  net.on(`${root}/public`, v => { pub = v; merge(); });
  net.on(`${root}/timelines/${token}`, v => { myCards = v || []; merge(); });
})();

// ---------------- sending my moves to the host ----------------
let actTimer = null;
function sendAct(now) {
  clearTimeout(actTimer);
  const go = () => net.set(`${root}/acts/${token}`, act);
  if (now) go(); else actTimer = setTimeout(go, 120);
}

const myTurn = s => s.turn && s.turn.playerNum === s.me;
const shownStage = t => t.stage === 'revealed' || t.stage === 'bets';

// ---------------- drawing ----------------
function needsReveal(s) {
  const t = s.turn;
  return t && mystery && act.turnId === t.id && shownStage(t) && myTurn(s) && !revealed.has(t.id);
}

function render() {
  const s = state;
  if (!s) return;
  if (s.phase === 'lobby' || s.phase === 'playlist' || s.phase === 'years' || s.phase === 'fix') {
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
  const mine = myTurn(s);
  const meRow = s.players.find(p => p.num === s.me) || { tokens: 0 };
  $('#meText').textContent = 'Player ' + s.me;
  $('#tokenText').textContent = '🪙 ' + meRow.tokens;
  $('#countText').textContent = `${s.timeline.length} / ${s.winCards} cards`;

  // A new turn of mine: start from what the host knows (this also survives a page reload).
  if (mine && t.stage === 'placing' && act.turnId !== t.id) {
    act = { turnId: t.id, index: t.placeIndex, confirmed: !!t.confirmed, bets: t.bets.slice() };
    $('#guessArtist').value = ''; $('#guessTitle').value = '';
    if (!t.placed) sendAct();
  }
  const confirmed = mine && t.stage === 'placing' && (act.confirmed || t.confirmed);

  let status = '';
  if (mine) {
    if (t.stage === 'ready') { border(null); status = "You're up! Get ready to listen 🎧"; }
    if (t.stage === 'playing') { border('blue'); status = 'Your turn — listen! 🎧'; }
    if (t.stage === 'placing') {
      border('green');
      status = confirmed ? 'Bets are open: others can tap a gap to leave a token 🪙. Then flip the card on the host phone.'
        : 'Drag the card ↕ into place, then confirm';
    }
    if (shownStage(t)) {
      border(t.correct ? 'green' : 'red');
      status = (t.correct ? 'Correct! The card is yours 🎉' : 'Wrong year — you lose the card') +
        (t.guessOk === true ? ' · You named it: +1 🪙' : t.guessOk === false ? ' · No token for the name' : '');
    }
    if (t.stage === 'swapped') { border('blue'); status = 'You traded a token — a new song is coming 🎧'; }
  } else {
    border(null);
    status = t.stage === 'placing' ? (t.confirmed ? `Bets are open! Leave a token 🪙 on Player ${t.playerNum}'s phone to bet` : `Player ${t.playerNum} is placing a card…`)
      : shownStage(t) ? `Player ${t.playerNum} was ${t.correct ? 'right ✓' : 'wrong ✗'}`
      : t.stage === 'swapped' ? `Player ${t.playerNum} traded a token for a new song`
      : `Player ${t.playerNum}'s turn 🎧`;
  }
  $('#status').textContent = status;

  // Footer buttons
  const placing = mine && t.stage === 'placing' && !confirmed;
  $('#guessRow').classList.toggle('hidden', !placing);
  $('#guessHint').classList.toggle('hidden', !placing);
  $('#confirmBtn').classList.toggle('hidden', !placing);
  $('#swapBtn').classList.toggle('hidden', !(placing && meRow.tokens > 0));
  $('#leaveBtn').classList.toggle('hidden', mine && t.stage === 'placing');
  tl.style.setProperty('--foot', ($('#footer').offsetHeight + 14) + 'px');

  if (needsReveal(s)) return animateReveal(t);

  // drag: I'm placing · bet: placement confirmed, others leave tokens · result: wrong answer, show how the bets did
  const mode = placing ? 'drag' : confirmed ? 'bet'
    : mine && shownStage(t) && !t.correct && t.bets.length ? 'result' : 'plain';
  const bets = mode === 'bet' ? act.bets : t.bets;
  const key = [s.timeline.map(c => c.id).join(','), mode, t.id, bets.join('.'), t.goodBets.join('.')].join('|');
  if (key === lastKey) return;
  const fresh = !lastKey.includes(`|${mode}|${t.id}|`);
  lastKey = key;
  build(s.timeline, mode, bets, t.goodBets, fresh);
}

function gapEl(i, mode, bets, goodBets) {
  const g = document.createElement('div');
  const has = bets.includes(i);
  g.className = 'gap' + (has ? ' bet' : '') + (mode === 'bet' ? ' open' : '');
  if (mode === 'result') g.classList.add(goodBets.includes(i) ? 'good' : 'bad');
  g.dataset.gap = i;
  g.textContent = has ? '🪙' : 'tap to bet here';
  return g;
}

function build(timeline, mode, bets, goodBets, fresh) {
  tl.innerHTML = '';
  mystery = null;
  const n = timeline.length;
  const gaps = mode === 'bet' ? n : mode === 'result' ? bets.length : 0;
  sizeCards(n + (mode === 'drag' || mode === 'bet' ? 1 : 0), gaps);
  if (mode === 'drag' || mode === 'bet') {
    mystery = makeMystery(mode === 'drag' ? 'drag ↕' : 'your pick');
    if (mode === 'drag') attachDrag(mystery); else mystery.classList.add('fixed');
    act.index = Math.max(0, Math.min(n, act.index));
  }
  for (let i = 0; i <= n; i++) {
    if (mystery && i === act.index) tl.appendChild(mystery);
    else if (mode === 'bet' || (mode === 'result' && bets.includes(i))) tl.appendChild(gapEl(i, mode, bets, goodBets));
    if (i < n) tl.appendChild(makeCard(timeline[i]));
  }
  if (mystery && fresh) {
    if (mode === 'drag') mystery.classList.add('newcard');
    setTimeout(() => mystery && mystery.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
  }
}

function sizeCards(n, gaps = 0) {
  const header = $('.pHeader').offsetHeight || 90;
  const footer = $('#footer').offsetHeight || 40;
  const gap = 10;
  const avail = innerHeight - header - footer - 30 - gaps * (34 + gap);
  const s = Math.max(92, Math.min((avail - gap * (n - 1)) / Math.max(1, n), innerWidth * 0.62, 230));
  tl.style.setProperty('--s', Math.floor(s) + 'px');
}
addEventListener('resize', () => { if (state && state.phase === 'game' && !animating) { lastKey = ''; render(); } });

// ---------------- buttons ----------------
$('#confirmBtn').onclick = () => {
  if (!state || !myTurn(state) || act.turnId !== state.turn.id) return;
  const artist = $('#guessArtist').value.trim(), title = $('#guessTitle').value.trim();
  if (artist || title) act.guess = { artist, title };
  act.confirmed = true;
  document.activeElement && document.activeElement.blur();
  sendAct(true);
  render();
};

$('#swapBtn').onclick = () => {
  if (!state || !myTurn(state) || act.turnId !== state.turn.id) return;
  if (!confirm('Trade 1 token for a new song?')) return;
  act.swap = true;
  sendAct(true);
};

$('#leaveBtn').onclick = () => {
  if (!confirm('Leave the game?')) return;
  leftGame = true;
  net.set(`${root}/left/${token}`, true);
  merge();
};

// Other players tap a gap on MY phone to leave (or take back) a token.
tl.addEventListener('click', e => {
  const g = e.target.closest('.gap.open');
  if (!g || !state || !myTurn(state) || !act.confirmed || state.turn.stage !== 'placing') return;
  const i = Number(g.dataset.gap);
  act.bets = act.bets.includes(i) ? act.bets.filter(b => b !== i) : [...act.bets, i].sort((a, b) => a - b);
  if (navigator.vibrate) navigator.vibrate(8);
  sendAct(true);
  render();
});

// ---------------- flipping ----------------
async function animateReveal(t) {
  animating = true;
  revealed.add(t.id);
  const el = mystery;
  el.classList.remove('dragging');
  // Show which tokens were on a right spot.
  tl.querySelectorAll('.gap').forEach(g => {
    g.classList.remove('open');
    if (g.classList.contains('bet')) g.classList.add(t.goodBets.includes(Number(g.dataset.gap)) ? 'good' : 'bad');
    else g.style.visibility = 'hidden';
  });
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
function canDrag() {
  return state && myTurn(state) && state.turn.stage === 'placing' && !act.confirmed && !animating;
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
  if (!mystery || !mystery.isConnected) return;
  const others = [...tl.children].filter(c => c !== mystery);
  let idx = 0;
  for (const c of others) {
    const r = c.getBoundingClientRect();
    if (r.top + r.height / 2 < y) idx++;
  }
  if (idx !== act.index) {
    act.index = idx;
    flipMove(() => tl.insertBefore(mystery, others[idx] || null));
    if (navigator.vibrate) navigator.vibrate(8);
    sendAct();
  }
}

function autoScroll() {
  if (!dragging) return;
  const top = ($('.pHeader').offsetHeight || 90) + 40;
  const bottom = innerHeight - ($('#footer').offsetHeight || 40) - 30;
  if (lastY < top) scrollBy(0, -12);
  else if (lastY > bottom) scrollBy(0, 12);
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
    sendAct();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
