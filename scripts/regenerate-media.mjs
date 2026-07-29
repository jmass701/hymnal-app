#!/usr/bin/env node
/**
 * regenerate-media.mjs
 *
 * Regenerates audio (mp3) and sheet music (png) files from MusicXML source
 * files, using MuseScore's headless CLI as the rendering engine.
 *
 * WORKFLOW
 * 1. Fix a hymn's notes in MuseScore (or Audiveris -> export MusicXML).
 * 2. Save the corrected file into musicxml/ using the naming convention below.
 * 3. Run this script locally (or just push to main and let the GitHub Action
 *    run it for you).
 * 4. audio/*.mp3 and images/*.png are overwritten in place. data.js does NOT
 *    need to change, since file paths stay the same.
 *
 * NAMING CONVENTION (mirrors the existing audio/ and images/ folders)
 *   musicxml/hymn_<N>.xml    -> audio/hymn_<N>.mp3       (single voice)
 *                             -> images/hymn_<N>.png       (page 1)
 *                             -> images/hymn_<N>_p2.png    (page 2, if any)
 *   musicxml/hymn_<N>_2.xml  -> audio/hymn_<N>_2.mp3      (multi voice mix)
 *   musicxml/organ_<N>.xml   -> audio/organ_<N>.mp3        (organ track)
 *
 * Only the file types implied by the input file's prefix are produced:
 * "hymn_*" files (without a following "_2") produce both mp3 + png.
 * "hymn_*_2" and "organ_*" files produce mp3 only (they reuse the existing
 * sheet image for that hymn number).
 *
 * REQUIREMENTS
 *   MuseScore 4 must be installed and its CLI binary available on PATH.
 *   Linux CLI binary is typically `mscore4portable` or `musescore4`;
 *   set MUSESCORE_BIN to override if yours differs.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, copyFileSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const MUSICXML_DIR = join(ROOT, "musicxml");
const AUDIO_DIR = join(ROOT, "audio");
const IMAGES_DIR = join(ROOT, "images");
const MUSESCORE_BIN = process.env.MUSESCORE_BIN || findMuseScoreBinary();

function findMuseScoreBinary() {
  const candidates = ["musescore4", "mscore4portable", "mscore", "musescore"];
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      // try next candidate
    }
  }
  console.error(
    "Could not find a MuseScore CLI binary on PATH. Install MuseScore 4 " +
      "and/or set MUSESCORE_BIN to the correct executable name."
  );
  process.exit(1);
}

function ensureDirs() {
  for (const dir of [AUDIO_DIR, IMAGES_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

// Parse a musicxml filename into { kind, number, isMultiVoice }
// hymn_23.xml    -> { kind: "hymn",  number: "23", isMultiVoice: false }
// hymn_23_2.xml  -> { kind: "hymn",  number: "23", isMultiVoice: true  }
// organ_23.xml   -> { kind: "organ", number: "23", isMultiVoice: false }
function parseName(filename) {
  const name = basename(filename, extname(filename));
  const m = name.match(/^(hymn|organ)_(\d+)(_2)?$/);
  if (!m) return null;
  return { kind: m[1], number: m[2], isMultiVoice: Boolean(m[3]) };
}

function renderMp3(xmlPath, outMp3Path) {
  console.log(`  audio -> ${outMp3Path}`);
  execFileSync(MUSESCORE_BIN, ["-o", outMp3Path, xmlPath], { stdio: "inherit" });
}

// MuseScore exports multi-page scores as <name>-1.png, <name>-2.png, ...
// (or a single <name>.png for one page). We rename these into the app's
// hymn_N.png / hymn_N_p2.png / hymn_N_p3.png convention.
function renderPng(xmlPath, hymnNumber) {
  const tmpBase = join(IMAGES_DIR, `__tmp_hymn_${hymnNumber}`);
  console.log(`  sheet -> images/hymn_${hymnNumber}.png (+ extra pages if any)`);
  execFileSync(MUSESCORE_BIN, ["-o", `${tmpBase}.png`, xmlPath], { stdio: "inherit" });

  const produced = readdirSync(IMAGES_DIR).filter((f) => f.startsWith(basename(tmpBase)));
  produced.sort(); // ensures -1, -2, -3 order
  produced.forEach((file, i) => {
    const pageNum = i + 1;
    const target =
      pageNum === 1
        ? join(IMAGES_DIR, `hymn_${hymnNumber}.png`)
        : join(IMAGES_DIR, `hymn_${hymnNumber}_p${pageNum}.png`);
    renameSync(join(IMAGES_DIR, file), target);
  });
}

function main() {
  if (!existsSync(MUSICXML_DIR)) {
    console.error(`No musicxml/ directory found at ${MUSICXML_DIR}`);
    process.exit(1);
  }
  ensureDirs();

  const files = readdirSync(MUSICXML_DIR)
    .filter((f) => /\.(musicxml|xml|mxl)$/i.test(f))
    .sort();
  if (!files.length) {
    console.log("No MusicXML files found in musicxml/. Nothing to do.");
    return;
  }

  // Validate every filename BEFORE rendering anything. A single bad name
  // (typo, wrong hymn number, missing underscore, etc.) fails the whole run
  // with a clear message instead of silently skipping the file or leaving
  // a half-regenerated set of assets.
  const invalid = files.filter((f) => !parseName(f));
  if (invalid.length) {
    console.error(
      `\nERROR: ${invalid.length} file(s) in musicxml/ don't match the required naming convention.\n` +
        `Expected one of:\n` +
        `  hymn_<N>.xml     e.g. hymn_23.xml\n` +
        `  hymn_<N>_2.xml   e.g. hymn_23_2.xml   (multi-voice mix)\n` +
        `  organ_<N>.xml    e.g. organ_23.xml    (organ track)\n` +
        `(<N> must be digits only, and the extension must be .xml, .musicxml, or .mxl)\n\n` +
        `Invalid file(s):\n` +
        invalid.map((f) => `  - ${f}`).join("\n") +
        "\n"
    );
    process.exit(1);
  }

  console.log(`Found ${files.length} MusicXML file(s). Rendering with ${MUSESCORE_BIN}...\n`);

  for (const file of files) {
    const parsed = parseName(file);
    const xmlPath = join(MUSICXML_DIR, file);
    const { kind, number, isMultiVoice } = parsed;

    console.log(`Hymn ${number} (${kind}${isMultiVoice ? ", multi voice" : ""}):`);

    const mp3Name = isMultiVoice ? `hymn_${number}_2.mp3` : `${kind}_${number}.mp3`;
    renderMp3(xmlPath, join(AUDIO_DIR, mp3Name));

    // Only regenerate the sheet image from the primary hymn score, not from
    // organ or multi-voice variants (they reuse the same printed page).
    if (kind === "hymn" && !isMultiVoice) {
      renderPng(xmlPath, number);
    }
    console.log("");
  }

  console.log("Done. Review the changes with `git status` before committing.");
}

main();
