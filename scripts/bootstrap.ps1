[CmdletBinding()]
param(
    [switch]$CheckOnly,

    [string]$RepositoryRoot = (Join-Path $PSScriptRoot "..")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$generatorRelativePath = "extern/license-generator"
$generatorPath = Join-Path $repositoryRoot $generatorRelativePath

function Get-GeneratorState {
    $requiredFiles = @(
        "CMakeLists.txt",
        "LICENSE",
        "src/license_generator/open-license-main.cpp"
    )
    $missingFiles = @($requiredFiles | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $generatorPath $_) -PathType Leaf)
    })

    return [pscustomobject]@{
        Vendored = $missingFiles.Count -eq 0
        MissingFiles = $missingFiles
    }
}

function Get-CmakeAvailability {
    if (Get-Command cmake -CommandType Application -ErrorAction SilentlyContinue) {
        return "available on PATH"
    }

    if ($IsWindows) {
        $programFiles = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFiles)
        foreach ($edition in @("Community", "Professional", "Enterprise", "BuildTools")) {
            $candidate = Join-Path $programFiles "Microsoft Visual Studio/2022/$edition/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return "available from Visual Studio"
            }
        }
    }

    return "not found"
}

function Write-BootstrapReport {
    param(
        [Parameter(Mandatory = $true)]
        [object]$State
    )

    Write-Host "Repository: $repositoryRoot"
    Write-Host "Prerequisite CMake: $(Get-CmakeAvailability)"
    Write-Host "Generator source: $generatorRelativePath"
    Write-Host "Generator vendored: $(if ($State.Vendored) { 'yes' } else { 'no' })"
    Write-Host "Generator missing files: $(if ($State.MissingFiles.Count -eq 0) { '<none>' } else { $State.MissingFiles -join ', ' })"
}

$state = Get-GeneratorState
Write-BootstrapReport -State $state

if ($CheckOnly) {
    if (-not $state.Vendored) {
        exit 1
    }
    exit 0
}

if (-not $state.Vendored) {
    throw "Vendored generator source is incomplete. Restore extern/license-generator from this repository before configuring the build."
}

Write-Host "Vendored generator source is present; no bootstrap action is needed."
