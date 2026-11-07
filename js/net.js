// The connection between the phones, through Firebase Realtime Database.
// Everything else in the game only uses the small `net` object below.
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, set, update, remove, onValue, runTransaction, onDisconnect,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from '../firebase-config.js';

export const configured = !!(firebaseConfig && firebaseConfig.databaseURL && !/YOUR_PROJECT/.test(firebaseConfig.databaseURL));

let db = null;
const d = () => (db ||= getDatabase(initializeApp(firebaseConfig)));

export const net = {
  set: (path, value) => set(ref(d(), path), value),
  update: (path, values) => update(ref(d(), path), values),
  remove: path => remove(ref(d(), path)),

  // Calls cb(value) now and every time the value changes. Returns a function to stop listening.
  on: (path, cb) => onValue(ref(d(), path), snap => cb(snap.val())),

  // Claims a spot (a QR code) for this phone. Returns true if it's ours.
  async claim(path, secret) {
    const res = await runTransaction(ref(d(), path), cur => {
      if (cur == null) return { secret, at: Date.now() };
      return cur.secret === secret ? cur : undefined; // undefined = someone else has it, don't change
    });
    const v = res.snapshot.val();
    return !!(v && v.secret === secret);
  },

  // Marks this phone as online, and automatically offline when it disconnects.
  presence(path) {
    onValue(ref(d(), '.info/connected'), snap => {
      if (snap.val() !== true) return;
      const r = ref(d(), path);
      onDisconnect(r).remove().then(() => set(r, true));
    });
  },
};
