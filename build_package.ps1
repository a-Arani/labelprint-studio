# Builds the portable Windows package with the official Python embeddable distribution:
#   dist\LabelPrintStudio\  and  dist\LabelPrintStudio-v<version>-win64.zip
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PyVer = "3.12.10"
$PyZip = Join-Path $Root "build\python-$PyVer-embed-amd64.zip"
$Dist = Join-Path $Root "dist"
$Name = "LabelPrintStudio"
$Stage = Join-Path $Dist $Name
$Version = (Select-String -Path (Join-Path $Root "app\meta.py") -Pattern 'VERSION = "([\d.]+)"').Matches[0].Groups[1].Value

if (-not (Test-Path $PyZip)) {
  New-Item -ItemType Directory -Force (Split-Path $PyZip) | Out-Null
  Write-Host "Downloading Python $PyVer embeddable..."
  Invoke-WebRequest "https://www.python.org/ftp/python/$PyVer/python-$PyVer-embed-amd64.zip" -OutFile $PyZip -UseBasicParsing
}

if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force $Stage | Out-Null
Expand-Archive $PyZip -DestinationPath (Join-Path $Stage "python")

foreach ($d in @("app", "web")) {
  Copy-Item (Join-Path $Root $d) (Join-Path $Stage $d) -Recurse
}
Get-ChildItem $Stage -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force
foreach ($f in @("run.py", "LICENSE", "THIRD_PARTY_NOTICES.md")) {
  Copy-Item (Join-Path $Root $f) $Stage
}
Get-ChildItem (Join-Path $Root "packaging") -File | Where-Object { $_.Name -ne "make_icon.py" } |
  ForEach-Object { Copy-Item $_.FullName $Stage }

$Zip = Join-Path $Dist "$Name-v$Version-win64.zip"
if (Test-Path $Zip) { Remove-Item $Zip -Force }
# PowerShell 5.1 (Compress-Archive, ZipFile) writes "\" in entry names; Python's zipfile writes the standard "/"
& (Join-Path $Stage "python\python.exe") -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], sys.argv[3])" ($Zip -replace '\.zip$', '') $Dist $Name
$size = [math]::Round((Get-Item $Zip).Length / 1MB, 1)
Write-Host "Done: $Zip ($size MB)"
