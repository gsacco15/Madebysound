# madebysound

Every song sculpts its own liquid-glass music note.

Apple's Music rebrand was "made by sound": one composition, played into a bath of mineral oil, shaped
one logo. madebysound runs that process for every song. It listens to the whole track, turns what it
hears into a set of numbers (the note's DNA), and grows a glass ♫ from them. The same song always makes
the same note, so notes can be collected. While the song plays the glass moves with it, and every note
you hear drops a ripple across the bath in that pitch's color.

## Try it

```sh
npm start          # serves the app at http://localhost:5173
npm test           # analysis + DNA unit tests (Node 22+)
```

No build step and no dependencies: plain ES modules, WebGL 2 and Web Audio. Open a song (MP3, M4A,
WAV, FLAC, OGG), drop one on the page, play one of the three demos, or press Listen to use the
microphone. On iPhone, open it in Safari and use Share → Add to Home Screen for a full-screen app.

### Hosting on Vercel

The app is static files with no build step, so Vercel serves it as is. In Vercel, **Add New → Project**,
import `gsacco15/Madebysound`, leave the framework preset on **Other** with no build command, and deploy.
Every push to `main` redeploys. `vercel.json` allows the microphone, wake lock and full screen;
`.vercelignore` leaves tests and scripts out of the deployment. A real HTTPS address is what AR Quick Look,
the microphone and Spotify sign-in need. GitHub Actions runs the tests on every push (`.github/workflows/ci.yml`).

## How a song becomes a note

`js/analysis.js` reads the whole track (up to 8 minutes) at 22 kHz with a 2048-point FFT and a 512-sample
hop. `js/dna.js` maps the result to shape and material:

| What it hears | How it's measured | What it shapes |
| --- | --- | --- |
| Key | Chroma from sustained spectral peaks, matched to Krumhansl–Kessler profiles | Glass color: keys sit on the circle of fifths, so related keys get neighboring hues. Major tilts the beam up, minor tilts it down |
| Tempo | Autocorrelation of the onset curve, scored over beat, two beats and bar | Ripple spacing and the idle breathing pulse. 128 BPM and up gets a second beam |
| Low end | Share of energy below 250 Hz | Weight of the note heads |
| Attack | Onsets per second (spectral flux peaks) | How liquid the joins are: legato melts together, busy music stays crisp |
| Brightness | Spectral centroid | Stem height and how far light splits (dispersion) |
| Dynamics | Loudness spread, 95th vs 10th percentile | Depth of the frozen ripples in the glass |
| Loudness over time | 32-point envelope | Engraved along the stems: first half left, second half right. The scrubber shows the same shape |
| Second-strongest pitch | Chroma | The color of one of the studio lights |

The DNA ID (for example `No. A012·F889`) is a hash of coarsely rounded features, so small floating-point
differences between browsers don't change a song's note.

While a song plays, `js/audio-engine.js` listens live: bass swells the heads, mids send waves through the
glass, highs shimmer on the surface and ripple the beam, beats pulse the whole form, and each detected
onset takes its pitch class from the spectrum and drops a colored ripple from that pitch's place around
the bath.

## What's in the app

- **Two views** (`js/shader.js`), both shaped by the same DNA. Drag to turn or tilt, scroll or pinch to
  zoom, double-click to reset.
  - *Tile* (default): looking straight down through a glass tile that rests above a shallow bath of oil,
    at the white note lying on the bath's floor, the way the physical piece was filmed. The note never
    moves; sound moves the oil. Bass pumps rings from a transducer under the middle, the song's two
    strongest pitches sound from their places on the pitch wheel around the rim and their waves
    interfere, each note you hear sends a ring across from its own place, and highs shimmer. The glass's
    rounded rim acts as a lens that draws the note out toward the edges, and each wavelength bends a
    little differently, so edges split into blue, cyan, amber and red.
  - *Sculpture*: the note as free-standing raymarched glass with refraction, dispersion, thin-film
    iridescence and a rippling oil bath.
- **How it was made**: the readout above, the loudness curve, band energy and the pitch-color wheel.
- **Generate**: while a song is analysed the glass goes molten and ripples form; it then sets into the
  new note with a soft chime on the song's own tonic chord.
- **Song tags**: title, artist, genre and cover art are read from MP3 (ID3v2), M4A, FLAC and WAV files.
- **Studio**: five materials (clear, frosted, song tint, liquid metal, neon edge), six scenes (oil bath,
  studio, dusk, void, neon club, and *Making of*, which shows the Tile view as the physical rig: a thick
  glass dish in glossy black oil, the note as milky liquid that wets the glass where it comes close, and
  the transducer showing through the gap under the beam), glass color from the key, the album art or your own hue, sound
  influence, ripples, slow turn, beat haptics (where the browser supports vibration) and ambient mode
  (full screen, nothing but the note, screen kept awake).
- **Collection**: keep notes in this browser (features plus a thumbnail; the DNA is rebuilt on load).
  Favorite them and filter by favorites, energy or genre; sort by newest, energy, tempo or color.
- **Share menu**:
  - *View in AR* on iPhone and iPad: AR Quick Look stands the note on your desk, about 20 cm tall.
  - *Note card*: a 1080×1350 PNG with title, key, tempo, ID and loudness signature.
  - *Wallpaper*: a PNG at your screen's native resolution, with the note clear of the lock-screen clock.
  - *Video clip*: 8 seconds of the note playing, with sound.
  - *3D model* (.glb with glass material extensions) and *AR model* (.usdz).
  - *Copy share link*: the note's features in the URL, so anyone can open the same glass without the audio.
- **Listen**: drive the glass from the microphone, then capture 12 seconds to make a note from it.
- **Spotify** (optional, see below): shows what you're playing and colors the glass from its cover.

Live levels run through critically damped springs, so the glass has weight and never jitters. A soft glow
blooms from the brightest light (white, the rim and colour fringes), drawn by blurring the frame's
highlights at several sizes; cards, wallpapers and clips get it too. Outside the tile the oil is a real
glossy surface: its rings, ripples and swells have no colour of their own and show only through the
light they reflect, as in the filmed rig. In the Tile view the moving oil also casts caustics: wherever the sound ripples its surface, the ripple focuses light into a band across the note. The black floor absorbs that light, so it stays clean. Big hits,
beats that land well above the recent loudness like a drop after a quiet build, send a shockwave across
the oil, flash light through the glass and swell the glow. Rendering resolution adapts to keep the frame
rate up on phones.

### 3D export

`js/note-geometry.js` holds the note's distance field in JavaScript, mirroring the shader with the music at
rest. `js/mesh.js` meshes it with surface nets (one vertex per surface cell, snapped onto the surface;
normals from the field's gradient), and `js/export3d.js` writes binary glTF and USDZ (a USDA layer in a
stored, 64-byte-aligned zip). Meshing runs in a Web Worker. The output passes the Khronos glTF validator and
OpenUSD's validators, including the USDZ package checks; the tests check that meshes are closed and
outward-facing.

## Spotify

Spotify streams are copy-protected, and since late 2024 new Spotify apps can't use audio analysis, audio
features or 30-second previews. So Spotify can't shape a note. What it can do is say what you're playing:
madebysound shows the title, artist and cover, colors the glass from the cover, and listens through the
microphone so the glass moves with the song. *Make a note* then captures 12 seconds and keeps it under
the Spotify track's name.

1. Create an app at <https://developer.spotify.com/dashboard> with the **Web API**.
2. Add redirect URIs that match where you run the app exactly. At the site root that is the bare origin
   with no trailing slash: `https://madebysound.vercel.app`, and for local runs `http://127.0.0.1:5173`
   (Spotify accepts plain `http` only for `127.0.0.1`, not `localhost`).
3. Put the app's **Client ID** in `SPOTIFY_CLIENT_ID` in `js/spotify.js`. Sign-in uses PKCE, so the Client
   Secret is never needed and must not go in the code.

The app's Client ID is already set. While the Spotify app is in development mode, only its owner and the
people added under **User Management** in the Spotify dashboard can connect.

## Project layout

```
index.html            app shell
css/app.css           styles
js/main.js            UI, render loop, wiring
js/analysis.js        full-track feature extraction (pure, Node-testable)
js/dna.js             features → note DNA, readout text
js/renderer.js        WebGL 2 host: DNA → uniforms, morphing, snapshots
js/shader.js          the glass note and the bath, in GLSL
js/audio-engine.js    playback, microphone, live bands, beats and note pitches
js/demos.js           three demo songs composed in code
js/demo-features.js   their measured features (generated)
js/collection.js      kept notes in localStorage
js/exporter.js        cards, clips, saving files
js/note-geometry.js   note layout and its distance field, shared by shader host and exporter
js/mesh.js            surface-nets mesher
js/export3d.js        GLB, USDZ and zip writers
js/model-worker.js    meshing off the main thread
js/tags.js            ID3v2, MP4, FLAC and WAV tag reader
js/palette.js         glass colors from album art
js/share.js           share-link encoding
js/spotify.js         Spotify now playing (PKCE)
scripts/              icon and demo-feature generators, artifact build
tests/                node:test suites with synthetic signals
```

`scripts/measure-demos.mjs` and `scripts/make-icons.mjs` need Playwright (`npm i -D playwright`) and the
app running on port 5173.

## Where it could go next

- **Native iOS.** SwiftUI shell, the same SDF in a Metal fragment shader, AVAudioEngine taps plus
  Accelerate (vDSP) for the FFT. The DNA mapping ports over as is, and the existing tests pin its behavior.
- **Apple Music previews.** The Apple Music API exposes a 30-second preview clip for each song, which could
  be analysed into a real note. It needs an Apple Developer token, signed on a small server.
- **A public feed.** Notes are small (a share link is about 200 characters), so a feed, "same song,
  different listeners" comparisons and artist pages need only a small backend.
- **Multi-note scenes.** Several kept notes in one bath, bumping into each other.
