# Registers the native messaging host so the extension can launch it, on Windows.
# Usage: .\install.ps1 <extension-id>
# (Get the extension ID from brave://extensions or chrome://extensions
# after loading the unpacked extension with Developer Mode on.)

param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$Dir = $PSScriptRoot
$HostName = "com.erpautologin.helper"
$ManifestSrc = Join-Path $Dir "$HostName.json"
$ManifestOut = Join-Path $Dir "$HostName.json.installed"
$LauncherPath = Join-Path $Dir "run_native_host.bat"

$content = (Get-Content $ManifestSrc -Raw) `
    -replace "REPLACED_BY_INSTALL_SCRIPT_PATH", ($LauncherPath -replace '\\', '\\\\') `
    -replace "REPLACED_BY_INSTALL_SCRIPT_EXTID", $ExtensionId

# Windows PowerShell 5.1's "UTF8" encoding writes a BOM, which Chrome's JSON
# manifest parser can choke on. Write plain UTF-8 without a BOM explicitly.
[System.IO.File]::WriteAllText($ManifestOut, $content, (New-Object System.Text.UTF8Encoding $false))

# Native messaging hosts on Windows are located via a per-user registry key
# whose default value points at the manifest file (no fixed folder like mac/Linux).
$RegPaths = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$HostName"
)

foreach ($RegPath in $RegPaths) {
    New-Item -Path $RegPath -Force | Out-Null
    Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestOut
    Write-Host "Registered host manifest: $RegPath -> $ManifestOut"
}

Write-Host "Done. Reload the extension and try the popup button."
Write-Host "Diagnostics log: $env:LOCALAPPDATA\erp-auto-login\host.log"
