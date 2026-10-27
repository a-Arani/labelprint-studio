LabelPrint Studio
Design and print labels on thermal printers (TSC / TSPL) and any Windows printer. Free and multilingual.
Designed and developed by Amirhossein Arani - https://github.com/a-Arani/labelprint-studio

GETTING STARTED
  1. Put this folder somewhere permanent, for example C:\LabelPrintStudio
     (if you put it in Program Files, your labels are stored in %LOCALAPPDATA%\LabelPrintStudio).
  2. Run "Create Desktop Shortcut.bat" once.
  3. From then on, open the app with the desktop shortcut (or "LabelPrint Studio.bat").
  Nothing else needs to be installed; Python is included in this folder.
  The interface language can be changed with the globe button at the top (English, Persian, Arabic,
  Spanish, Chinese, French, German, Russian, Turkish, Portuguese).

STOPPING THE APP
  Closing the app window stops everything within a few seconds. To be sure nothing of the app is
  running (for example before moving or deleting this folder), run "Stop LabelPrint Studio.bat".
  It also stops copies in other folders and older versions.

UPDATING FROM AN EARLIER VERSION
  Close the app, unpack the new zip and copy the folders app, web, python, the file run.py and the
  .bat files over the old folder. The data folder is not touched, so all labels, settings and history stay.
  Coming from version 1.x: copy its data folder into this folder.

YOUR LABELS ARE SAFE
  Labels are stored in data\library. Deleted labels go to data\trash and are not erased.
  A previous version of each label is kept every 10 minutes and on every Ctrl+S
  (menu "..." > "Previous versions of this label").
  A full backup is made in data\backups every day (the last 14 days are kept);
  "..." > "Backup" can also copy each backup to a second folder (USB stick or another drive).

PRINTING
  - "Direct (TSPL)" is best for a TSC (or other TSPL) printer connected by USB.
  - If nothing prints, choose "Windows driver"; for a printer on the network choose "Network (IP)".
  - "Printer settings" in the print dialog: darkness, speed, offsets and resolution (203/300 dpi).
  - Print one test label first ("Print 1 test label"). If the print is a little off, move it with the
    arrow buttons under "Test and adjust position" and print the whole batch. The shift is for that print only.
  - "..." > "Printer control..." feeds or reverse feeds one label or any distance, calibrates the sensor,
    prints the self-test page or an alignment test with millimetre rulers, and switches tear-off,
    peel-off or cutter mode.

PICTURES AND LOGOS
  Double-click a picture to open the image editor: crop, trim borders, rotate, mirror, brightness,
  contrast, midtones, sharpness, opacity, rounded or circle corners, and remove background.
  For thermal printing choose "Black and white": Threshold for logos and text, Dither for photos.
  "Show as printed" shows the exact dots the printer will make.

ROLLS AND SEVERAL LABELS ACROSS
  In the right panel pick a roll, or define your own with "Rolls...": labels in each print (across and
  down), the size of one label, the gaps and the roll width (all in mm; measure them on the roll).
  A picture shows the roll as it prints, and a wrong width is offered a one-click fix.
  "Print layout test" prints a frame and number on each label so you can check the layout on the roll.
  After changing the roll in the printer, press "Calibrate sensor".
  Automatic rotation: design in portrait or landscape; the app turns the design to fit the roll.

TEMPLATES AND PRODUCTS
  1. Make a sample label and tick "Use as a template for products".
  2. Under Variables add "+ Product field" for each detail (name, size, price...) and insert it into the text.
  3. "New product..." creates a label for one product; each product label can still be edited on its own.
  4. "Products" shows all products like a spreadsheet, and "Create many from Excel / CSV"
     makes many at once (column names = field names).

PRINT HISTORY AND NUMBERS
  Every print is recorded: which label, how many, which numbers, on which printer.
  The print dialog starts counters right after the last number printed for that label.
  If the printer jammed or labels were spoiled: "History" > "Correct" and enter the last good number.

WHEN SOMETHING GOES WRONG
  Everything the app does is logged in data\logs\app.log.
  "..." > "App logs" > "Create diagnostics file" makes a zip on the Desktop that you can attach to a
  bug report: https://github.com/a-Arani/labelprint-studio/issues

KEYBOARD
  Ctrl+S save   Ctrl+P print   Ctrl+Z undo   Ctrl+Y redo   Ctrl+D duplicate
  Ctrl+C / Ctrl+V copy and paste (images can be pasted from the clipboard)
  Delete delete   Arrow keys move 0.5 mm (with Shift 5 mm)   Double-click text to edit

License: MIT (see LICENSE). Third-party components: see THIRD_PARTY_NOTICES.md.
