[CmdletBinding()]
param(
    [switch]$LinkCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$docRoot = Join-Path $repoRoot "doc"
$requirements = Join-Path $docRoot "requirements.txt"
$doxyfile = Join-Path $docRoot "Doxyfile"
$builder = if ($LinkCheck) { "linkcheck" } else { "html" }
$output = Join-Path $docRoot (Join-Path "_build" $builder)

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [scriptblock]$Command
    )

    Write-Host "==> $Name"
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

if (-not (Test-Path $requirements)) {
    throw "Pinned documentation requirements are missing at doc/requirements.txt. Regenerate them with 'uv pip compile --generate-hashes doc/requirements.in --output-file doc/requirements.txt'."
}

$doxygen = Get-Command doxygen -ErrorAction SilentlyContinue
if ($null -eq $doxygen) {
    throw "Doxygen is required for npm run check:docs. Install Doxygen locally or run the Ubuntu docs CI job; Sphinx must not consume stale XML."
}

$uv = Get-Command uv -ErrorAction SilentlyContinue
if ($null -eq $uv) {
    throw "uv is required for npm run check:docs. Install uv, then rerun this command."
}

Push-Location $repoRoot
try {
    Invoke-Checked "Doxygen XML" {
        & $doxygen.Source $doxyfile
    }
    Invoke-Checked "Sphinx $builder" {
        & $uv.Source run --no-project --with-requirements $requirements python -m sphinx -b $builder -W --keep-going $docRoot $output
    }
} finally {
    Pop-Location
}
