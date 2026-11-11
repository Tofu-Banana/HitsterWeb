// ===================== HitsterWeb host screen =====================
// The host phone runs the whole game. It shares what the players may see through Firebase,
// and saves everything on the phone, so leaving the page (e.g. for Shortcuts) never loses the game.
import { $, sleep, esc, makeMystery, revealInto } from './common.js';
import { Game, card } from './game.js';
import { songsFromPlaylistFile, decodeFile } from './csv.js';
import { fixYears } from './musicbrainz.js';
import { qrSvg } from './qrcode.js';
import { net, configured } from './net.js';

const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const AndroidApp = window.HitsterAndroid || null; // exists only inside the HitsterWeb Host app

// How we control the music app: 'android' (host app), 'ios' (Shortcuts) or 'manual' (the host does it by hand)
const control = AndroidApp ? 'android' : isIOS ? 'ios' : 'manual';

const SITE = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, ''); // folder of this page
const HOME = SITE + (location.pathname.endsWith('index.html') ? 'index.html' : '');
const playerUrl = token => `${SITE}p.html?g=${game.id}&t=${token}`;

let game = null;
let online = new Set();
let listeners = [];
let clipRunning = false;
let flipCardTurn = null;
let endedTimer = null;
let yearRun = 0;

const SCREENS = ['config', 'ios', 'android', 'desktop', 'menu', 'playlist', 'years', 'fix', 'lobby', 'game', 'over'];
function show(name) {
  for (const s of SCREENS) $('#s-' + s).classList.toggle('hidden', s !== name);
  if (name !== 'game') $('#menuSheet').classList.add('hidden');
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
  for (const token of game.removed) u['members/' + token] = -2; // "you're out of this game"
  net.update('games/' + game.id, u).catch(e => console.error('Firebase:', e));
}

// Call after every change.
function commit() { save(); publish(); render(); }

function listen() {
  listeners.forEach(stop => stop());
  listeners = [];
  const root = 'games/' + game.id;

  // A phone scanned a QR code.
  listeners.push(net.on(root + '/joins', joins => {
    if (!game) return;
    let changed = false;
    for (const [token, v] of Object.entries(joins || {})) {
      if (game.players.some(p => p.token === token) || game.removed.includes(token)) continue;
      const r = game.join(token, v.secret);
      if (r.ok) changed = true;
      else net.set(`${root}/members/${token}`, -1); // old QR code
    }
    if (changed) commit();
  }));

  // The active player moved their card, confirmed it, named the song, traded a token, or took bets.
  listeners.push(net.on(root + '/acts', acts => {
    if (!game || game.phase !== 'game' || !acts) return;
    const p = game.currentPlayer();
    if (p && game.playerAct(p, acts[p.token])) commit();
  }));

  // A player tapped "Leave game".
  listeners.push(net.on(root + '/left', left => {
    if (!game || !left) return;
    let changed = false;
    for (const token of Object.keys(left)) if (game.removePlayer(token)) changed = true;
    if (changed) commit();
  }));

  // Which phones are connected (the green dots).
  listeners.push(net.on(root + '/presence', pres => {
    online = new Set(Object.keys(pres || {}));
    render();
  }));
}

// Leaves the current game completely. Players' phones then offer "Host your own game".
function exitGame() {
  if (game) net.remove('games/' + game.id).catch(() => {});
  game = null;
  localStorage.removeItem('hw_game');
  listeners.forEach(stop => stop()); listeners = [];
  showSetupOrMenu();
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

// ---------------- controlling the music app ----------------
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
    if (game && game.clipEnded(c.turnId)) commit();
  }
  // manual: the label tells the host what to do, and they tap "Song ended".
}

// ---------------- the year check ----------------
async function runYearCheck() {
  const run = ++yearRun;   // going Back and loading another playlist starts a new run and stops this one
  const g = game;
  g.yearProgress = { done: 0, total: g.songs.length, skip: false };
  render();
  const current = () => run === yearRun && game === g && g.phase === 'years';
  await fixYears(g.songs, done => { if (current()) { g.yearProgress.done = done; save(); render(); } },
    () => g.yearProgress.skip || !current())
    .catch(e => console.warn('Year check stopped:', e.message));
  if (current()) finishYears(g);
}

// Moves on after the check (or right away when the host taps Skip).
// Songs that still have no year go to a screen where the host types them in.
function finishYears(g) {
  if (game !== g || g.phase !== 'years') return;
  if (g.songs.some(s => !s.year)) { g.phase = 'fix'; return commit(); }
  openLobby(g);
}

function openLobby(g) {
  localStorage.setItem('hw_last_playlist', JSON.stringify({ source: g.source, songs: g.songs }));
  g.phase = 'lobby';
  g.makeSlot();
  commit();
}

function renderFix() {
  const list = $('#fixList');
  const missing = game.songs.filter(s => !s.year);
  if (list.dataset.game === game.id && list.children.length === missing.length) return;
  list.dataset.game = game.id;
  list.innerHTML = missing.map(s => `<label class="fixRow"><div><b>${esc(s.title)}</b><span>${esc(s.artist)}</span></div>
    <input type="number" inputmode="numeric" placeholder="Year" min="1900" max="2100" data-id="${s.id}"></label>`).join('');
}

// ---------------- playlist source (only changes the instructions and texts) ----------------
const EXPORT_LINKS = {
  'Spotify': ['https://exportify.net', 'Open Exportify'],
  'Apple Music': ['https://www.tunemymusic.com/transfer/apple-music-to-file', 'Open TuneMyMusic'],
  'YouTube Music': ['https://www.tunemymusic.com/transfer/youtube-music-to-file', 'Open TuneMyMusic'],
};
function setSource(name) {
  if (!EXPORT_LINKS[name]) name = 'Spotify';
  localStorage.setItem('hw_source', name);
  if (game) game.source = name;
  document.querySelectorAll('#sourceTabs .tab').forEach(t => t.classList.toggle('on', t.dataset.source === name));
  document.querySelectorAll('#s-playlist [data-for]').forEach(o => o.classList.toggle('hidden', o.dataset.for !== name));
  $('#exportLink').href = EXPORT_LINKS[name][0];
  $('#exportLink').textContent = EXPORT_LINKS[name][1];
}
document.querySelectorAll('#sourceTabs .tab').forEach(t => t.onclick = () => { setSource(t.dataset.source); save(); });

// ---------------- buttons ----------------
$('#startGame').onclick = () => {
  const old = localStorage.getItem('hw_last_gid');
  if (old) net.remove('games/' + old).catch(() => {}); // clean up the previous game
  game = new Game();
  localStorage.setItem('hw_last_gid', game.id);
  setSource(localStorage.getItem('hw_source') || 'Spotify');
  $('#playlistError').textContent = '';
  listen();
  commit();
};

$('#csvFile').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    game.songs = songsFromPlaylistFile(decodeFile(await file.arrayBuffer()));
  } catch (err) { $('#playlistError').textContent = err.message; return; }
  $('#playlistError').textContent = '';
  game.phase = 'years';
  commit();
  runYearCheck();
};
$('#useLast').onclick = () => {
  try {
    const last = JSON.parse(localStorage.getItem('hw_last_playlist'));
    game.songs = Array.isArray(last) ? last : last.songs;   // years were already fixed last time
    if (last.source) setSource(last.source);
  } catch { return; }
  openLobby(game);
};
$('#skipYears').onclick = () => { if (game) { game.yearProgress.skip = true; finishYears(game); } };
$('#fixDone').onclick = () => {
  const thisYear = new Date().getFullYear();
  const inputs = [...document.querySelectorAll('#fixList input')];
  for (const input of inputs) {
    const y = parseInt(input.value, 10);
    if (!(y >= 1900 && y <= thisYear)) {
      $('#fixError').textContent = 'Every song needs a year between 1900 and ' + thisYear + '.';
      input.focus();
      return;
    }
  }
  for (const input of inputs) game.songs.find(s => s.id === Number(input.dataset.id)).year = parseInt(input.value, 10);
  $('#fixError').textContent = '';
  openLobby(game);
};
$('#noMore').onclick = () => {
  const err = game.start();
  if (err) return alert(err);
  commit();
};

function startClip() {
  if (clipRunning || !game) return;
  const r = game.play();
  commit();
  if (r.error) return alert(r.error);
  if (r.clip) runClip(r.clip);
}
$('#playBtn').onclick = startClip;
$('#songEnded').onclick = () => { if (game && game.clipEnded()) commit(); };
$('#flipBtn').onclick = () => { if (game.flip()) commit(); };
$('#nextBtn').onclick = () => {
  if (!game) return;
  if (game.turn.stage === 'swapped') return startClip(); // new song, same player
  if (game.next()) commit();
};
$('#betChips').onclick = e => {
  const chip = e.target.closest('[data-num]');
  if (chip && game.cycleMark(Number(chip.dataset.num))) commit();
};

// Game menu: skip a turn, remove a player, end the game.
$('#menuBtn').onclick = () => { renderMenu(); $('#menuSheet').classList.remove('hidden'); };
$('#menuClose').onclick = () => $('#menuSheet').classList.add('hidden');
$('#menuSheet').onclick = e => { if (e.target.id === 'menuSheet') $('#menuSheet').classList.add('hidden'); };
$('#skipTurn').onclick = () => {
  if (clipRunning) return;
  $('#menuSheet').classList.add('hidden');
  if (game.skipTurn()) commit();
};
$('#overrideGuess').onclick = () => {
  $('#menuSheet').classList.add('hidden');
  if (game.overrideGuess()) commit();
};
$('#removeList').onclick = e => {
  const chip = e.target.closest('[data-token]');
  if (!chip || clipRunning) return;
  if (!confirm(`Remove Player ${chip.dataset.num} from the game?`)) return;
  $('#menuSheet').classList.add('hidden');
  if (game.removePlayer(chip.dataset.token)) commit();
};
$('#endGame').onclick = () => {
  if (!confirm('End the game now for everyone?')) return;
  $('#menuSheet').classList.add('hidden');
  game.finish('The host ended the game.');
  commit();
};
function renderMenu() {
  const o = $('#overrideGuess');
  o.classList.toggle('hidden', !game.canOverrideGuess());
  if (game.canOverrideGuess()) {
    const n = game.currentPlayer().num;
    o.textContent = game.turn.guessOk === true ? `Take back Player ${n}'s naming token` : `Give Player ${n} the naming token`;
  }
  $('#removeList').innerHTML = game.players.map(p =>
    `<span class="chip tap remove" data-token="${p.token}" data-num="${p.num}">✕ Player ${p.num}</span>`).join('');
}

// Back button on every screen before the game starts: one step back each time.
document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => {
  if (!game) return showSetupOrMenu();
  if (game.phase === 'playlist') {
    if (game.players.length && !confirm('Cancel this game? The players who joined will be dropped.')) return;
    return exitGame();
  }
  if (game.phase === 'years' || game.phase === 'fix' || game.phase === 'lobby') {
    yearRun++;               // stops a running year check
    game.phase = 'playlist'; // players who already joined stay in and wait
    game.openSlot = null;
    $('#playlistError').textContent = '';
    commit();
  }
});
$('#backMenu').onclick = exitGame;

// ---------------- drawing ----------------
const coins = n => `<span class="tokens">🪙${n}</span>`;

function render() {
  if (!game) return;
  const s = game.hostView(playerUrl, online);
  document.querySelectorAll('.srcName').forEach(e => e.textContent = s.source);

  if (s.phase === 'playlist') {
    show('playlist');
    $('#useLast').classList.toggle('hidden', !localStorage.getItem('hw_last_playlist'));
  } else if (s.phase === 'years') {
    show('years');
    const { done, total } = s.yearProgress;
    $('#yearBar').style.width = (total ? (100 * done / total) : 0) + '%';
    $('#yearText').textContent = `${done} / ${total} songs`;
  } else if (s.phase === 'fix') {
    show('fix');
    renderFix();
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
    $('#winnerText').textContent = s.winner ? `Player ${s.winner} wins!` : s.players.length ? "It's a tie!" : 'Game over';
    $('#overReason').textContent = s.endReason;
    $('#finalScores').innerHTML = s.players.map(p => `<span class="chip">Player ${p.num}: ${p.cards}</span>`).join('');
  }
}

function fmtTime(sec) { return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }

function renderGame(s) {
  show('game');
  const t = s.turn;
  $('#roundText').textContent = 'Round ' + s.round;
  $('#leftText').textContent = s.songsLeft != null ? `${s.songsLeft} songs left` : '';
  $('#turnTitle').textContent = `Player ${t.playerNum}'s turn`;
  $('#scores').innerHTML = s.players.map(p =>
    `<span class="chip ${p.num === t.playerNum ? 'active' : ''}"><span class="dot ${p.online ? '' : 'off'}"></span>P${p.num} · ${p.cards} ${coins(p.tokens)}</span>`).join('');
  if (!$('#menuSheet').classList.contains('hidden')) renderMenu();

  const play = $('#playBtn'), flip = $('#flipBtn'), label = $('#stageLabel'), ended = $('#songEnded');
  const next = $('#nextBtn'), bets = $('#betPanel');
  const shown = t.stage === 'revealed' || t.stage === 'bets' || t.stage === 'swapped';
  play.classList.toggle('playing', t.stage === 'playing');
  play.classList.toggle('hidden', t.stage !== 'ready' && t.stage !== 'playing');
  flip.classList.toggle('hidden', t.stage === 'ready' || t.stage === 'playing');
  flip.classList.toggle('mini', shown);
  next.classList.toggle('hidden', !shown);
  next.textContent = t.stage === 'bets' ? 'Done' : 'Next';
  bets.classList.toggle('hidden', t.stage !== 'bets');
  clearTimeout(endedTimer);
  ended.classList.add('hidden');

  // A fresh face-down card for this turn.
  if (t.stage !== 'ready' && t.stage !== 'playing' && flipCardTurn !== t.id) {
    flipCardTurn = t.id;
    flip.innerHTML = '';
    flip.appendChild(makeMystery('tap to flip', 'hostCard'));
  }
  const hostCard = flip.querySelector('.card');
  if (shown && hostCard && !hostCard.classList.contains('flipped') && t.song) revealInto(hostCard, t.song);
  if (hostCard) {
    hostCard.classList.toggle('good', shown && t.correct === true);
    hostCard.classList.toggle('bad', shown && t.correct === false);
  }

  if (t.stage === 'ready') {
    label.textContent = control === 'manual'
      ? `Press play — then start the next song in ${s.source} for Player ${t.playerNum}`
      : `Press play — Player ${t.playerNum} listens`;
  } else if (t.stage === 'playing') {
    const c = s.clip || {};
    if (control === 'manual') {
      label.innerHTML = `Press <b>next</b> in ${esc(s.source)}, jump to <b>${fmtTime(c.start || 0)}</b>, and play ${c.length || 30} seconds.`;
      ended.classList.remove('hidden');
    } else {
      label.textContent = `Player ${t.playerNum} is listening…`;
      // Safety net in case the clip doesn't report back (e.g. the page was reloaded).
      endedTimer = setTimeout(() => ended.classList.remove('hidden'), control === 'android' && clipRunning ? ((c.length || 30) + 5) * 1000 : 2500);
    }
  } else if (t.stage === 'placing') {
    flip.disabled = !t.confirmed;
    label.innerHTML = t.confirmed
      ? `<b>Bets are open!</b> Other players can leave a token on Player ${t.playerNum}'s phone.<br>When bets are over, tap the card to flip it.`
      : `Player ${t.playerNum} is placing the card…`;
  } else if (t.stage === 'revealed') {
    flip.disabled = true;
    label.innerHTML = `<div class="result ${t.correct ? 'good' : 'bad'}">${t.correct ? '✓ Correct!' : '✗ Wrong!'}</div>` +
      (t.guessOk ? `Player ${t.playerNum} named the song: +1 🪙<br>` : t.guessOk === false ? `No token for naming the song<br>` : '') +
      (t.bets.length && s.bettors.length ? 'Bets were placed — press Next to settle them' : '');
  } else if (t.stage === 'bets') {
    flip.disabled = true;
    const right = t.goodBets.length > 0 && !t.correct;
    label.innerHTML = `<b>Who bet?</b> Tap a name once if they bet (−1 🪙).` +
      (t.correct ? `<br>Player ${t.playerNum} was right, so nobody wins the card.`
        : right ? `<br>A token is on the <b>right spot</b>: tap its owner <b>twice</b> to give them the card.`
        : `<br>No token is on the right spot. (Tap twice if someone still won the card.)`);
    $('#betChips').innerHTML = s.players.filter(p => s.bettors.includes(p.num)).map(p => {
      const m = t.marks[p.num] || 0;
      return `<span class="chip tap m${m}" data-num="${p.num}">Player ${p.num}${m === 1 ? ' · bet −1 🪙' : m === 2 ? ' · won the card 🏆' : ''}</span>`;
    }).join('');
  } else if (t.stage === 'swapped') {
    flip.disabled = true;
    label.innerHTML = `Player ${t.playerNum} traded a token for a new song.<br>Press Next to play it.`;
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
    try { game = Game.from(saved); } catch { game = null; localStorage.removeItem('hw_game'); }
  }
  if (game) {
    setSource(game.source);
    listen();
    if (done) game.clipEnded(done);
    commit();
    if (game.phase === 'years') runYearCheck();
    if (fail) { $('#stageLabel').textContent = "The shortcut didn't finish. Tap \"Song ended\" when the song is done."; $('#songEnded').classList.remove('hidden'); }
  } else showSetupOrMenu();

  androidAccessBanner();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') androidAccessBanner(); });
})();
