# HDoujin PDF Maker

Electron app that turns `HDoujin/<manhwa>/<chapter>/<images>` into PDFs.

1. Install [Node.js LTS](https://nodejs.org) (once).
2. Double-click `run.bat` (or run `npm install` then `npm start`).
3. Pick a mode, click **Choose…**, then **Start**:
   - **One manhwa folder** — a single `<manhwa>` folder.
   - **Several manhwa folders** — select multiple `<manhwa>` folders in the dialog.
   - **Batch: a folder full of manhwas** — pick e.g. `HDoujin`; every sub-folder that holds chapter images is listed.

   In the list you can untick manhwas you don't want (incomplete ones, unrelated folders).
   "Skip manhwas whose PDF already exists" lets you resume a batch. A manhwa that fails
   is logged and the batch carries on with the next one.

Output, next to the chosen manhwa folder (i.e. in `HDoujin`) — tick either or both:

- **Chapter PDFs** (default): `<manhwa> - chapters/<chapter>.pdf`
- **Complete PDF**: `<manhwa>.pdf` — every chapter in order, with a bookmark per chapter

With only chapter PDFs, "skip existing" works per chapter, so an interrupted batch resumes where it stopped.

Chapters and images are sorted naturally by name (`2` before `10`). JPEGs are embedded without
re-encoding; PNGs are converted to JPEG. Unreadable images are skipped and logged as warnings.

`npm run dist` builds a portable `.exe` into `dist/`.
