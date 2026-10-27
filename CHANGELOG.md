# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-10-26

First public release as **LabelPrint Studio**.

### Added
- Interface in 10 languages: English, Persian, Arabic, Spanish, Simplified Chinese, French, German, Russian, Turkish and Portuguese, with full right-to-left layout for Persian and Arabic. Pick the language from the globe button or the About dialog.
- Start-up splash screen, new logo and app icon, and an About dialog.
- Hijri calendar for date variables (next to Gregorian and Persian/Jalali), and Arabic-Indic digits for counters and dates.
- Chinese/Japanese/Korean font group in the font picker.
- Server errors carry a code, so messages appear in the user's language.

### Changed
- New text boxes use automatic direction, so Latin, Arabic-script and CJK text each lay out correctly.
- The app stores its data next to the program, or in `%LOCALAPPDATA%\LabelPrintStudio` when that folder is read-only.
- Logs and code comments are in English.

## [1.2.0] - 2026-10-26

### Added
- Roll types: liner width, labels per row (multi-column rolls), label size, gaps between columns and rows, margins, corner radius and gap/black-mark/continuous media, with a live diagram.
- Automatic rotation: a design in portrait or landscape is turned to fit the label on the roll.
- Printer tools per roll: sensor calibration, feed and a layout test print.

## [1.1.0] - 2026-10-26

### Added
- Templates and products: one master label, with product labels made from it by filling in fields (one by one or from Excel/CSV).
- Print history per label: what was printed, where a counter stopped, and manual correction of the last number.
- Printed totals per label and folder in the library.
- Automatic versions of each label, daily backups and a diagnostics file.
- Full logging of the server and the interface.

## [1.0.0] - 2026-10-26

### Added
- Label editor with text, shapes, lines, images, freehand drawing, barcodes and QR codes, using the fonts installed on the computer.
- Import of Word (.docx) and PowerPoint (.pptx) files as editable labels.
- Folders, variables (counters, dates, text, lists, Excel/CSV tables).
- Printing to TSC/TSPL printers directly, through any Windows printer driver, or over the network.

[2.0.0]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.0.0
