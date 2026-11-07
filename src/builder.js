'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { nativeImage } = require('electron');
const { PdfWriter, readJpegInfo } = require('./pdfWriter');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// Natural order ("2" before "10"), with a plain string compare to break ties like "_0" vs "_00".
function compareNames(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

async function scanManhwa(folder) {
  const entries = await fsp.readdir(folder, { withFileTypes: true });
  const chapterNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(compareNames);
  const chapters = [];
  for (const name of chapterNames) {
    const dir = path.join(folder, name);
    const files = await fsp.readdir(dir, { withFileTypes: true });
    const images = files
      .filter((f) => f.isFile() && IMAGE_EXTS.has(path.extname(f.name).toLowerCase()))
      .map((f) => f.name)
      .sort(compareNames);
    chapters.push({ name, dir, images });
  }
  return chapters;
}

async function loadImage(file) {
  const raw = await fsp.readFile(file);
  if (raw[0] === 0xff && raw[1] === 0xd8) {
    try {
      return { data: raw, ...readJpegInfo(raw) };
    } catch {
      // fall through and let the decoder re-encode it
    }
  }
  const img = nativeImage.createFromBuffer(raw);
  if (img.isEmpty()) throw new Error('unreadable or unsupported image');
  const data = img.toJPEG(92);
  return { data, ...readJpegInfo(data) };
}

const completePathFor = (folder) => path.join(path.dirname(folder), `${path.basename(folder)}.pdf`);
const chaptersDirFor = (folder) => path.join(path.dirname(folder), `${path.basename(folder)} - chapters`);

// Writes the chapter PDFs and/or the complete PDF in a single pass over the images.
async function buildManhwa({ folder, chapters: scanned, buildChapters, buildComplete, skipExisting }, emit, shouldCancel) {
  const manhwaName = path.basename(folder);
  const log = (text, level = 'info') => emit({ text, level });

  if (!scanned) log(`Scanning "${manhwaName}"...`);
  const chapters = scanned || (await scanManhwa(folder));
  const totalImages = chapters.reduce((n, c) => n + c.images.length, 0);
  if (totalImages === 0) throw new Error('No images (.jpg/.png) found in the chapter folders.');
  log(`Found ${chapters.length} chapters, ${totalImages} images.`);

  const completePath = completePathFor(folder);
  const chaptersDir = chaptersDirFor(folder);
  const full = buildComplete ? new PdfWriter(completePath) : null;
  let chapterWriter = null;
  let done = 0;
  let pages = 0;
  let chapterPdfs = 0;
  let skipped = 0;

  try {
    if (full) await full.open();
    if (buildChapters) await fsp.mkdir(chaptersDir, { recursive: true });

    for (let ci = 0; ci < chapters.length; ci++) {
      const chapter = chapters[ci];
      const label = `Chapter ${ci + 1}/${chapters.length}`;
      if (!chapter.images.length) {
        log(`${label}: "${chapter.name}" has no images, skipping.`, 'warn');
        continue;
      }

      const chapterPath = path.join(chaptersDir, `${chapter.name}.pdf`);
      // Without the complete PDF the images of an existing chapter PDF are not needed again.
      if (skipExisting && buildChapters && !full && fs.existsSync(chapterPath)) {
        log(`${label}: "${chapter.name}.pdf" already exists, skipping.`, 'warn');
        done += chapter.images.length;
        emit({ done, total: totalImages, status: `${label} - skipped` });
        continue;
      }

      log(`${label}: "${chapter.name}" (${chapter.images.length} images)`);
      if (full) full.bookmark(chapter.name);
      let chapterPages = 0;

      for (let ii = 0; ii < chapter.images.length; ii++) {
        if (shouldCancel()) throw new CancelledError();
        const name = chapter.images[ii];
        try {
          const img = await loadImage(path.join(chapter.dir, name));
          if (buildChapters && !chapterWriter) {
            chapterWriter = new PdfWriter(chapterPath);
            await chapterWriter.open();
          }
          if (full) await full.addImage(img);
          if (chapterWriter) await chapterWriter.addImage(img);
          chapterPages++;
          log(`  page ${ii + 1}/${chapter.images.length}: ${name} (${img.width}x${img.height})`, 'dim');
        } catch (e) {
          if (e.cancelled) throw e;
          skipped++;
          log(`  skipped ${name}: ${e.message}`, 'warn');
        }
        done++;
        emit({ done, total: totalImages, status: `${label} - image ${ii + 1}/${chapter.images.length}` });
      }

      if (chapterWriter) {
        emit({ status: `${label} - writing chapter PDF` });
        await chapterWriter.close();
        log(`  chapter PDF saved: ${manhwaName} - chapters\\${chapter.name}.pdf`);
        chapterWriter = null;
        chapterPdfs++;
      }
      if (full) log(`  chapter added to the complete PDF (${chapterPages} pages)`);
      pages += chapterPages;
    }

    if (full) {
      if (full.pageCount === 0) throw new Error('None of the images could be read.');
      emit({ status: 'Finalizing the complete PDF...' });
      log(`Finalizing "${manhwaName}.pdf" (${full.pageCount} pages)...`);
      await full.close();
    }
  } catch (e) {
    if (chapterWriter) await chapterWriter.abort();
    if (full) await full.abort();
    throw e;
  }

  if (skipped) log(`${skipped} image(s) were skipped (see warnings above).`, 'warn');
  return {
    outputPath: full ? completePath : chaptersDir,
    pages,
    chapters: chapters.length,
    chapterPdfs,
    skipped,
  };
}

const countImages = (chapters) => chapters.reduce((n, c) => n + c.images.length, 0);

async function describeFolder(folder) {
  const chapters = await scanManhwa(folder);
  return { folder, name: path.basename(folder), chapterCount: chapters.length, imageCount: countImages(chapters) };
}

// Lists the sub-folders of `root` that look like a manhwa (at least one chapter image).
async function findManhwas(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const found = [];
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => compareNames(a.name, b.name))) {
    const info = await describeFolder(path.join(root, entry.name));
    if (info.imageCount > 0) found.push(info);
  }
  return found;
}

// Builds every folder in `folders` one after another; one failing manhwa does not stop the rest.
async function runJob({ folders, buildChapters, buildComplete, skipExisting }, emit, shouldCancel) {
  if (!buildChapters && !buildComplete) throw new Error('Choose at least one output: chapter PDFs or the complete PDF.');
  const log = (text, level = 'info') => emit({ text, level });
  const jobs = [];
  for (const folder of folders) jobs.push({ folder, chapters: await scanManhwa(folder) });
  const grandTotal = jobs.reduce((n, j) => n + countImages(j.chapters), 0);
  const results = [];
  let base = 0;
  let cancelled = false;

  for (let i = 0; i < jobs.length; i++) {
    const { folder, chapters } = jobs[i];
    const name = path.basename(folder);
    const size = countImages(chapters);
    if (shouldCancel()) { cancelled = true; break; }

    const prefix = jobs.length > 1 ? `[${i + 1}/${jobs.length}] ${name}` : name;
    if (jobs.length > 1) log(`=== ${prefix} ===`);

    // The complete PDF needs every image, so it is skipped as a whole; chapter-only runs skip per chapter.
    if (skipExisting && buildComplete && fs.existsSync(completePathFor(folder))) {
      log(`"${name}.pdf" already exists, skipping.`, 'warn');
      results.push({ name, skipped: true });
      base += size;
      emit({ done: base, total: grandTotal });
      continue;
    }

    const scoped = (e) => {
      const out = e.status ? { ...e, status: `${prefix} - ${e.status}` } : { ...e };
      if (e.total !== undefined) {
        out.done = base + e.done;
        out.total = grandTotal;
      }
      emit(out);
    };
    try {
      const r = await buildManhwa({ folder, chapters, buildChapters, buildComplete, skipExisting }, scoped, shouldCancel);
      results.push({ name, ok: true, ...r });
    } catch (e) {
      if (e.cancelled) { cancelled = true; break; }
      log(`Failed "${name}": ${e.message}`, 'error');
      results.push({ name, ok: false, error: e.message });
    }
    base += size;
  }
  return { results, cancelled };
}

module.exports = { findManhwas, describeFolder, runJob };
