// Reads an Exportify CSV and turns it into a list of songs.
// Works with both Exportify versions (exportify.net and exportify.app),
// because it finds the columns by name instead of by position.

function parseCSV(text) {
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
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
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

function songsFromExportify(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('The file has no songs in it.');
  const headers = rows[0].map(h => h.trim().toLowerCase());
  const col = {
    title: findCol(headers, [/^track name$/, /track name/, /^name$/, /title/]),
    artist: findCol(headers, [/^artist name/, /^artists?$/, /^(?!album).*artist/]),
    release: findCol(headers, [/^release date$/, /album release date/, /release date/, /release/]),
    duration: findCol(headers, [/duration/]),
    isrc: findCol(headers, [/isrc/]),
    uri: findCol(headers, [/^track uri$/, /uri/]),
  };
  if (col.title === -1 || col.artist === -1) {
    throw new Error("This doesn't look like an Exportify file (no song or artist column found).");
  }
  const songs = [];
  for (const r of rows.slice(1)) {
    const title = (r[col.title] || '').trim();
    const artistRaw = (r[col.artist] || '').trim();
    if (!title || !artistRaw) continue;
    const artists = artistRaw.includes(';')
      ? artistRaw.split(';').map(s => s.trim()).filter(Boolean)
      : [artistRaw];
    const release = col.release !== -1 ? (r[col.release] || '') : '';
    const spotifyYear = parseInt(release.slice(0, 4), 10) || null;
    let durationMs = col.duration !== -1 ? parseInt(r[col.duration], 10) || 0 : 0;
    if (durationMs && durationMs < 1000) durationMs *= 1000; // seconds, just in case
    songs.push({
      id: songs.length,
      title,
      artist: artists.join(', '),
      artists,
      spotifyYear,
      year: spotifyYear,
      durationMs,
      isrc: col.isrc !== -1 ? (r[col.isrc] || '').trim() : '',
      uri: col.uri !== -1 ? (r[col.uri] || '').trim() : '',
    });
  }
  if (!songs.length) throw new Error('No songs found in the file.');
  return songs;
}

export { parseCSV, songsFromExportify };
