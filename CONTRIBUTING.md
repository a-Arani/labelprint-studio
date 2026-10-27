# Contributing

Thanks for helping improve LabelPrint Studio! Bug reports, translations and pull requests are all welcome.

## Run from source

You need Windows and Python 3.10 or newer. The app uses only the Python standard library.

```bash
git clone https://github.com/a-Arani/labelprint-studio.git
cd labelprint-studio
python run.py            # opens the app window
python run.py --server   # server only, then open http://127.0.0.1:8803
```

Options: `--port 8810` and `--data D:\Labels` (or the `LABEL_PORT` / `LABEL_DATA` environment variables).

## Tests

```bash
pip install -r requirements-dev.txt
python -m pytest -q
```

- `tests/e2e` drives the real interface in a browser; it runs only when Playwright is installed (`pip install playwright`).
- Import tests build their Word/PowerPoint samples in code (`tests/office_samples.py`); please don't add real customer files.
- Set `LABEL_SAMPLES` to a folder of your own .docx/.pptx files to check that all of them import.

## Project layout

| Path | What it is |
| --- | --- |
| `app/server.py` | Local HTTP server and API |
| `app/printing.py` | TSPL, Windows driver (GDI) and network printing |
| `app/office_import.py` | Word/PowerPoint import |
| `app/library.py`, `history.py`, `backup.py` | Labels on disk, print history (SQLite), backups |
| `app/meta.py` | App name, version and author: change the version here |
| `web/js/` | The interface (plain ES modules, no build step) |
| `web/i18n/` | Translations |
| `packaging/`, `build_package.ps1` | The Windows release package |

## Translations

All interface text lives in `web/i18n/<language>.json`; `en.json` is the reference.

- **Improve a translation:** edit the value, keep `{placeholders}` as they are.
- **Add a language:** copy `en.json` to `<code>.json`, translate the values, and add the language to `LANGS` in `web/js/i18n.js` (with `dir: 'rtl'` for right-to-left scripts).
- **New text in the code:** use `t('area.key')` (or `t('area.key', { name })`) and add the key to `en.json` and every other catalog.

`python -m pytest tests/test_i18n.py` checks that every catalog has the same keys and placeholders as English, and that every key used in the code exists.

## Style

- Keep the server dependency-free (standard library only).
- Follow `.editorconfig`; match the style of the surrounding code.
- User-facing text goes through the translation catalogs; logs and comments are in English.

## Releases

1. Update `VERSION` in `app/meta.py` and add a section to `CHANGELOG.md`.
2. Commit, then tag: `git tag v2.0.1 && git push origin v2.0.1`.
3. The release workflow builds `LabelPrintStudio-v<version>-win64.zip` and attaches it to the GitHub release.
