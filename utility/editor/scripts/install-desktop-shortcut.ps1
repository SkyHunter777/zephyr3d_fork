[CmdletBinding()]
param(
  [string]$ShortcutPath = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Zephyr3D Editor (Dev).lnk')
)

$editorRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$launcherScript = (Resolve-Path (Join-Path $PSScriptRoot 'launch-electron-dev.ps1')).Path
$iconPath = (Resolve-Path (Join-Path $editorRoot 'electron\icon.ico')).Path
$powershellExe = (Get-Command powershell.exe -ErrorAction Stop).Source

$shortcutDirectory = Split-Path -Parent $ShortcutPath
if ($shortcutDirectory) {
  New-Item -ItemType Directory -Force -Path $shortcutDirectory | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $powershellExe
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherScript`""
$shortcut.WorkingDirectory = $editorRoot
$shortcut.IconLocation = $iconPath
$shortcut.Description = 'Launches the Zephyr3D Editor Electron dev runtime for this workspace.'
$shortcut.Save()

Write-Output "Created shortcut: $ShortcutPath"
