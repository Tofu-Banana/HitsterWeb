// ===================== HitsterWeb host screen =====================
// The host phone runs the whole game. It shares what the players may see through Firebase,
// and saves everything on the phone, so leaving the page (e.g. for Shortcuts) never loses the game.
import { $, sleep, makeMystery, revealInto } from './common.js';
import { Game, card } from './game.js';
import { songsFromExportify } from './csv.js';
import { fixYears } from './musicbrainz.js';
import { qrSvg } from './qrcode.js';
import { net, configured } from './net.js';

const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const AndroidApp = window.HitsterAndroid || null; // exists only inside the HitsterWeb Host app

// How we control Spotify: 'android' (host app), 'ios' (Shortcuts) or 'manual' (the host does it by hand)
const control = AndroidApp ? 'android' : isIOS ? 'ios' : 'manual';

const SITE = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, ''); // folder of this page
const HOME = SITE + (location.pathname.endsWith('index.html') ? 'index.html' : '');
const playerUrl = token => `${SITE}p.html?g=${game.id}&t=${token}`;

let game = null;
let online = new Set();
let listeners = [];
let lastPhase = null;
let overTimer = null;
let clipRunning = false;
let flipCardTurn = null;
let endedTimer = null;
let yearsRunning = false;

const SCREENS = ['config', 'ios', 'android', 'desktop', 'menu', 'playlist', 'years', 'lobby', 'game', 'over'];
function show(name) {
  for (const s of SCREENS) $('#s-' + s).classList.toggle('hidden', s !== name);
}

// ---------------- saving & sharing ----------------
function save() {
  if (game) localStorage.setItem('hw_game', JSON.stringify(game));
}

function publish() {
  if (!game) return;
  const u = { public: game.publicView() };
  for (const p of game.players) {
    u['timelines/' + p.token] = p.timeline.map(card);
    u['members/' + p.token] = p.num;
  }
  net.update('games/' + game.id, u).catch(e => console.error('Firebase:', e));
}

// Call after every change.
function commit() { save(); publish(); render(); }

function listen() {
  listeners.forEach(stop => stop());
  const root = 'games/' + game.id;

  // A phone scanned a QR code.
  listeners.push(net.on(root + '/joins', joins => {
    let changed = false;
    for (const [token, v] of Object.entries(joins || {})) {
      if (game.players.some(p => p.token === token)) continue;
      const r = game.join(token, v.secret);
      if (r.ok) changed = true;
      else net.set(`${root}/members/${token}`, -1); // old QR code
    }
    if (changed) commit();
  }));

  // The current player moved their card.
  listeners.push(net.on(root + '/places', places => {
    if (!game || game.phase !== 'game' || !game.turn || game.turn.stage !== 'placing') return;
    const p = game.currentPlayer();
    const mine = places && places[p.token];
    if (!mine || mine.turnId !== game.turn.id) return;
    if (game.turn.placed && mine.index === game.turn.placeIndex) return;
    if (game.place(p, mine.index)) commit();
  }));

  // Which phones are connected (the green dots).
  listeners.push(net.on(root + '/presence', pres => {
    online = new Set(Object.keys(pres || {}));
    render();
  }));
}

// ---------------- setup: which phone is this? ----------------
async function showSetupOrMenu() {
  if (!configured) return show('config');
  if (AndroidApp) return show('menu');
  if (isIOS) return show(localStorage.getItem('hw_ios_ready') ? 'menu' : 'ios');
  if (localStorage.getItem('hw_manual')) return show('menu');
  if (isAndroid) {
    show('android');
    const r = await fetch('HitsterWeb-Host.apk', { method: 'HEAD' }).catch(() => null);
    $('#apkLink').classList.toggle('hidden', !(r && r.ok));
    $('#apkMissing').classList.toggle('hidden', !!(r && r.ok));
    return;
  }
  show('desktop');
  $('#hostUrl').textContent = HOME;
  $('#hostQr').innerHTML = qrSvg(HOME);
}

document.querySelectorAll('[data-manual]').forEach(b => b.onclick = () => { localStorage.setItem('hw_manual', '1'); show('menu'); });
$('#iosDone').onclick = () => { localStorage.setItem('hw_ios_ready', '1'); show('menu'); };
$('#iosTest').onclick = () => runShortcut('30', HOME + '?test=ok', HOME + '?test=fail');
$('#redoSetup').onclick = () => {
  localStorage.removeItem('hw_ios_ready'); localStorage.removeItem('hw_manual');
  if (AndroidApp && AndroidApp.openAccessSettings) AndroidApp.openAccessSettings(); else showSetupOrMenu();
};

// Android app: media control needs "Notification access" so we can also jump to the chorus.
function androidAccessBanner() {
  if (!AndroidApp || !AndroidApp.hasMediaAccess) return;
  if (AndroidApp.hasMediaAccess()) { const b = $('#accessBanner'); if (b) b.remove(); return; }
  if ($('#accessBanner')) return;
  const p = document.createElement('div');
  p.id = 'accessBanner'; p.className = 'panel'; p.style.textAlign = 'center';
  p.innerHTML = `<p>To jump straight to the best part of each song, allow <b>HitsterWeb Host</b> in <b>Notification access</b>.</p>
    <p class="muted" style="font-size:14px">If the switch is greyed out: open Settings → Apps → HitsterWeb Host → ⋮ (top right) → <b>Allow restricted settings</b>, then try again.</p>
    <p><button class="btn small">Open settings</button></p>`;
  p.querySelector('button').onclick = () => AndroidApp.openAccessSettings();
  $('#s-menu').appendChild(p);
}

// ---------------- controlling Spotify ----------------
function runShortcut(text, back, fail) {
  const e = encodeURIComponent;
  location.href = `shortcuts://x-callback-url/run-shortcut?name=HitsterWeb&input=text&text=${e(text)}` +
    `&x-success=${e(back)}&x-cancel=${e(fail)}&x-error=${e(fail)}`;
}

async function runClip(c) {
  if (control === 'ios') {
    // The shortcut skips to the next song, jumps to the chorus (the number we send), plays 30 s,
    // pauses, and then opens this page again.
    runShortcut(String(c.start), `${HOME}?clipdone=${c.turnId}`, `${HOME}?clipfail=${c.turnId}`);
    return;
  }
  if (control === 'android') {
    clipRunning = true;
    try {
      for (let i = 0; i < c.nexts; i++) { AndroidApp.command('next'); await sleep(600); }
      AndroidApp.command('seek:' + c.start * 1000);
      await sleep(250);
      AndroidApp.command('play');
      await sleep(c.length * 1000);
      AndroidApp.command('pause');
    } finally { clipRunning = false; }
    if (game.clipEnded(c.turnId)) commit();
  }
  // manual: the label tells the host what to do, and they tap "Song ended".
}

// ---------------- the year check ----------------
async function runYearCheck() {
  if (yearsRunning) return;
  yearsRunning = true;
  const g = game;
  g.yearProgress = { done: 0, total: g.songs.length, skip: false };
  render();
  await fixYears(g.songs, done => { g.yearProgress.done = done; if (game === g && g.phase === 'years') { save(); render(); } },
    () => g.yearProgress.skip || game !== g || g.phase !== 'years')
    .catch(e => console.warn('Year check stopped:', e.message));
  yearsRunning = false;
  finishYears(g);
}

// Moves on to the QR codes (when the check is done, or right away when the host taps Skip).
function finishYears(g) {
  if (game !== g || g.phase !== 'years') return;
  localStorage.setItem('hw_last_playlist', JSON.stringify(g.songs));
  g.phase = 'lobby';
  g.makeSlot();
  commit();
}

// ---------------- buttons ----------------
$('#startGame').onclick = () => {
  const old = localStorage.getItem('hw_last_gid');
  if (old) net.remove('games/' + old).catch(() => {}); // clean up the previous game
  game = new Game();
  localStorage.setItem('hw_last_gid', game.id);
  lastPhase = null;
  $('#useLast').classList.toggle('hidden', !localStorage.getItem('hw_last_playlist'));
  $('#playlistError').textContent = '';
  listen();
  commit();
};

$('#csvFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    game.songs = songsFromExportify(await file.text());
  } catch (err) { $('#playlistError').textContent = err.message; return; }
  $('#playlistError').textContent = '';
  game.phase = 'years';
  commit();
  runYearCheck();
};
$('#useLast').onclick = () => {
  try { game.songs = JSON.parse(localStorage.getItem('hw_last_playlist')); } catch { return; }
  game.phase = 'lobby';   // years were already fixed last time
  game.makeSlot();
  commit();
};
$('#skipYears').onclick = () => { if (game) { game.yearProgress.skip = true; finishYears(game); } };
$('#noMore').onclick = () => {
  const err = game.start();
  if (err) return alert(err);
  commit();
};
$('#playBtn').onclick = () => {
  if (clipRunning || !game) return;
  const r = game.play();
  commit();
  if (r.error) return alert(r.error);
  if (r.clip) runClip(r.clip);
};
$('#songEnded').onclick = () => { if (game && game.clipEnded()) commit(); };
$('#flipBtn').onclick = () => {
  if (!game.turn.placed) { $('#stageLabel').textContent = 'The player has not placed the card yet.'; return; }
  if (game.flip()) commit();
};
$('#backMenu').onclick = () => {
  game = null;
  localStorage.removeItem('hw_game');
  listeners.forEach(stop => stop()); listeners = [];
  showSetupOrMenu();
};

// ---------------- drawing ----------------
function render() {
  if (!game) return;
  const s = game.hostView(playerUrl, online);
  // Show the last flipped card for a few seconds before the winner screen.
  if (s.phase === 'over' && lastPhase === 'game' && !overTimer) {
    overTimer = setTimeout(() => { overTimer = null; lastPhase = 'over'; render(); }, 3500);
  }
  if (overTimer) return renderGame(s);
  lastPhase = s.phase;

  if (s.phase === 'playlist') {
    show('playlist');
    $('#useLast').classList.toggle('hidden', !localStorage.getItem('hw_last_playlist'));
  }
  else if (s.phase === 'years') {
    show('years');
    const { done, total } = s.yearProgress;
    $('#yearBar').style.width = (total ? (100 * done / total) : 0) + '%';
    $('#yearText').textContent = `${done} / ${total} songs`;
  } else if (s.phase === 'lobby') {
    show('lobby');
    $('#slotTitle').textContent = 'Player ' + s.slot.num;
    const box = $('#slotQr');
    if (box.dataset.url !== s.slot.url) { box.dataset.url = s.slot.url; box.innerHTML = qrSvg(s.slot.url); }
    $('#joined').innerHTML = s.players.map(p => `<span class="chip"><span class="dot ${p.online ? '' : 'off'}"></span>Player ${p.num}</span>`).join('');
    $('#noMore').disabled = s.players.length === 0;
  } else if (s.phase === 'game') renderGame(s);
  else if (s.phase === 'over') {
    show('over');
    $('#winnerText').textContent = s.winner ? `Player ${s.winner} wins!` : "It's a tie!";
    $('#overReason').textContent = s.endReason;
    $('#finalScores').innerHTML = s.players.map(p => `<span class="chip">Player ${p.num}: ${p.cards}</span>`).join('');
  }
}

function fmtTime(sec) { return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }

function renderGame(s) {
  show('game');
  const t = s.turn;
  const idx = s.players.findIndex(p => p.num === t.playerNum);
  const nextNum = s.players[(idx + 1) % s.players.length].num;
  $('#roundText').textContent = 'Round ' + s.round;
  $('#leftText').textContent = s.songsLeft != null ? `${s.songsLeft} songs left` : '';
  $('#turnTitle').textContent = `Player ${t.playerNum}'s turn`;
  $('#scores').innerHTML = s.players.map(p =>
    `<span class="chip ${p.num === t.playerNum ? 'active' : ''}"><span class="dot ${p.online ? '' : 'off'}"></span>P${p.num} · ${p.cards}</span>`).join('');

  const play = $('#playBtn'), flip = $('#flipBtn'), label = $('#stageLabel'), ended = $('#songEnded');
  play.classList.toggle('playing', t.stage === 'playing');
  play.classList.toggle('mini', t.stage === 'revealed');
  play.classList.toggle('hidden', t.stage === 'placing' || s.phase === 'over');
  flip.classList.toggle('hidden', t.stage === 'ready' || t.stage === 'playing');
  flip.classList.toggle('mini', t.stage === 'revealed');
  clearTimeout(endedTimer);
  ended.classList.add('hidden');

  // A fresh face-down card for this turn.
  if ((t.stage === 'placing' || t.stage === 'revealed') && flipCardTurn !== t.id) {
    flipCardTurn = t.id;
    flip.innerHTML = '';
    flip.appendChild(makeMystery('tap to flip', 'hostCard'));
  }
  const hostCard = flip.querySelector('.card');

  if (t.stage === 'ready') {
    label.textContent = control === 'manual'
      ? `Press play — then start the song in Spotify for Player ${t.playerNum}`
      : `Press play — Player ${t.playerNum} listens`;
  } else if (t.stage === 'playing') {
    const c = s.clip || {};
    if (control === 'manual') {
      label.innerHTML = `Press <b>next</b> in Spotify, jump to <b>${fmtTime(c.start || 0)}</b>, and play ${c.length || 30} seconds.`;
      ended.classList.remove('hidden');
    } else {
      label.textContent = `Player ${t.playerNum} is listening…`;
      // Safety net in case the clip doesn't report back (e.g. the page was reloaded).
      endedTimer = setTimeout(() => ended.classList.remove('hidden'), control === 'android' && clipRunning ? ((c.length || 30) + 5) * 1000 : 2500);
    }
  } else if (t.stage === 'placing') {
    flip.disabled = !t.placed;
    label.textContent = t.placed
      ? `Player ${t.playerNum}: when you're sure, tap the card to flip it!`
      : `Player ${t.playerNum} is placing the card…`;
  } else if (t.stage === 'revealed') {
    flip.disabled = true;
    if (hostCard && !hostCard.classList.contains('flipped') && t.song) revealInto(hostCard, t.song);
    hostCard && hostCard.classList.toggle('good', t.correct);
    hostCard && hostCard.classList.toggle('bad', !t.correct);
    label.innerHTML = `<div class="result ${t.correct ? 'good' : 'bad'}">${t.correct ? '✓ Correct!' : '✗ Wrong!'}</div>` +
      (s.phase === 'over' ? '' : `Next: Player ${nextNum} — press play`);
  }
}

// ---------------- start ----------------
(function boot() {
  const q = new URLSearchParams(location.search);
  if (q.has('test')) {
    show('ios');
    $('#iosTestResult').textContent = q.get('test') === 'ok' ? '✓ The shortcut worked!' : '✗ The shortcut failed. Check the name is exactly "HitsterWeb" and the steps.';
    history.replaceState(null, '', HOME);
    return;
  }
  const done = q.get('clipdone'), fail = q.get('clipfail');
  if (done || fail) history.replaceState(null, '', HOME);

  // Continue a saved game (for example when Shortcuts brings us back to this page).
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('hw_game')); } catch {}
  if (configured && saved) {
    game = Game.from(saved);
    lastPhase = game.phase;
    listen();
    if (done) game.clipEnded(done);
    commit();
    if (game.phase === 'years') runYearCheck();
    if (fail) { $('#stageLabel').textContent = "The shortcut didn't finish. Tap \"Song ended\" when the song is done."; $('#songEnded').classList.remove('hidden'); }
  } else showSetupOrMenu();

  androidAccessBanner();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') androidAccessBanner(); });
})();
