# APK Explorer

A free, fully offline desktop app (Electron) that opens an Android app (APK, XAPK, APKS, APKM), decompiles it, and lays out everything inside. For games, it pulls out the 3D models, characters with their animations, textures, materials, audio, scenes, UI sprites and more, each in its own section with a preview. No internet, APIs or cloud services are used at any point.

## Run it

You need Node.js 18+, and a JDK 17+ for the one-time tool setup.

```bash
npm install
npm run setup-tools   # downloads jadx, apktool, portable Python + UnityPy into vendor/ (only step that uses the network)
npm start             # or: npx electron . path/to/game.apk
```

Test the pipeline without the window:

```bash
npm run decode -- path/to/app.apk
```

Decoded output is cached per input file (by SHA-256) in the app's data folder: `~/Library/Application Support/APK Explorer/workspaces/` on macOS.

## What it extracts

| Engine | What you get |
|---|---|
| Unity (Mono or IL2CPP) | Textures (PNG), 3D models (GLB with their materials' textures), characters (GLB with skeleton and every animation that fits it), animation clips and controllers, materials, audio (Vorbis rebuilt to OGG, PCM to WAV, MP3), scenes (object hierarchy), sprites and atlases, fonts, text assets, videos, shader names |
| Android UI animations (any app) | View animations (`res/anim`), property and state-list animators (`res/animator`), animated vector icons, frame animations (`animation-list`) and Lottie files (found by content, any extension), each played in the app with play/pause, speed and a timeline. Every playing animation (also 3D characters and Spine) has **Download video**, which records one loop to MP4 (WebM if MP4 isn't available) |
| Any engine | Loose files in `assets/` and `res/raw/`: glTF/GLB/OBJ/FBX/DAE/STL/PLY models, images, audio, video, fonts, JSON/XML/text |
| Spine (any engine, Unity included) | JSON skeletons (3.x and 4.x) paired with their atlas and page images, played in the app: bones, region and mesh attachments (weighted, linked), skins, IK and transform constraints, deform, draw order, colours. Binary `.skel` files are listed only |
| Unreal Engine | `.pak` / IoStore files listed with version and whether the index is encrypted; contents are not extracted yet |
| Godot | `.pck` file list; imported resources are not converted yet |

Assets that can't be previewed or reconstructed are still listed, with the reason shown in the app.

## Using the app

- **Add APK** (sidebar, the home screen, Ctrl/Cmd+O, or drag a file anywhere onto the window) opens an APK, XAPK, APKS or APKM.
- **History** (home screen) lists every app opened on this computer with its icon, engine, asset count and when it was last opened. Click one to reopen it instantly from the cache, even if the original file has moved. Hover a card to open its extracted folders or remove it (optionally deleting its extracted files). History is kept in `history.json` in the app's data folder.
- Each app has **Overview**, **Game assets**, **Code**, **Release audit** and **Report** views; the light/dark switch is at the bottom of the sidebar.
- **Code**: browse the decompiled Java (jadx) and the decoded manifest and resources (apktool) with syntax highlighting and line numbers. The Search tab searches every file (text, regex or file name) in a background worker; click a result to open the file at that line.
- **Release audit**: one-click checks for publishing, each with its severity, locations (click to open in Code) and how to fix it:
  - signing certificate (SHA-1 / SHA-256 to copy for Firebase and Play Console), debug key, v1-only signing, key expiry, re-signed by a download site
  - manifest: debuggable, testOnly, target SDK below Google Play's minimum, cleartext traffic and network security config, backup, exported components without a permission
  - Google Play policy–restricted permissions (SMS, call log, all-files access, exact alarms, full-screen intents, photo/video, background location, …)
  - secrets in code and resources (AWS, Stripe, Slack and GitHub tokens, private keys, passwords, Google API keys, plain HTTP URLs), key/keystore files in the APK
  - R8 obfuscation off, BuildConfig.DEBUG, debug logging in your own package
  - native libraries: 64-bit and the 16 KB page-size requirement (ELF alignment and APK zip alignment)
  Findings in your own package are separated from third-party SDKs. Results are cached in the workspace (`audit.json`); **Run again** re-checks.

## Output folders and report

Every input ends up in `Extracted/` inside its workspace (**Open extracted folders** in the app; **Export all…** copies it anywhere):

```
3D_Models/          objects and props (GLB, OBJ, FBX…); Characters/ = skinned models with their animations
Animations/         Clips/, Animator_Controllers/, Spine_Skeletons/<name>/ (json + atlas + pages)
Textures/           textures and images
Materials_Shaders/  Materials/ (JSON: shader, texture slots, colours), Shaders/
Audio_Music/        music, sound effects (OGG/WAV/MP3; raw .fsb/.bnk/.wem when they can't be converted)
Videos_Cutscenes/   video files
Scenes_Maps/        scene hierarchies (JSON)
UI_Assets/          sprites, atlases, fonts, Android drawables and icons
Scripts_Data/       decompiled Java, AndroidManifest.xml, resources, text assets, Unity script data
Other_Assets/       native libraries, raw Unity data, engine packages, every other file in the APK
EXTRACTION_REPORT.html / .json / .csv, extraction.log
```

Original folder structure is kept where the APK or the Unity build preserves it. Files are hard links into the workspace, so the folders take no extra disk space.

**Nothing is skipped silently.** Every archive entry (including the entries of an XAPK/APKS bundle itself) is recorded with its detected format (by extension and file signature), its status and where it was saved. Statuses: `decoded` (converted to a usable file), `extracted` (written as-is), `partial`, `unsupported`, `encrypted`, `corrupted`, `missing`, each with a reason and, where there is one, a possible solution. The Report tab lists problems first.

## How the offline pieces fit

- **jadx + apktool** (Java) decompile code and decode resources, on a Java runtime trimmed with jlink.
- **UnityPy** (Python, MIT) reads Unity files, on a portable CPython from python-build-standalone. UnityPy's `fmod_toolkit` dependency is left out because it bundles the proprietary FMOD library.
- **FMOD Vorbis audio** is rebuilt to standard OGG in pure Python (`src/py/fsb_vorbis.py`). The Vorbis setup headers FMOD strips out ship as `src/py/vorbis_setup.json` (218 headers), built once by `scripts/gen-vorbis-setup.py` from two sources: headers regenerated with libvorbis (BSD) from python-fsb5's CRC table (MIT), and setup packets from newer FMOD versions collected by [vgmstream](https://github.com/vgmstream/vgmstream) (ISC-style licence). For headers without known block sizes, the app picks the size pair that matches the sample count stored in the FSB.
- **Unity animations** are decoded from Unity's compiled clip format (streamed, dense and constant curves) in `src/py/unity_anim.py` and written into the character's GLB. Clips are matched to a skeleton by bone path, because many games assign animator controllers from code at runtime.
- **Spine player** (`src/renderer/spine.js`, `spineViewer.js`) is written from the Spine JSON format itself and does not use the official Spine Runtimes, whose licence requires every user to own a Spine Editor licence. Not drawn yet: clipping, path and physics constraints, sequence attachments, local/relative transform constraints.
- **three.js** (MIT) shows models in the app. The page loads only from the app's own `apkx://` protocol; every other request is blocked.

## Code layout

```
scripts/setup-tools.js        dev-only: fetch jadx/apktool/Python+UnityPy, build the trimmed JRE into vendor/
scripts/python-requirements.txt  pinned Python packages (installed with --no-deps)
scripts/gen-vorbis-setup.py   dev-only: regenerate src/py/vorbis_setup.json (needs a libvorbis build)
scripts/decode-cli.js         run the pipeline from the terminal
src/main/main.js              window, apkx:// protocol, network blocked, IPC
src/main/pipeline.js          hash -> inspect -> apktool + game assets, then jadx -> analyze, with cache
src/main/gameassets.js        engine detection, bundle/OBB handling, Unity run, loose files, .pak/.pck headers
src/main/zipindex.js          zip listing and safe streaming extraction (zip64, zip-slip checks)
src/main/analyze.js           manifest, permissions, components, frameworks
src/py/extract_unity.py       Unity asset extractor (textures, meshes, characters, audio, scenes, ...)
src/py/unity_anim.py          compiled AnimationClip decoder
src/py/glb.py                 small glTF binary writer
src/py/fsb_vorbis.py          FSB5 Vorbis -> Ogg
src/renderer/                 UI: app.js (shell, overview), assets.js (asset browser), viewer3d.js (three.js)
```

## Known limits

- Humanoid (muscle) Unity animations need avatar retargeting and are listed but not played.
- Particle systems, timelines and MonoBehaviour script data are counted, not reconstructed.
- Full 3D scene reconstruction isn't done; scenes show their object hierarchy.
- Unity extraction holds the game's data in memory: about 1.8 GB peak for a 200 MB game.

## Known setup issue

With npm 11 + Node 26, Electron's binary may not install (`npm warn allow-scripts ... electron`). Run `npm approve-scripts electron` and reinstall, or unpack the cached zip from `~/Library/Caches/electron/` into `node_modules/electron/dist`.
