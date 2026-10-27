<p align="center">
  <img src="web/logo.svg" width="96" alt="LabelPrint Studio logo">
</p>

<h1 align="center">LabelPrint Studio</h1>

<p align="center">
  <b>Design &amp; print labels on thermal printers</b> — TSC and any TSPL printer, or any Windows printer.<br>
  Free and multilingual. Design like in Word or Paint, add barcodes, QR codes and serial numbers, and print straight to the printer.
</p>

<p align="center">
  <a href="https://github.com/a-Arani/labelprint-studio/releases/latest"><b>Download for Windows</b></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="README.fa.md">فارسی</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/a-Arani/labelprint-studio/actions/workflows/ci.yml"><img src="https://github.com/a-Arani/labelprint-studio/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D6.svg" alt="Windows">
</p>

![LabelPrint Studio: editor with a shipping label](docs/screenshots/editor.png)

## Features

- **Familiar editor** — text with any installed font, rich formatting inside a text box, shapes, lines, images, freehand drawing, barcodes (Code 128, EAN-13/8, UPC, Code 39, ITF, Codabar) and QR codes. Undo/redo, snapping, alignment, copy/paste.
- **Import Word and PowerPoint** — `.docx` and `.pptx` files (one file, many files or a whole folder) become editable labels: text boxes, pictures, shapes, lines and rotation are kept.
- **Variables** — serial numbers with prefix/padding, dates (Gregorian, Persian/Jalali, Hijri), text asked at print time, lists, and tables from Excel/CSV. Print "from 1001 to 1500" and every label gets its own number.
- **Templates and products** — design one master label, then make a label for each product by filling in its fields (name, size, price…), one by one or in bulk from Excel. Each product label stays editable.
- **Rolls with several labels per row** — describe your roll (liner width, labels across, label size, gaps, margins) and see it in a diagram. Designs in portrait or landscape are rotated automatically to fit.
- **Print history** — every job is recorded: how many labels, which numbers, on which printer. The next print continues after the last number; a jammed printer can be corrected by hand. Totals per label and per folder.
- **Your work is safe** — automatic save, previous versions of every label, a recycle bin, daily backups (optionally to a second drive) and full logs.
- **10 languages** — English, فارسی, العربية, Español, 简体中文, Français, Deutsch, Русский, Türkçe, Português, with a proper right-to-left interface for Persian and Arabic, and right-to-left text on labels.
- **Runs locally** — no account, no internet, no installation: unzip and run.

## Supported printers

| Printer | How it prints |
| --- | --- |
| **TSC** (tested with the TE200; TE210, TE300, TTP-244, DA200, … use the same language) and other **TSPL/TSPL2** printers | *Direct (TSPL)*: the label is sent as a TSPL bitmap through the Windows print queue — fast and exact, with gap/black-mark sensing, darkness and speed. |
| Any label printer **on the network** that speaks TSPL | *Network (IP)*: TSPL over TCP port 9100. |
| **Any Windows printer** (Zebra, Godex, Xprinter, Brother, office printers, PDF…) | *Windows driver*: printed through the printer's own driver at its resolution. |

Labels are rendered at the printer's resolution (203, 300 or 600 dpi) and converted to sharp black and white, so small text and barcodes stay crisp.

## Download and install

1. Download `LabelPrintStudio-v2.0.0-win64.zip` from the [latest release](https://github.com/a-Arani/labelprint-studio/releases/latest).
2. Unzip it to a permanent folder, for example `C:\LabelPrintStudio`.
3. Run **`Create Desktop Shortcut.bat`** once, then start the app from the desktop shortcut (or `LabelPrint Studio.bat`).

Python is included in the package; nothing else needs to be installed. The app opens in its own window (Microsoft Edge or Chrome in app mode) and works fully offline.

Windows may show a SmartScreen warning for downloaded files: choose *More info → Run anyway*.

## Quick start

1. **New label** → enter the size in millimetres (or pick a common size).
2. Add text, a barcode or a QR code from the tools on the left; format text from the bar at the top.
3. To number labels, add a **Counter** variable in the right panel and insert it into a text or barcode.
4. Choose your **roll** in the right panel (or define one with *Rolls…*: labels per row, sizes and gaps).
5. **Print** → choose the printer and method, enter the number range and print.

For a TSC printer connected by USB use *Direct (TSPL)*. After changing the roll, use *Rolls… → Printer tools → Calibrate sensor*.

<table>
  <tr>
    <td><img src="docs/screenshots/print-two-across.png" alt="Print dialog with a two-across roll"></td>
    <td><img src="docs/screenshots/rolls.png" alt="Roll setup with a diagram"></td>
  </tr>
  <tr>
    <td align="center">Printing on a two-across roll</td>
    <td align="center">Roll setup</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/products.png" alt="Products made from a template"></td>
    <td><img src="docs/screenshots/history.png" alt="Print history"></td>
  </tr>
  <tr>
    <td align="center">Products made from one template</td>
    <td align="center">Print history and totals</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/persian-rtl.png" alt="Persian right-to-left interface"></td>
    <td><img src="docs/screenshots/languages.png" alt="Choosing the interface language"></td>
  </tr>
  <tr>
    <td align="center">Right-to-left interface (Persian)</td>
    <td align="center">10 interface languages</td>
  </tr>
</table>

## Where your data is

Everything is stored in the `data` folder next to the program (or in `%LOCALAPPDATA%\LabelPrintStudio` if the program folder is read-only):

| Folder | Contents |
| --- | --- |
| `data\library` | Your labels and folders (`.lbl` files, JSON) |
| `data\versions` | Previous versions of each label |
| `data\trash` | Deleted labels |
| `data\backups` | Daily backups (last 14 days) |
| `data\logs` | Logs, for troubleshooting |
| `data\history.db` | Print history |

**Updating:** unzip the new version and copy `app`, `web`, `python` and `run.py` over the old folder; `data` is left alone.

## Run from source

Requires Windows and Python 3.10+ (standard library only):

```bash
git clone https://github.com/a-Arani/labelprint-studio.git
cd labelprint-studio
python run.py
```

Run the tests with `pip install -r requirements-dev.txt` and `python -m pytest -q`. Build the Windows package with `./build_package.ps1`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and how to add a translation.

## Contributing

Bug reports, translations and pull requests are welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md). When reporting a printing problem, attach the diagnostics file (*⋯ → App logs → Create diagnostics file*).

## License and credits

LabelPrint Studio is released under the [MIT License](LICENSE).

Designed and developed by **Amirhossein Arani** ([@a-Arani](https://github.com/a-Arani)).

Uses [JsBarcode](https://github.com/lindell/JsBarcode) and [QR Code Generator](https://github.com/kazuhikoarase/qrcode-generator) (both MIT); the Windows package includes [Python](https://www.python.org/) (PSF License). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

TSC is a trademark of TSC Auto ID Technology Co., Ltd. This project is not affiliated with or endorsed by TSC.
