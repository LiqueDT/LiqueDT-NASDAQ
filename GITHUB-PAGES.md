# Upload LiqueDT NASDAQ to GitHub Pages

Upload the contents of `GitHub-Pages-Upload` to your NASDAQ app repository. Include hidden folders such as `.github`; GitHub shows a hidden-file warning, but it is safe and required for the workflow.

Recommended upload contents: `.github/`, `tools/`, `.nojekyll`, `index.html`, `styles.css`, `app.js`, `server.py`, `service-worker.js`, `manifest.webmanifest`, `icon.svg`, favicon/app icon files, `requirements-pages.txt`, and `README.md`.

The workflow deploys the PWA and refreshes public static snapshots on `2/5 * * * *`, meaning every five minutes offset at minute 2, 7, 12, and so on. GitHub may delay scheduled runs during queue congestion, so the app displays the snapshot build/check time.
