[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-BootstrapCondition {
    param(
        [Parameter(Mandatory = $true)]
        [bool]$Condition,

        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

$bootstrap = Join-Path $PSScriptRoot "bootstrap.ps1"
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("licensecc-bootstrap-" + [guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
    $generatorRoot = Join-Path $fixtureRoot "extern/license-generator"
    New-Item -ItemType Directory -Force -Path (Join-Path $generatorRoot "src/license_generator") | Out-Null
    Set-Content -LiteralPath (Join-Path $generatorRoot "CMakeLists.txt") -Value "cmake_minimum_required(VERSION 3.16)" -NoNewline
    Set-Content -LiteralPath (Join-Path $generatorRoot "LICENSE") -Value "BSD-3-Clause fixture" -NoNewline
    Set-Content -LiteralPath (Join-Path $generatorRoot "src/license_generator/open-license-main.cpp") -Value "int main() { return 0; }" -NoNewline

    $before = [string]::Join("`n", @(Get-ChildItem -LiteralPath $fixtureRoot -File -Recurse | ForEach-Object {
        "$(($_.FullName).Substring($fixtureRoot.Length)):$((Get-FileHash -Algorithm SHA256 $_.FullName).Hash)"
    }))
    $output = @(& pwsh -NoProfile -File $bootstrap -CheckOnly -RepositoryRoot $fixtureRoot 2>&1)
    $exitCode = $LASTEXITCODE
    $after = [string]::Join("`n", @(Get-ChildItem -LiteralPath $fixtureRoot -File -Recurse | ForEach-Object {
        "$(($_.FullName).Substring($fixtureRoot.Length)):$((Get-FileHash -Algorithm SHA256 $_.FullName).Hash)"
    }))

    Assert-BootstrapCondition -Condition ($exitCode -eq 0) -Message "check-only should accept complete vendored generator source"
    Assert-BootstrapCondition -Condition (@($output -match "Generator vendored: yes").Count -gt 0) -Message "complete vendored generator source was not recognized"
    Assert-BootstrapCondition -Condition ($before -eq $after) -Message "check-only changed fixture source state"

    Remove-Item -LiteralPath (Join-Path $generatorRoot "LICENSE") -Force
    $missingOutput = @(& pwsh -NoProfile -File $bootstrap -CheckOnly -RepositoryRoot $fixtureRoot 2>&1)
    $missingExitCode = $LASTEXITCODE
    Assert-BootstrapCondition -Condition ($missingExitCode -eq 1) -Message "check-only should reject incomplete vendored generator source"
    Assert-BootstrapCondition -Condition (@($missingOutput -match "Generator vendored: no").Count -gt 0) -Message "missing vendored source was not reported"

    Write-Host "Vendored generator bootstrap fixture passed."
} finally {
    if (Test-Path -LiteralPath $fixtureRoot) {
        Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
    }
}
