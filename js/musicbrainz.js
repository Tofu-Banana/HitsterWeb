// Finds the ORIGINAL release year of a song using MusicBrainz (free, open music database).
// Spotify often shows the year of a remaster or a "Greatest Hits" album, so we search
// MusicBrainz for the same song by the same artist and take the earliest year.
//
// MusicBrainz allows about 1 request per second, so we wait between requests,
// and every answer is remembered on this phone so a song is never looked up twice.

const CACHE_KEY = 'hw_mb_cache';
let cache = {};
try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { cache = {}; }
function saveCache() { try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch {} }

let lastRequest = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function mbGet(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = lastRequest + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 503 || res.status === 429) { await sleep(2000); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1500);
    }
  }
  return null;
}

const norm = s => (s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9\u0590-\u05ff\u0400-\u04ff]/g, '');

const EXTRA_WORDS = /(remaster|remastered|version|mono|stereo|edit|mix|live|anniversary|deluxe|single|from|feat|ft\.|bonus|demo|acoustic|re-?recorded|taylor's|official|video|audio|lyrics?|visuali[sz]er|\bhd\b|\bhq\b)/i;

export function cleanTitle(t) {
  let s = t;
  // "Song - 2011 Remaster" / "Song - Radio Edit"
  s = s.replace(/\s+[-–—]\s+(.*)$/, (m, rest) => (EXTRA_WORDS.test(rest) ? '' : m));
  // "Song (Remastered 2009)" / "Song [feat. X]"
  s = s.replace(/\s*[\(\[]([^\)\]]*)[\)\]]/g, (m, inner) => (EXTRA_WORDS.test(inner) ? '' : m));
  return s.trim() || t;
}

export function primaryArtist(a) {
  return a.split(/\s*(?:,|;| & | feat\.? | ft\.? | x | with )\s*/i)[0] || a;
}

const esc = s => s.replace(/["\\]/g, ' ');

function earliestYear(recordings, title, artist) {
  const nt = norm(title), na = norm(artist);
  let best = null;
  for (const r of recordings || []) {
    if (typeof r.score === 'number' && r.score < 70) continue;
    const rt = norm(r.title);
    if (!(rt === nt || rt.startsWith(nt) || nt.startsWith(rt))) continue;
    const credits = (r['artist-credit'] || []).map(c => norm(c.name || (c.artist && c.artist.name)));
    if (na && !credits.some(c => c && (c.includes(na) || na.includes(c)))) continue;
    const y = parseInt((r['first-release-date'] || '').slice(0, 4), 10);
    if (y && y > 1890 && (!best || y < best)) best = y;
  }
  return best;
}

async function lookupYear(song) {
  const title = cleanTitle(song.title);
  const artist = primaryArtist(song.artists[0] || song.artist);
  const key = norm(title) + '|' + norm(artist);
  if (key in cache) return cache[key];

  let year = null;
  const q = `recording:"${esc(title)}" AND artist:"${esc(artist)}"`;
  const data = await mbGet('https://musicbrainz.org/ws/2/recording?fmt=json&limit=40&query=' + encodeURIComponent(q));
  if (data) year = earliestYear(data.recordings, title, artist);

  if (!year && song.isrc) {
    const d2 = await mbGet('https://musicbrainz.org/ws/2/recording?fmt=json&limit=10&query=' + encodeURIComponent('isrc:' + song.isrc));
    if (d2) year = earliestYear(d2.recordings, title, '');
  }
  cache[key] = year;
  return year;
}

// Goes through all songs, fixes their year, and reports progress.
// shouldStop() lets the host press "Skip".
export async function fixYears(songs, onProgress, shouldStop) {
  let done = 0, failures = 0;
  for (const song of songs) {
    if (shouldStop()) break;
    try {
      const y = await lookupYear(song);
      song.mbYear = y;
      if (y && (!song.spotifyYear || y < song.spotifyYear)) song.year = y;
    } catch (e) {
      failures++;
      console.warn('MusicBrainz lookup failed for', song.title, '-', e.message);
      if (failures >= 5 && failures === done + 1) break; // MusicBrainz unreachable: stop trying
    }
    done++;
    onProgress(done, songs.length, song);
    if (done % 10 === 0) saveCache();
  }
  saveCache();
}
