# HitsterWeb

A party music game. Players join by scanning a QR code (nothing to install). The host plays song clips from Spotify, Apple Music or YouTube Music, and each player tries to place the song's card in the right spot on their timeline by year. The first player to end a round with **10 cards**, and more cards than everyone else, wins.

HitsterWeb is a website. **GitHub Pages** hosts it for free, and **Firebase** (also free) passes messages between the phones. There's no server to run on your computer.

---

## Setup (one time, about 10 minutes)

### 1. Create the Firebase database
1. Go to [console.firebase.google.com](https://console.firebase.google.com) and sign in with a Google account.
2. **Create a project**. Any name works, for example `hitsterweb`. You can turn Google Analytics off.
3. In the left menu: **Build → Realtime Database → Create Database**. Pick a location near you, then choose **Start in test mode**.
4. Open the **Rules** tab, replace everything with the contents of `database.rules.json`, and click **Publish**.
   (Test mode stops working after 30 days. These rules don't expire.)
5. Click the gear icon → **Project settings** → under "Your apps", click the **Web** icon `</>`. Give it any name and click **Register app** (skip hosting).
6. Firebase shows a `firebaseConfig = { ... }` block. Keep that page open for step 2.

### 2. Put the game on GitHub Pages
1. Create a free account at [github.com](https://github.com) if you don't have one.
2. Click **+ → New repository**. Name it `HitsterWeb`, make it **Public**, and click **Create repository**.
3. Click **uploading an existing file**. Drag in **everything in this folder** (including the `js` folder), then click **Commit changes**.
   *(Or with Git: `git init`, `git add .`, `git commit -m "HitsterWeb"`, `git remote add origin https://github.com/YOURNAME/HitsterWeb.git`, `git push -u origin main`.)*
4. In the repository, open `firebase-config.js` and click the pencil icon. Replace the placeholder values with the ones from Firebase step 6, then click **Commit changes**.
5. Go to **Settings → Pages**. Under "Branch", choose **main** and **/ (root)**, then click **Save**.
6. After about a minute, your game is live at **`https://YOURNAME.github.io/HitsterWeb/`**

### 3. Set up the host phone
**iPhone:** open your game link in Safari. The page detects the iPhone and shows how to make a shortcut named **HitsterWeb** in the Shortcuts app. It works with whichever music app is playing. It has 5 actions: Skip Forward → Seek (to Shortcut Input) → Play → Wait 30 seconds → Pause. Tap **Test the shortcut** to check it works. Tip: Share → **Add to Home Screen**.

**Android:** install the **HitsterWeb Host** app (see below), open it, and type your game link. Then turn on **Notification access** for it when the app asks. That's what lets it jump to the middle of each song.
If the switch is greyed out: Settings → Apps → HitsterWeb Host → ⋮ → **Allow restricted settings**.

---

## Playing
1. Open your game link on the host phone and tap **Start game**.
2. Pick where your playlist is: **Spotify**, **Apple Music** or **YouTube Music**. Follow the steps on screen to export it as a file, then tap **Upload playlist file**.
   - Spotify: Exportify (.csv).
   - Apple Music: on a computer, **File → Library → Export Playlist** (XML or Text). Or TuneMyMusic → Export to file.
   - YouTube Music: TuneMyMusic → Export to file (.csv).
   - A plain text file with one `Artist - Song` per line also works.

   The game then checks every song on MusicBrainz to find its original year. That takes about 1 second per song. If a year can't be found, the game asks you to type it. Results are saved on the phone, so **Use last playlist again** skips this whole step.
3. One QR code appears per player. Each time someone scans it, a new one appears for the next player. Tap **No more players** when everyone is in.
4. In your music app, open the same playlist, **turn shuffle off**, start the **first song**, and pause it. Song 1 becomes the first player's starting card. Each turn then skips to the next song.
5. Press the big play button. The current player hears a 30-second clip (blue border on their phone). When it ends, the border turns green. They drag the face-down card into their timeline and tap **Confirm placement**.
6. **Bets:** after the placement is confirmed, other players can tap a gap on the active player's phone to leave a token there (not on the spot the player chose).
7. Tap the card on the host phone to flip it. Right: the card stays. Wrong: the player loses it.
8. Press **Next**. If tokens were left, the host sees the other players' names: tap once for "bet" (loses a token), twice for "bet and won" (loses a token and gets the card), three times to reset. Then **Done**.

### Tokens
- Everyone starts with **2 tokens**.
- **Earn one:** before confirming, the active player can type the artist and the song name. If the song name is right and at least half of the artists are named, they get a token. Small typos are fine.
- **Bet:** costs a token, win or lose. A right bet steals the card when the active player was wrong.
- **New song:** before confirming, the active player can trade a token for a different song. The host sees the skipped card and presses **Next** to play the new one.

### Leaving and ending
- A player can tap **Leave game**. Their turn is skipped from then on.
- The host's **☰ Menu** has **Skip this turn**, **Remove a player** and **End game**.
- Anyone who is not in a game can open the game link and host their own. Several games can run at the same time.

The phones don't need to be on the same Wi-Fi. Any internet connection works.

---

## Building the Android host app
1. Install [Android Studio](https://developer.android.com/studio).
2. **Open** the `android` folder, and wait for it to finish syncing.
3. **Build → Build App Bundle(s) / APK(s) → Build APK(s)**. The APK ends up in `android/app/build/outputs/apk/`.
4. Optional: upload it to your repository as `HitsterWeb-Host.apk` (next to index.html). Android phones that open the game link in a browser will then get a **Download** button.

## Settings
- Cards to win: `WIN_CARDS` at the top of `js/game.js`.
- Clip length: `CLIP_SECONDS` in `js/game.js` (30 by default). On iPhone, also change the **Wait** action in the shortcut to the same number.

## Good to know
- **The game counts songs to know which one is playing.** It doesn't connect to the music service, so keep shuffle off, start from song 1, and don't skip songs by hand during the game. Songs that are unavailable (greyed out) can shift the count, and so can ads on a free account.
- **Clip start:** the app can't analyse the audio, so the clip starts about a third of the way into the song, which is usually the first chorus.
- **The host phone keeps the game.** If the page reloads, or Shortcuts reopens it, the game continues where it was.
- **The database is open to anyone who knows its address.** That's fine for a party game; nothing private is stored there, only card names and positions.
- **Free limits:** Firebase's free plan is far more than a party game needs.
