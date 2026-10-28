# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [2.3.0] - 2026-10-28

### Added
- **The whole width of the roll on the canvas.** For a roll with several labels in each print, the label panel offers *Labels across*:
  - **All the same**: you design one label; the canvas shows the roll with the other labels as live copies (*Show the whole width* can hide them).
  - **Each one different**: all the labels of a print are designed together on one canvas, each with its outline and number; the gaps between them are shaded (they are not printed). Switching copies label 1 to every label; switching back keeps label 1 (after asking) and can be undone.
- Printing a design with every label different draws it once per record and cuts it into its labels, so the print shift, column offsets, test print and preview work as before. It turns 180° at most.
- Changing the roll of such a design moves every label's content to its new place; a new label gets a copy of label 1.

## [2.2.1] - 2026-10-28

### Changed
- **A label and its roll stay in step everywhere.** *New label* asks for the roll (the one used last comes first) and takes the size of one of its labels. *Rolls…* in the label panel saves with **Save and use for this label**, and the roll the label uses is marked *This label*. When the size of a roll's labels changes, labels on that roll follow. If a label's size differs from its roll's labels, the panel says so and fixes it with one click (undoable). Printer control starts with the label's roll, like the print window.
- The roll picture shows **one print** only (the labels across, and down if set), with the roll going on above and below, so *Down* matches what you see.

## [2.2.0] - 2026-10-27

### Changed
- **A new Rolls window.** The roll is described the way you see it: **labels in each print** (across × down, with − and + buttons and a small picture), **the size of one label**, the gaps between labels side by side and down the roll, and the **roll width** with *Labels in the middle of the roll*. A large picture shows the roll with the labels numbered in print order, marks what one print contains, and highlights each size while you edit it.
- When the labels do not fit on the roll, the window says by how much and offers two fixes: make the roll wider, or each label narrower.
- *Start from a common size*: single, two-across and three-across rolls to start from. A roll's name follows its layout until you rename it.
- The paper type is chosen from three pictures (gaps, black mark, continuous); corner radius, the fine offset of each column and the gap offset are under *More*.

### Added
- A print can hold more than one row of labels (*Down* in *Labels in each print*); the print preview, the test print, the layout test and the printer's paper size follow it. Nearly every roll uses 1.

### Fixed
- A stray "null" under the Rolls form.
- Number boxes no longer show the browser's spin arrows over their unit.

## [2.1.7] - 2026-10-27

### Changed
- Library: a click on empty space in the list unselects the folder, so the buttons above it (new label, new folder, import) act on the top level again. A selected (blue) folder is where they act; the highlighted *Library* title shows the top level is selected.

## [2.1.6] - 2026-10-27

### Fixed
- An old folder could not be deleted although every file in it could: the window of *Create Desktop Shortcut.bat* (or *Stop LabelPrint Studio.bat*) waiting at "Press any key" kept the folder in use. Both now wait outside the app folder.
- *Stop LabelPrint Studio* also finds a copy whose files were already deleted while it was running.
- An app window left open from an earlier start (for example one an older version opened) is closed when the app starts, so the new window gets a browser of its own; Edge's "restore pages" bar is not shown after that.

## [2.1.5] - 2026-10-27

### Added
- **`Stop LabelPrint Studio.bat`** in the app folder (and `run.py --stop`): ends every running part of the app (servers of any copy or version, and app windows), for example before moving or deleting the folder.

### Fixed
- Starting the app while a copy from another folder or an older version is still running replaced that copy instead of connecting to it, which kept the old version running and its folder locked.
- The app window is started outside the app folder, so the browser never keeps that folder in use.
- After the computer wakes from sleep, the app no longer stops while its window is open.
- If the app stops while its window is still open, the window is closed too.

## [2.1.4] - 2026-10-27

### Added
- Printer control: **Reverse feed one label** can go back a little further than one label (*Extra back for one label*, in mm) and *then* come forward until the sensor finds the gap (`HOME`) or to the start of the next label (`FORMFEED`). The paper then stops exactly at a label, however far the last feed really went. Both settings are kept for each printer; the defaults (0 mm, stop there) behave as before.

## [2.1.3] - 2026-10-27

### Added
- Printer control: **Reverse feed one label** pulls the paper back by exactly one label and its gap (or black mark), taken from the selected roll. TSPL has no command for this, so it is sent as `BACKFEED` with that length.

### Changed
- Printer control: one-label moves and distance moves are on separate rows.

## [2.1.2] - 2026-10-27

### Fixed
- Renaming a folder or label to a name with a character that Windows does not allow in names (`* / \ : ? " < > |`) seemed to do nothing: those characters became spaces, so `50*100` stayed `50 100`. They now become look-alike characters and the name keeps its look: `50*100` becomes `50×100`, `50/100` becomes `50∕100`.
- A `/` in the name of a new folder or label no longer creates a sub-folder.
- When another program (such as File Explorer or OneDrive) holds a folder or label, renaming, moving or deleting it waits a moment and then says so clearly, instead of showing an internal error. A folder can no longer end up half-moved.
- Names made of numbers, such as `50×100`, no longer read backwards in a right-to-left interface.
- Names that Windows keeps for devices (`CON`, `NUL`, `COM1`…) get a `_` so they can be used.

## [2.1.1] - 2026-10-27

### Changed
- Closing the app window now stops everything within a few seconds: the app window runs in its own browser profile with background mode off, the launcher watches it, and the server stops as soon as the last window is gone (a reload or language switch keeps it running). Before, the server waited up to 3 minutes, and Edge could keep running in the background.
- The start-up screen stays a little longer (3 seconds).

## [2.1.0] - 2026-10-27

### Added
- **Image editor** (double-click a picture, or *Edit image…*): crop with handles and aspect ratios, trim plain borders, rotate and mirror, brightness, contrast, midtones, sharpness, soften, auto contrast, opacity, rounded or circular corners, and a hold-to-compare button. All edits are non-destructive.
- **Black and white for thermal printing** per picture: threshold for logos and text, smooth or crisp dithering for photos, or an ordered pattern, with an adjustable black level and a "show as printed" preview at the printer's real dots.
- **Remove background**: make white, or any colour picked with the eyedropper, transparent.
- **Test print and position nudge** in the print dialog: print one test label (not counted in the history), move the print up, down, left or right in 0.1–2 mm steps for this print, and see a warning when part of the print would fall outside the label.
- **Printer control** window: feed one label, feed or reverse feed a distance, go to the start of the label, calibrate or auto-detect the paper, print the self-test page or an alignment test with millimetre rulers, beep, choose tear-off / peel-off / cutter mode, send any TSPL command, and restore factory settings.

### Changed
- Pictures in black-and-white mode are processed at exactly the printer's dots, so the printout matches the screen dot for dot.
- The fixed offsets in *Printer settings* are now labelled as fixed, to tell them apart from the per-print nudge.

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

[2.3.0]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.3.0
[2.2.1]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.2.1
[2.2.0]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.2.0
[2.1.7]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.1.7
[2.1.6]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.1.6
[2.1.5]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.1.5
[2.1.4]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.1.4
[2.1.3]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.1.3
[2.1.2]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.1.2
[2.1.1]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.1.1
[2.1.0]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.1.0
[2.0.0]: https://github.com/a-Arani/labelprint-studio/releases/tag/v2.0.0
