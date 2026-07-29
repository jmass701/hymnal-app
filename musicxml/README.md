# musicxml/

This folder holds the **corrected, source-of-truth** MusicXML for each hymn's
tune. `audio/*.mp3` and `images/*.png` are *generated* from these files —
don't hand-edit the mp3/png directly, edit the MusicXML instead.

## Fixing a wrong note

1. Open the hymn's file here in [MuseScore 4](https://musescore.org/en/download)
   (free). If you don't have a `.xml` for it yet, open the `.omr` project for
   that hymn in [Audiveris](https://github.com/Audiveris/audiveris), fix the
   scan errors there against the original page image, then
   `File -> Export -> MusicXML`.
2. Fix the note(s) in MuseScore's normal notation editor.
3. `File -> Export -> MusicXML`, save it here as `hymn_<N>.xml`, overwriting
   the old version.
4. Commit and push to `main`.
5. The **Regenerate Hymn Audio & Sheet Music** GitHub Action picks it up
   automatically, re-renders `audio/hymn_<N>.mp3` and `images/hymn_<N>.png`,
   and commits the results back. `data.js` doesn't need to change — the file
   paths stay the same.

## Naming convention

| File                      | Produces                                          |
|---------------------------|----------------------------------------------------|
| `hymn_<N>.xml`             | `audio/hymn_<N>.mp3` + `images/hymn_<N>.png` (and `_p2`, `_p3`... for extra pages) |
| `hymn_<N>_2.xml`           | `audio/hymn_<N>_2.mp3` (multi-voice mix)          |
| `organ_<N>.xml`            | `audio/organ_<N>.mp3` (organ track)               |

## Running it yourself (without waiting on CI)

```bash
# requires MuseScore 4 installed locally
node scripts/regenerate-media.mjs
```
