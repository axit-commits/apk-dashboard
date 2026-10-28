# Third-party notices

APK Explorer is MIT-licensed (see `LICENSE`). It uses, downloads at setup time, or ships data derived from the projects below. Their licences apply to those parts.

## Bundled or installed by `npm install`

| Component | Use | Licence |
|---|---|---|
| [Electron](https://github.com/electron/electron) | Desktop app shell | MIT |
| [three.js](https://github.com/mrdoob/three.js) | 3D model viewer | MIT |
| [lottie-web](https://github.com/airbnb/lottie-web) | Lottie playback (light canvas build, no expressions) | MIT |
| [highlight.js](https://github.com/highlightjs/highlight.js) | Syntax highlighting | BSD-3-Clause |
| [fast-xml-parser](https://github.com/NaturalIntelligence/fast-xml-parser) | Manifest parsing | MIT |

## Downloaded into `vendor/` by `npm run setup-tools`

| Component | Use | Licence |
|---|---|---|
| [jadx](https://github.com/skylot/jadx) | DEX to Java decompiler | Apache-2.0 |
| [apktool](https://github.com/iBotPeaches/Apktool) | Resource and manifest decoding | Apache-2.0 |
| Java runtime (trimmed with `jlink` from the developer's JDK, e.g. Eclipse Temurin or Amazon Corretto) | Runs jadx and apktool | GPL-2.0 with Classpath Exception |
| [python-build-standalone](https://github.com/astral-sh/python-build-standalone) (CPython) | Portable Python for the Unity extractor | PSF License (CPython); build scripts MPL-2.0 |
| [UnityPy](https://github.com/K0lb3/UnityPy) | Unity asset reading | MIT |
| [texture2ddecoder](https://github.com/K0lb3/texture2ddecoder), [etcpak](https://github.com/K0lb3/etcpak), [astc-encoder-py](https://github.com/K0lb3/astc-encoder-py), [tpk_ar](https://pypi.org/project/tpk-ar/) | Texture decoding, type trees | MIT (astc-encoder itself: Apache-2.0) |
| [Pillow](https://github.com/python-pillow/Pillow) | Image export | MIT-CMU (HPND) |
| [lz4](https://github.com/python-lz4/python-lz4), [Brotli](https://github.com/google/brotli), [fsspec](https://github.com/fsspec/filesystem_spec), [attrs](https://github.com/python-attrs/attrs), [archspec](https://github.com/archspec/archspec) | Compression and helpers | BSD-3-Clause / MIT / BSD-3-Clause / MIT / Apache-2.0 or MIT |

UnityPy's audio dependency `fmod_toolkit` is deliberately **not** installed: it bundles the proprietary FMOD library.

## Data shipped in this repository

`src/py/vorbis_setup.json` contains Vorbis setup headers used to rebuild FMOD FSB5 audio as Ogg:

- Headers regenerated with [libvorbis](https://github.com/xiph/vorbis) (BSD-3-Clause, Copyright Xiph.Org Foundation) from the CRC32 table of [python-fsb5](https://github.com/HearthSim/python-fsb5) (MIT).
- Setup packets collected by [vgmstream](https://github.com/vgmstream/vgmstream) (`src/coding/libs/vorbis_codebooks_fsb.h`), used under its ISC-style licence:

  > Permission to use, copy, modify, and distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies. Copyright (c) 2008-2025 Adam Gashlin, Fastelbja, Ronny Elfert, bnnm, Christopher Snowhill, NicknineTheEagle, bxaimc, Thealexbarney, CyberBotX, EdnessP, et al.

## Written independently

- The Spine player (`src/renderer/spine.js`, `spineViewer.js`) is written from the Spine JSON format and does not include the official Spine Runtimes.
- The Unity animation decoder, glTF writer, FSB5/Ogg muxer, Android animation players, line diff, signing reader and release audit are original code in this repository.
