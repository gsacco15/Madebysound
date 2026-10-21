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

- **Stage**: a raymarched glass note (`js/shader.js`) with refraction, chromatic dispersion, thin-film
  iridescence and a rippling oil bath. Drag to turn, scroll or pinch to zoom, double-click to reset.
- **How it was made**: the readout above, the loudness curve, band energy and the pitch-color wheel.
- **Studio**: five materials (clear, frosted, song tint, liquid metal, neon edge), four scenes (oil bath,
  studio, dusk, void), sound influence, ripples and slow-turn toggles.
- **Collection**: keep notes in this browser (features plus a thumbnail; the DNA is rebuilt on load).
- **Card**: a 1080×1350 PNG of the note with title, key, tempo, ID and loudness signature.
- **Clip**: an 8-second video of the note playing, with sound.
- **Listen**: drive the glass from the microphone, then capture 12 seconds to make a note from it.

Rendering resolution adapts to keep the frame rate up on phones.

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
scripts/              icon and demo-feature generators, artifact build
tests/                node:test suites with synthetic signals
```

`scripts/measure-demos.mjs` and `scripts/make-icons.mjs` need Playwright (`npm i -D playwright`) and the
app running on port 5173.

## Where it could go next

- **Native iOS.** SwiftUI shell, the same SDF in a Metal fragment shader, AVAudioEngine taps plus
  Accelerate (vDSP) for the FFT. The DNA mapping ports over as is, and the existing tests pin its behavior.
- **Apple Music and Spotify.** Streaming tracks are DRM-protected, so their audio can't be read directly.
  Two workable routes are the 30-second preview clips that the Apple Music API exposes for each song, and
  the microphone (Listen) while the song plays from another app.
- **Exports.** USDZ/glTF meshes by marching-cubing the same distance field, for AR Quick Look.
- **Shared notes.** A link that carries the DNA (it's under 1 KB of features) so anyone can see your note
  without the audio.
