// Minimal scan-to-notes backend.
//
// POST /api/scan  (multipart, field name "sheet")
//   -> runs Audiveris in batch mode on the uploaded image/PDF
//   -> returns a URL to the exported MusicXML
//
// POST /api/scan-by-number/:number
//   -> looks up <number>.pdf directly in ORIGINAL_SHEETS_DIR (the
//      original high-resolution scans, not the small in-app display
//      images) and runs the same pipeline on it -- used by the Hymnal
//      App's "Edit Tune" auto-scan so it doesn't have to upload
//      anything, and gets a properly high-DPI source instead of the
//      low-res image the app displays.
//
// This is deliberately synchronous/single-request for clarity. A real
// deployment should make this a queued job (Audiveris takes anywhere
// from a few seconds to over a minute per page) with the client polling
// or subscribing to a job-status endpoint instead of holding the HTTP
// connection open.

import express from "express";
import multer from "multer";
import { exec as execCb, execFile as execFileCb } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";
import AdmZip from "adm-zip";

const exec = promisify(execCb);
const execFile = promisify(execFileCb);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Ensure the working directories exist -- when this server is bundled
// inside the Electron app rather than run from a hand-set-up project
// folder, these won't already exist on first run.
fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
fs.mkdirSync(path.join(__dirname, "output"), { recursive: true });

// Where the original high-resolution hymn scans live, named "<number>.pdf"
// or "<number>.png" (e.g. "47.pdf"). Checked in priority order -- the
// first one found for a given hymn wins. "Individual Hymns" is the
// higher-quality source (~400 DPI) but has a handful of gaps; "Original
// Sheets" covers those gaps (mostly ~200 DPI, still well above the
// low-res in-app display images). Overridable via env var (comma-
// separated list, highest priority first) for portability.
const ORIGINAL_SHEETS_DIRS = (
  process.env.ORIGINAL_SHEETS_DIRS
    ? process.env.ORIGINAL_SHEETS_DIRS.split(",")
    : [
        "D:\\JBW Consult Dropbox\\Jared Massie\\Hymns\\Individual Hymns",
        "D:\\JBW Consult Dropbox\\Jared Massie\\Hymns\\Original Sheets",
      ]
).map((s) => s.trim());

const SHEET_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg"];

// Finds the best available original scan for a hymn number, checking
// each directory in priority order and each extension within it.
// Returns the full path, or null if nothing matches anywhere.
function findOriginalSheet(number) {
  for (const dir of ORIGINAL_SHEETS_DIRS) {
    for (const ext of SHEET_EXTENSIONS) {
      const candidate = path.join(dir, `${number}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Allow the Hymnal App (served from a different origin -- a local
// Electron shell, GitHub Pages/Cloudflare, or opened as a file://
// document) to call this local server directly from the browser.
// This server only does anything when it's running on the user's own
// machine and Audiveris is installed locally, so a permissive CORS
// policy here doesn't expose anything beyond what's already only
// reachable on localhost.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// multer's default storage saves uploads with a random filename and NO
// extension. Audiveris picks its input loader (PDF vs image format)
// based on the file extension, so without one it silently fails to
// recognize the file at all and produces zero scores. Keep the
// original extension on disk.
const storage = multer.diskStorage({
  destination: path.join(__dirname, "uploads"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname); // e.g. ".pdf", ".png"
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${ext}`);
  },
});
const upload = multer({ storage });

app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(path.join(__dirname, "output")));

// Finds a usable Ghostscript executable. Checks GHOSTSCRIPT_HOME/bin
// first (same pattern as AUDIVERIS_HOME), then falls back to PATH.
function findGhostscript(isWindows) {
  const home = process.env.GHOSTSCRIPT_HOME;
  const exeName = isWindows ? "gswin64c.exe" : "gs";
  if (home) {
    const candidate = path.join(home, "bin", exeName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return exeName;
}

// Contrast levels-stretch: pixels at or below BLACK_POINT become pure
// black (0), pixels at or above WHITE_POINT become pure white (255),
// and everything between is stretched linearly across the full range.
//
// These specific values were derived from actually measuring a real
// faint hymnal scan (not guessed): its notation pixels averaged ~175
// with a max of ~239 (very light gray), against a background averaging
// ~250-255. After this stretch, the same ink pixels average ~112 —
// comfortably below Audiveris's own default binarization threshold for
// that region, confirmed by simulating that threshold directly against
// the stretched values. Other scans may be faint to a different degree;
// if a batch of pages is still failing after this, these two constants
// are the first thing to adjust (lower BLACK_POINT / raise WHITE_POINT
// = more aggressive stretch).
const CONTRAST_BLACK_POINT = 140;
const CONTRAST_WHITE_POINT = 242;

async function computePdfPageSize(pdfPath) {
  const bytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  const pageCount = pdfDoc.getPageCount();
  const { width: widthPoints, height: heightPoints } = pdfDoc.getPage(0).getSize();
  return { pageCount, widthPoints, heightPoints };
}

// Rasterizes every page of a PDF via Ghostscript at a DPI chosen to land
// near a normal ~2550px-wide page (see computePdfPageSize) regardless of
// what the PDF's declared physical size is (see the long comment further
// down about why that declared size can be wildly wrong), applies the
// contrast stretch above to each page, then rebuilds a brand new PDF
// from the corrected images — with a NORMAL declared page size this
// time, since we're the ones setting it. Audiveris then processes that
// reconstructed file with its own defaults; no more custom DPI or
// binarization overrides needed once the input itself is normal.
//
// Returns the path to the new PDF, or null if Ghostscript isn't
// available or anything in this pipeline fails — callers should fall
// back to processing the original file with the safety-net -constant
// overrides in that case.
async function preprocessPdf(originalPath, workDir, isWindows) {
  const gsBin = findGhostscript(isWindows);
  const TARGET_PIXEL_WIDTH = 2550;

  let pageCount, widthPoints, heightPoints;
  try {
    ({ pageCount, widthPoints, heightPoints } = await computePdfPageSize(originalPath));
  } catch (err) {
    console.warn("Could not read PDF page size, skipping preprocessing:", err.message);
    return null;
  }

  const widthInches = widthPoints / 72;
  // No artificial floor here — we're rasterizing and rebuilding the PDF
  // ourselves now (unlike an earlier approach that just told Audiveris's
  // own renderer a corrected DPI, where an overly-cautious minimum of 72
  // was in place). For a page declared as extremely large physically
  // (seen in practice: ~74" wide), hitting the real target sometimes
  // means going well below 72 DPI — Ghostscript handles that fine.
  const dpi = Math.max(10, Math.min(Math.round(TARGET_PIXEL_WIDTH / widthInches), 300));

  const rasterPattern = path.join(workDir, "raster-%03d.png");
  const gsArgs = [
    "-dNOPAUSE", "-dBATCH", "-dSAFER",
    "-sDEVICE=pnggray",
    `-r${dpi}`,
    "-o", rasterPattern,
    originalPath,
  ];

  try {
    const { stdout, stderr } = await runCommand(gsBin, gsArgs, isWindows);
    if (stdout) console.log("Ghostscript stdout:\n", stdout);
    if (stderr) console.log("Ghostscript stderr:\n", stderr);
  } catch (err) {
    console.warn(
      "Ghostscript rasterization skipped (not installed, or it failed on this file):",
      err.message
    );
    return null;
  }

  const rasterFiles = [];
  for (let i = 1; i <= pageCount; i++) {
    const p = path.join(workDir, `raster-${String(i).padStart(3, "0")}.png`);
    if (fs.existsSync(p)) rasterFiles.push(p);
  }
  if (rasterFiles.length === 0) {
    console.warn("Ghostscript produced no page images, skipping preprocessing.");
    return null;
  }

  // Contrast-stretch each page and collect pixel dimensions for rebuilding.
  const a = 255 / (CONTRAST_WHITE_POINT - CONTRAST_BLACK_POINT);
  const b = -CONTRAST_BLACK_POINT * a;

  const processedPages = [];
  for (const rasterFile of rasterFiles) {
    const stretched = await sharp(rasterFile).linear(a, b).png().toBuffer();
    const meta = await sharp(stretched).metadata();
    processedPages.push({ buffer: stretched, width: meta.width, height: meta.height });
  }

  // Rebuild a new PDF with a normal declared page size: since we're
  // constructing it ourselves, declare each page as if the image were a
  // standard 300 DPI scan (regardless of what DPI we actually rasterized
  // at) — this is what makes the reconstructed file's MediaBox sane,
  // fixing the root cause rather than working around it downstream.
  const newDoc = await PDFDocument.create();
  for (const pageImg of processedPages) {
    const pngImage = await newDoc.embedPng(pageImg.buffer);
    const pageWidthPt = (pageImg.width / 300) * 72;
    const pageHeightPt = (pageImg.height / 300) * 72;
    const page = newDoc.addPage([pageWidthPt, pageHeightPt]);
    page.drawImage(pngImage, { x: 0, y: 0, width: pageWidthPt, height: pageHeightPt });
  }

  const newPdfPath = path.join(workDir, "preprocessed.pdf");
  fs.writeFileSync(newPdfPath, await newDoc.save());

  // Clean up intermediate raster files
  for (const f of rasterFiles) fs.unlink(f, () => {});

  return newPdfPath;
}

async function runCommand(bin, args, isWindows, timeoutMs = 5 * 60 * 1000) {
  if (isWindows) {
    // Build the full command as one string and hand it to exec() (which
    // runs it through cmd.exe as-is). execFile() with an args array
    // re-escapes quotes we add ourselves, which breaks paths containing
    // spaces (e.g. "C:\Program Files\...") — exec() avoids that because
    // it doesn't try to re-tokenize a string we already built correctly.
    const quote = (s) => `"${s}"`;
    const fullCommand = [quote(bin), ...args.map(quote)].join(" ");
    return exec(fullCommand, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  }
  return execFile(bin, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
}

// Audiveris sometimes misreads header/credit text (e.g. an author's
// birth-death years in parentheses, like "T.Clausnitzer (1663)") as a
// tempo/metronome marking, and its own export step can produce a
// broken, incomplete <metronome> element when that misdetection fails
// internally (seen in practice: a NullPointerException in Audiveris's
// own PartwiseBuilder, exporting anyway with the bad data left in).
// OSMD's renderer then crashes trying to draw that broken element.
//
// We never want Audiveris's guessed tempo anyway (that's exactly why
// the UI has a manual Tempo field — printed hymns essentially never
// have a reliable printed metronome mark), so unconditionally
// stripping every metronome direction — malformed or not — from the
// exported file avoids this whole class of crash rather than treating
// it as one bug to patch.
function stripMetronomeDirections(xml) {
  return xml.replace(/<direction\b[^>]*>[\s\S]*?<metronome\b[\s\S]*?<\/direction>/gi, "");
}

// Some of these scans come from webpage screenshots, and Audiveris can
// misattach page-footer text (a URL, in a real case seen here) to a
// note as a bogus extra "verse" of lyrics — found by directly
// inspecting an actual failing export: a <lyric> block with an
// absurd default-y offset (-773, vs. -75 to -135 for the real verses)
// containing a full URL as if it were one sung syllable. A real lyric
// syllable never contains "://" or spans an entire URL with no
// spaces, so this is a safe, targeted removal rather than a guess.
function stripUrlLyrics(xml) {
  return xml.replace(
    /<lyric\b[^>]*>(?:(?!<\/lyric>)[\s\S])*?<text>[^<]*(?:https?:\/\/|www\.)[^<]*<\/text>[\s\S]*?<\/lyric>/gi,
    ""
  );
}

const findFileByExt = (dir, extensions) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileByExt(full, extensions);
      if (found) return found;
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      return full;
    }
  }
  return null;
};

// Runs the full OMR pipeline (optional PDF preprocessing -> Audiveris ->
// MusicXML cleanup) on a single input file already sitting somewhere
// this process can freely read/write around (its own uploads/ folder,
// specifically -- never point this at a file living in a Dropbox-synced
// folder directly, since preprocessPdf writes and deletes temp files
// next to its input and Dropbox-synced folders have repeatedly refused
// to let this project delete files from JS/git alike).
//
// Returns { ok: true, jobId, musicxmlUrl, omrProjectPath } on success,
// or { ok: false, statusCode, error, detail?, filesFound? } on failure.
async function runOmrPipeline(inputPath, jobId, { deleteInputAfter }) {
  const outDir = path.resolve(__dirname, "output", jobId);
  fs.mkdirSync(outDir, { recursive: true });

  const isWindows = process.platform === "win32";

  let preprocessedPath = null;
  if (path.extname(inputPath).toLowerCase() === ".pdf") {
    preprocessedPath = await preprocessPdf(inputPath, path.dirname(inputPath), isWindows);
    if (preprocessedPath) {
      console.log(`Preprocessed PDF (contrast + page-size fix): ${preprocessedPath}`);
    } else {
      console.warn(
        "PDF preprocessing unavailable (Ghostscript not found, or it failed) — falling back to safety-net constants on the original file."
      );
    }
  }

  const audiverisInputPath = preprocessedPath || inputPath;

  // Audiveris ships in (at least) two different install layouts:
  //   - Newer jpackage-based installers: a single Audiveris.exe sits
  //     directly in the install root, alongside a bundled `runtime/` JRE.
  //   - Older installers/dev builds: bin/Audiveris.bat (Windows) or
  //     bin/Audiveris (Unix) inside the install/distribution folder.
  // Check for both rather than assuming one.
  const home = process.env.AUDIVERIS_HOME;

  let audiverisBin;
  if (isWindows && home && fs.existsSync(path.join(home, "Audiveris.exe"))) {
    audiverisBin = path.join(home, "Audiveris.exe");
  } else if (home) {
    const launcherName = isWindows ? "Audiveris.bat" : "Audiveris";
    audiverisBin = path.join(home, "bin", launcherName);
  } else {
    audiverisBin = isWindows ? "Audiveris.exe" : "audiveris";
  }

  const MAX_PIXEL_COUNT = 250_000_000;
  const STEP_TIMEOUT_SECONDS = 600; // 10 minutes per step

  const constantArgs = [
    "-constant", `org.audiveris.omr.step.LoadStep.maxPixelCount=${MAX_PIXEL_COUNT}`,
    "-constant", `org.audiveris.omr.Main.sheetStepTimeOut=${STEP_TIMEOUT_SECONDS}`,
  ];

  const args = [
    "-batch",
    "-export",
    ...constantArgs,
    "-output",
    outDir,
    "--",
    audiverisInputPath,
  ];

  const cleanup = () => {
    if (deleteInputAfter) fs.unlink(inputPath, () => {});
    if (preprocessedPath) fs.unlink(preprocessedPath, () => {});
  };

  try {
    const { stdout, stderr } = await runCommand(audiverisBin, args, isWindows, 20 * 60 * 1000);
    if (stdout) console.log("Audiveris stdout:\n", stdout);
    if (stderr) console.log("Audiveris stderr:\n", stderr);
  } catch (err) {
    cleanup();
    if (err.stdout) console.error("Audiveris stdout:\n", err.stdout);
    if (err.stderr) console.error("Audiveris stderr:\n", err.stderr);
    console.error("Audiveris failed:", err.message);
    return {
      ok: false,
      statusCode: 500,
      error: "OMR processing failed",
      detail: (err.stdout || err.stderr || err.message || "").slice(0, 4000),
    };
  }

  cleanup();

  const xmlFilePath = findFileByExt(outDir, [".mxl", ".xml"]);
  const omrFilePath = findFileByExt(outDir, [".omr"]);

  if (!xmlFilePath) {
    let allFiles = [];
    try {
      allFiles = fs.readdirSync(outDir, { recursive: true });
    } catch {
      /* outDir may not exist at all if Audiveris failed silently */
    }
    return {
      ok: false,
      statusCode: 500,
      error: "Audiveris ran but produced no MusicXML output",
      filesFound: allFiles,
    };
  }

  let cleanedRelativePath = null;
  try {
    let xmlText;
    const isCompressed = xmlFilePath.toLowerCase().endsWith(".mxl");

    if (isCompressed) {
      const zip = new AdmZip(xmlFilePath);
      const entries = zip.getEntries();
      const scoreEntry = entries.find(
        (e) => e.entryName.toLowerCase().endsWith(".xml") && !e.entryName.toUpperCase().includes("META-INF")
      );
      if (!scoreEntry) throw new Error("No score XML found inside .mxl archive");
      xmlText = zip.readAsText(scoreEntry);
    } else {
      xmlText = fs.readFileSync(xmlFilePath, "utf8");
    }

    const beforeLength = xmlText.length;
    const cleanedXml = stripUrlLyrics(stripMetronomeDirections(xmlText));
    const afterLength = cleanedXml.length;
    const cleanedPath = path.join(outDir, "cleaned.musicxml");
    fs.writeFileSync(cleanedPath, cleanedXml, "utf8");
    cleanedRelativePath = path.relative(outDir, cleanedPath).split(path.sep).join("/");

    console.log(
      `MusicXML cleaning: ${beforeLength} -> ${afterLength} chars` +
        (beforeLength === afterLength ? " (nothing matched/removed)" : ` (removed ${beforeLength - afterLength} chars)`)
    );
  } catch (err) {
    console.warn("Could not clean MusicXML (serving original export instead):", err.message);
  }

  const relativePath = cleanedRelativePath || path.relative(outDir, xmlFilePath).split(path.sep).join("/");

  return {
    ok: true,
    jobId,
    musicxmlUrl: `/output/${jobId}/${relativePath}`,
    omrProjectPath: omrFilePath,
  };
}

function sendPipelineResult(res, result) {
  if (!result.ok) {
    return res.status(result.statusCode || 500).json({
      error: result.error,
      detail: result.detail,
      filesFound: result.filesFound,
    });
  }
  res.json({
    jobId: result.jobId,
    musicxmlUrl: result.musicxmlUrl,
    omrProjectPath: result.omrProjectPath,
  });
}

app.post("/api/scan", upload.single("sheet"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded (field name must be 'sheet')" });
  }
  const inputPath = path.resolve(req.file.path);
  const jobId = req.file.filename;
  const result = await runOmrPipeline(inputPath, jobId, { deleteInputAfter: true });
  sendPipelineResult(res, result);
});

// Scans a hymn's ORIGINAL high-resolution sheet music by number, rather
// than whatever low-res image the app happens to display. Copies the
// original into our own uploads/ folder first rather than operating on
// it in place (see runOmrPipeline's comment for why).
app.post("/api/scan-by-number/:number", async (req, res) => {
  const number = req.params.number;
  if (!/^\d+$/.test(number)) {
    return res.status(400).json({ error: "Hymn number must be numeric" });
  }

  const originalPath = findOriginalSheet(number);
  if (!originalPath) {
    return res.status(404).json({
      error: `No original sheet music found for hymn ${number}`,
      detail: `Looked in: ${ORIGINAL_SHEETS_DIRS.join(", ")}`,
    });
  }

  const jobId = `${Date.now()}-hymn${number}${path.extname(originalPath)}`;
  const workingCopyPath = path.join(__dirname, "uploads", jobId);

  try {
    fs.copyFileSync(originalPath, workingCopyPath);
  } catch (err) {
    return res.status(500).json({
      error: "Could not copy the original sheet music for processing",
      detail: err.message,
    });
  }

  const result = await runOmrPipeline(workingCopyPath, jobId, { deleteInputAfter: true });
  sendPipelineResult(res, result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Scan2Notes starter server listening on http://localhost:${PORT}`);
});
