# Creates a "LabelPrint Studio" shortcut on the desktop
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$shell = New-Object -ComObject WScript.Shell
$desk = [Environment]::GetFolderPath("Desktop")
$lnk = $shell.CreateShortcut((Join-Path $desk "LabelPrint Studio.lnk"))
$lnk.TargetPath = Join-Path $root "python\pythonw.exe"
$lnk.Arguments = '"' + (Join-Path $root "run.py") + '"'
$lnk.WorkingDirectory = $root
$lnk.IconLocation = (Join-Path $root "app\icon.ico") + ",0"
$lnk.Description = "LabelPrint Studio - design and print labels on thermal printers"
$lnk.Save()
Write-Host "The LabelPrint Studio shortcut was created on the desktop."
