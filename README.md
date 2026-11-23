# Form desk

A private, browser-only PDF form filler. Open a time sheet or any PDF, click a cell, type in English or Hebrew, add a signature, and download. The file never leaves the device. There is no account, no upload, and no watermark.

## Run it locally

```bash
npm install
npm run dev
```

Open http://127.0.0.1:43123.

A production build is the same static site:

```bash
npm run build
npm run preview
```

`npm run build` writes `dist/`. Assets use relative paths (`base: './'`), so the folder can be hosted at a domain root or a project subpath.

Opening `dist/index.html` directly (`file://`) does not work in Chrome. Module scripts and the PDF worker are blocked on the file protocol. Use `npm run dev` or `npm run preview`, or any static host.

## What you can do

- Drop or open a PDF. The sample button loads a weekly time report with a table and two real form fields.
- Click where the words should start. **Tab** moves across by the cell width. **Enter** moves down by the row height. **Shift+Enter** adds a line. **Alt+arrow** nudges the text.
- Size, color, and alignment apply to the cell you are editing. Alignment **Auto** is right-to-left when the text is Hebrew.
- Yellow boxes are real PDF form fields (text, checkboxes, radios, dropdowns).
- **Whiteout** covers printed text so you can type over it.
- **Sign** draws, types, or uploads a signature, then you click the page to place it. Drag to move it.
- **Undo** and **Redo**. The percent button fits the page to the window.
- **Download** writes a new PDF with your text, field values, and signature embedded. Noto Sans Hebrew is embedded so Hebrew survives in other PDF readers.

## Autosave

While a form is open, the PDF bytes and every edit are stored in this browser’s IndexedDB:

- shortly after each change
- every 60 seconds
- when the tab is hidden or closed (`pagehide` / `beforeunload`)

The corner shows **Saved at HH:MM**. Reopen the site and the form comes back. **Start fresh** clears the screen and that saved copy.

## Publish to GitHub Pages from this Origin repo

This project lives on Origin (`origin.cursor.com`). Origin does not run GitHub Actions and does not publish GitHub Pages. The workflow is in the repo so it runs after the code is on GitHub.

1. Create a **public** GitHub repository. Free GitHub Pages requires a public repo.
2. From a clone of this project, push `main` to that GitHub repo:

   ```bash
   git remote add github git@github.com:<user>/<repo>.git
   git push github main
   ```

3. On GitHub open **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
4. `.github/workflows/pages.yml` runs on every push to `main`. It uses Node 22, runs `npm ci` and `npm run build`, and deploys the `dist/` folder with the official Pages actions.
5. No base-path edit is required. Vite’s `base` is `./`, so the site works at `https://<user>.github.io/<repo>/` and on a custom domain.
6. The first run can sit on the `github-pages` environment until it is allowed under the Actions tab. When it finishes, the URL is on the workflow run and under Settings → Pages.

Pushing to Origin does not update that site. Publish by pushing `main` to GitHub.

## Fonts

Added text uses [Noto Sans Hebrew](https://fonts.google.com/noto/specimen/Noto+Sans+Hebrew) (English and Hebrew). Typed Latin signatures use [Great Vibes](https://fonts.google.com/specimen/Great+Vibes). Both are under the SIL Open Font License; see `src/fonts/`. PDF rendering data under `public/standard_fonts`, `public/cmaps`, and `public/wasm` comes from PDF.js.

## Optional check

With Chrome installed and the dev server running:

```bash
node scripts/e2e.mjs
```

That opens the sample, fills English and Hebrew cells, checks a form field, adds a signature, reloads to confirm the autosave, downloads the PDF, and reopens it.
