// Reads a playlist file and turns it into a list of songs.
// It understands:
//   - Exportify CSV files (Spotify)
//   - TuneMyMusic CSV / TXT files (YouTube Music, Apple Music and others)
//   - Apple Music / iTunes "Export Playlist" files (.txt and .xml)
//   - a plain text list with one "Artist - Song" per line
// Columns are found by their names, not their position, so other exports usually work too.

// Files from iTunes are often UTF-16; everything else is UTF-8.
export function decodeFile(buffer) {
  const b = new Uint8Array(buffer);
  let enc = 'utf-8';
  if (b[0] === 0xff && b[1] === 0xfe) enc = 'utf-16le';
  else if (b[0] === 0xfe && b[1] === 0xff) enc = 'utf-16be';
  else if (b.length > 4 && b[1] === 0 && b[3] === 0) enc = 'utf-16le';
  return new TextDecoder(enc).decode(b).replace(/^﻿/, '');
}

function parseCSV(text, delim = ',') {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') inQuotes = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(f => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows;
}

function findCol(headers, patterns) {
  for (const p of patterns) {
    const i = headers.findIndex(h => p.test(h));
    if (i !== -1) return i;
  }
  return -1;
}

function yearOf(s) {
  const m = String(s || '').match(/\b(18[9]\d|19\d\d|20\d\d)\b/);
  return m ? parseInt(m[1], 10) : null;
}

// Accepts milliseconds, seconds, or "3:45".
function durationMs(s) {
  s = String(s || '').trim();
  if (!s) return 0;
  if (s.includes(':')) {
    const parts = s.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    return parts.reduce((t, p) => t * 60 + p, 0) * 1000;
  }
  const n = parseFloat(s);
  if (!n) return 0;
  return Math.round(n < 10000 ? n * 1000 : n);
}

function splitArtists(raw, exportify) {
  if (raw.includes(';')) return raw.split(';').map(s => s.trim()).filter(Boolean);
  if (exportify) return [raw];
  const parts = raw.split(/\s*(?:,| & | feat\.? | ft\.? | featuring )\s*/i).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : [raw];
}

function makeSong(list, title, artistRaw, o = {}) {
  title = (title || '').trim();
  artistRaw = (artistRaw || '').trim().replace(/\s+-\s+Topic$/i, ''); // YouTube "Artist - Topic" channels
  if (!title || !artistRaw) return;
  const artists = splitArtists(artistRaw, o.exportify);
  const year = o.year || null;
  list.push({
    id: list.length, title, artist: artists.join(', '), artists,
    spotifyYear: year, year, durationMs: o.durationMs || 0, isrc: o.isrc || '', uri: o.uri || '',
  });
}

// ---- Apple Music / iTunes XML ----
function plistValue(node) {
  switch (node.tagName) {
    case 'dict': {
      const o = {};
      const kids = [...node.children];
      for (let i = 0; i + 1 < kids.length; i += 2) o[kids[i].textContent] = plistValue(kids[i + 1]);
      return o;
    }
    case 'array': return [...node.children].map(plistValue);
    case 'integer': case 'real': return Number(node.textContent);
    case 'true': return true;
    case 'false': return false;
    default: return node.textContent;
  }
}

function songsFromItunesXml(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const top = doc.querySelector('plist > dict');
  if (!top) throw new Error("This XML file isn't an Apple Music / iTunes playlist.");
  const lib = plistValue(top);
  const tracks = lib.Tracks || {};
  const playlists = (lib.Playlists || []).filter(p => Array.isArray(p['Playlist Items']) && !p.Master);
  // A playlist export holds one playlist; a whole-library export holds many, so take the biggest normal one.
  const pl = playlists.sort((a, b) => b['Playlist Items'].length - a['Playlist Items'].length)[0];
  const ids = pl ? pl['Playlist Items'].map(i => i['Track ID']) : Object.keys(tracks);
  const songs = [];
  for (const id of ids) {
    const t = tracks[id];
    if (!t) continue;
    makeSong(songs, t.Name, t.Artist || t['Album Artist'], { year: yearOf(t.Year || t['Release Date']), durationMs: t['Total Time'] || 0 });
  }
  return songs;
}

// ---- tables (CSV, tab-separated) and plain lists ----
function songsFromTable(text) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const count = ch => firstLine.split(ch).length - 1;
  const delim = count('\t') > 0 && count('\t') >= count(',') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows = parseCSV(text, delim);
  if (!rows.length) return [];
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const col = {
    title: findCol(headers, [/^track name$/, /track name/, /^name$/, /^title$/, /^song( name| title)?$/, /^track$/, /title/]),
    artist: findCol(headers, [/^artist name/, /^artists?$/, /^(?!album).*artist/, /^channel/]),
    year: findCol(headers, [/^year$/, /^release date$/, /album release date/, /release date/, /^released?$/, /release year/]),
    duration: findCol(headers, [/duration/, /^time$/, /^total time$/, /^length$/]),
    isrc: findCol(headers, [/isrc/]),
    uri: findCol(headers, [/^track uri$/, /uri/]),
  };
  const songs = [];
  if (col.title !== -1 && col.artist !== -1) {
    const exportify = headers.some(h => /^artist name\(s\)$/.test(h) || /^track uri$/.test(h));
    for (const r of rows.slice(1)) {
      makeSong(songs, r[col.title], r[col.artist], {
        exportify,
        year: col.year !== -1 ? yearOf(r[col.year]) : null,
        durationMs: col.duration !== -1 ? durationMs(r[col.duration]) : 0,
        isrc: col.isrc !== -1 ? (r[col.isrc] || '').trim() : '',
        uri: col.uri !== -1 ? (r[col.uri] || '').trim() : '',
      });
    }
    return songs;
  }
  // No header row: a plain list, one "Artist - Song" per line.
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().replace(/^\d+[.)]\s+/, '').match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) makeSong(songs, m[2], m[1], { year: yearOf((line.match(/\((\d{4})\)\s*$/) || [])[1]) });
  }
  return songs;
}

export function songsFromPlaylistFile(text) {
  const songs = /^\s*<\?xml|<plist/i.test(text.slice(0, 600)) ? songsFromItunesXml(text) : songsFromTable(text);
  if (!songs.length) throw new Error("Couldn't find any songs in this file. It needs a song name and an artist for each song.");
  return songs;
}

export { parseCSV };
