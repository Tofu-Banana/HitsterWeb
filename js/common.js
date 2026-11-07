// Shared helpers for the host and player screens.
export const $ = (sel, root = document) => root.querySelector(sel);
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Each decade-ish gets its own color, like real music-timeline cards.
export function hueForYear(y) { return ((y || 2000) * 47) % 360; }

export function frontHTML(song) {
  return `<div class="face front" style="--h:${hueForYear(song.year)}">
    <div class="artist">${esc(song.artist)}</div>
    <div class="year">${esc(song.year)}</div>
    <div class="title">${esc(song.title)}</div>
  </div>`;
}
export function backHTML(hint) {
  return `<div class="face back"><div class="q">?</div>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</div>`;
}

// A face-up card (part of a timeline).
export function makeCard(song) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = song.id;
  el.innerHTML = `<div class="inner">${frontHTML(song)}</div>`;
  return el;
}

// A face-down card that can be flipped later.
export function makeMystery(hint, extraClass = 'mysteryCard') {
  const el = document.createElement('div');
  el.className = 'card ' + extraClass;
  el.innerHTML = `<div class="inner">${backHTML(hint)}<div class="face front"></div></div>`;
  return el;
}

export function revealInto(el, song) {
  const old = el.querySelector('.front');
  old.outerHTML = frontHTML(song);
  void el.offsetWidth;
  el.classList.add('flipped');
}

