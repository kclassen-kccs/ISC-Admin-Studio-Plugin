<#
.SYNOPSIS
  Installs or updates the Admin Studio plugin on one ISC tenant (Windows).

.DESCRIPTION
  Run from the unzipped package folder (next to sp-ui-plugin.json):
    .\install.ps1            update: upload the build, then push the manifest
    .\install.ps1 -Create    first install on a tenant: register, then the same

  Needs the SailPoint CLI (sail.exe) on PATH and the tenant's API client in
  the environment; it never stores them anywhere:
    $env:SAIL_BASE_URL      = "https://<tenant>.api.identitynow.com"
    $env:SAIL_CLIENT_ID     = "<client id>"
    $env:SAIL_CLIENT_SECRET = "<client secret>"
  The Anthropic API key is not part of the install: an admin enters it on
  Studio Settings > Preferences inside the plugin ("Save to ISC").

  If PowerShell refuses to run the script, start it with
    powershell -ExecutionPolicy Bypass -File .\install.ps1
#>
[CmdletBinding()]
param(
  [switch]$Create
)
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

if (-not (Test-Path "sp-ui-plugin.json") -or -not (Test-Path "client\build\index.html")) {
  Write-Error "Run this from the unzipped package folder (sp-ui-plugin.json and client\build must be here)."
  exit 1
}

if (-not (Get-Command sail -ErrorAction SilentlyContinue)) {
  Write-Error @"
The SailPoint CLI (sail) is not on PATH. Download a Windows release from
https://github.com/sailpoint-oss/sailpoint-cli/releases (or build it with
'go install github.com/sailpoint-oss/sailpoint-cli@latest' and rename the
binary to sail.exe), then put its folder on PATH.
"@
  exit 1
}
foreach ($name in "SAIL_BASE_URL", "SAIL_CLIENT_ID", "SAIL_CLIENT_SECRET") {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    Write-Error "$name is not set. Set the tenant's API client first (see the header of this script), or run 'sail set auth'."
    exit 1
  }
}
$env:SAIL_EXPERIMENTAL_UI_PLUGINS = "1"

function Invoke-Sail {
  param([string[]]$Arguments)
  & sail @Arguments
  if ($LASTEXITCODE -ne 0) { throw "sail $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

if ($Create) {
  # No --private and no allowed-user list: ISC controls who may open the
  # plugin. A private registration locks it to the deploying API client and
  # every other user gets "Forbidden" at launch.
  Write-Host "Registering the plugin on $env:SAIL_BASE_URL ..."
  Invoke-Sail @("ui-plugins", "create")
}

Write-Host "Uploading the build ..."
Invoke-Sail @("ui-plugins", "upload")
Write-Host "Pushing the manifest ..."
Invoke-Sail @("ui-plugins", "push-manifest")

Write-Host @"

Done. The plugin has no navigation entry yet; open it at
  https://<tenant>.identitynow.com/ui/plugin/<instance id>
('sail ui-plugins list' shows the instance id). Then, as an admin, open
Studio Settings > Preferences in the plugin and use "Save to ISC" to put the
Anthropic API key into the tenant's "Admin Studio AI Key" parameter; that
also creates the "Admin Studio AI Connection" parameter and the "Admin
Studio AI Query" workflow (which must stay disabled).
"@
