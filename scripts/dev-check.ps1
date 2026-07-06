[CmdletBinding()]
param(
    [ValidateSet(
        "dev-debug",
        "dev-release",
        "ci-linux-debug",
        "ci-linux-release",
        "ci-linux-core",
        "ci-windows-msvc-debug-dynamic",
        "ci-windows-msvc-debug-static",
        "ci-windows-msvc-release-dynamic",
        "ci-windows-msvc-release-static",
        "ci-windows-msvc"
    )]
    [string]$Preset = "dev-debug",

    [switch]$SkipCore,

    [switch]$SkipTests,

    [switch]$AllowDirtyGeneratorSubmodule,

    [switch]$IncludeBackend,

    [switch]$IncludeServices,

    [switch]$IncludeSdks,

    [switch]$IncludeUi,

    [switch]$IncludeE2E,

    [switch]$IncludeDryRun,

    [switch]$IncludeSchemaParity
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$generatorPatchApplied = $false

function Invoke-Step {
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

function Test-NativeCommand {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Command
    )

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "SilentlyContinue"
    try {
        & $Command *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Get-RequiredPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    $resolvedPath = Join-Path $repoRoot $Path
    if (-not (Test-Path $resolvedPath)) {
        throw "$Description not found at $Path"
    }

    return $resolvedPath
}

function Ensure-NpmPackage {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$RelativePath
    )

    $packageDir = Get-RequiredPath $RelativePath "$Name package"
    if (-not (Test-Path (Join-Path $packageDir "package.json"))) {
        throw "$Name package.json not found at $RelativePath"
    }

    if (-not (Test-Path (Join-Path $packageDir "node_modules"))) {
        Invoke-Step "Install $Name dependencies" {
            npm --prefix $packageDir ci
        }
    }

    return $packageDir
}

function Invoke-NpmScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$PackageDir,

        [Parameter(Mandatory = $true)]
        [string]$Script
    )

    Invoke-Step "$Name $Script" {
        npm --prefix $PackageDir run $Script
    }
}

Push-Location $repoRoot
try {
    if (-not $SkipCore) {
        if (-not (Test-Path "extern/license-generator/CMakeLists.txt")) {
            throw "Missing extern/license-generator. Run: git submodule update --init --recursive"
        }

        if (-not (Test-Path "patches/license-generator-cstdint.patch")) {
            throw "Missing patches/license-generator-cstdint.patch"
        }

        $generatorStatus = git -C extern/license-generator status --short --untracked-files=normal
        if ($LASTEXITCODE -ne 0) {
            throw "Could not inspect extern/license-generator status"
        }
        if ($generatorStatus -and -not $AllowDirtyGeneratorSubmodule) {
            Write-Host "extern/license-generator has local modifications. Preserve, commit, or clean that submodule before running the default dev check."
            Write-Host "Use -AllowDirtyGeneratorSubmodule only when intentionally testing generator WIP."
            $generatorStatus | ForEach-Object { Write-Host "  $_" }
            exit 1
        }

        if ($env:OS -eq "Windows_NT") {
            $boostCandidates = @(
                $env:BOOST_ROOT,
                "C:\local\boost_1_84_0",
                "C:\local\boost"
            ) | Where-Object { $_ -and (Test-Path (Join-Path $_ "boost")) }

            if (-not $boostCandidates) {
                Write-Warning "Boost was not found in BOOST_ROOT, C:\local\boost_1_84_0, or C:\local\boost. Configure may fail until Boost is installed or BOOST_ROOT is set."
            }
        }

        $patchPath = "../../patches/license-generator-cstdint.patch"
        $patchAlreadyApplied = Test-NativeCommand {
            git -C extern/license-generator apply --reverse --check $patchPath
        }

        if ($patchAlreadyApplied) {
            Write-Host "==> Vendored license-generator patch already applied"
        } else {
            $patchCanApply = Test-NativeCommand {
                git -C extern/license-generator apply --check $patchPath
            }

            if (-not $patchCanApply) {
                throw "Vendored license-generator patch can neither apply nor reverse cleanly"
            }

            Invoke-Step "Apply vendored license-generator patch" {
                git -C extern/license-generator apply $patchPath
            }
            $generatorPatchApplied = $true
        }

        Invoke-Step "Configure $Preset" {
            cmake --preset $Preset
        }

        Invoke-Step "Build $Preset" {
            cmake --build --preset $Preset
        }

        if (-not $SkipTests) {
            Invoke-Step "Test $Preset" {
                ctest --preset $Preset --no-tests=error
            }
        }
    } elseif (-not $SkipTests) {
        Write-Host "==> Skip core CMake configure/build/test"
    }

    $backendDir = $null
    if ($IncludeBackend -or $IncludeServices -or $IncludeSchemaParity -or $IncludeE2E -or $IncludeDryRun) {
        $backendDir = Ensure-NpmPackage "Backend" "services/cloudflare-licensing-backend"
    }

    $adminDir = $null
    if ($IncludeServices -or $IncludeUi -or $IncludeE2E -or $IncludeDryRun) {
        $adminDir = Ensure-NpmPackage "Admin portal" "services/cloudflare-license-admin"
    }

    $customerPortalDir = $null
    if ($IncludeServices -or $IncludeUi -or $IncludeE2E -or $IncludeDryRun) {
        $customerPortalDir = Ensure-NpmPackage "Customer portal" "services/cloudflare-customer-portal"
    }

    $backupDir = $null
    if ($IncludeServices -or $IncludeDryRun) {
        $backupDir = Ensure-NpmPackage "D1 backup" "services/cloudflare-d1-backup"
    }

    if ($IncludeBackend -or $IncludeServices) {
        Invoke-NpmScript "Backend" $backendDir "lint"
        Invoke-NpmScript "Backend" $backendDir "test"
        Invoke-NpmScript "Backend" $backendDir "test:sql"
        Invoke-NpmScript "Backend" $backendDir "test:pg"
    }

    if ($IncludeServices) {
        Invoke-NpmScript "Admin portal" $adminDir "lint"
        Invoke-NpmScript "Admin portal" $adminDir "test"
        Invoke-NpmScript "Admin portal" $adminDir "test:sql"

        Invoke-NpmScript "Customer portal" $customerPortalDir "lint"
        Invoke-NpmScript "Customer portal" $customerPortalDir "test"

        Invoke-NpmScript "D1 backup" $backupDir "lint"
        Invoke-NpmScript "D1 backup" $backupDir "test"
    }

    if ($IncludeUi) {
        Invoke-NpmScript "Admin portal" $adminDir "test:ui"
        Invoke-NpmScript "Customer portal" $customerPortalDir "test:ui"
    }

    if ($IncludeSchemaParity) {
        Invoke-NpmScript "Backend" $backendDir "schema:parity"
        Invoke-NpmScript "Backend" $backendDir "schema:parity:pg"
    }

    if ($IncludeE2E) {
        Invoke-NpmScript "Backend" $backendDir "test:e2e"
        Invoke-NpmScript "Admin portal" $adminDir "test:e2e"
        Invoke-NpmScript "Customer portal" $customerPortalDir "test:e2e"
    }

    if ($IncludeDryRun) {
        Invoke-NpmScript "Backend" $backendDir "dry-run"
        Invoke-NpmScript "Admin portal" $adminDir "dry-run"
        Invoke-NpmScript "Customer portal" $customerPortalDir "dry-run"
        Invoke-NpmScript "D1 backup" $backupDir "dry-run"
    }

    if ($SkipTests) {
        Write-Host "==> Skipped core CTest only; package checks still run when their Include* switches are set."
    }

    if ($SkipCore -and -not ($IncludeBackend -or $IncludeServices -or $IncludeSdks -or $IncludeUi -or $IncludeE2E -or $IncludeDryRun -or $IncludeSchemaParity)) {
        Write-Warning "No checks were selected because -SkipCore was used without any Include* switches."
    }

    if ($IncludeBackend -and -not $IncludeServices) {
        Write-Host "==> -IncludeBackend is kept as a backend-only compatibility alias. Use -IncludeServices for all service packages."
    }

    if ($IncludeE2E -and -not $IncludeUi) {
        Write-Host "==> E2E suites were run; use -IncludeUi as well when you want fast UI workflow tests in the same run."
    }

    if ($IncludeServices -and -not $IncludeUi) {
        Write-Host "==> Service checks exclude UI workflow tests by default. Add -IncludeUi for Vite UI workflow tests."
    }

    if ($IncludeServices -and -not $IncludeE2E) {
        Write-Host "==> Service checks exclude browser E2E by default. Add -IncludeE2E for Playwright coverage."
    }

    if ($IncludeServices -and -not $IncludeSchemaParity) {
        Write-Host "==> Service checks exclude schema parity by default. Add -IncludeSchemaParity for D1/PostgreSQL parity gates."
    }

    if ($IncludeDryRun) {
        $localConfigs = @(
            "services/cloudflare-licensing-backend/wrangler.toml",
            "services/cloudflare-license-admin/wrangler.toml",
            "services/cloudflare-customer-portal/wrangler.toml",
            "services/cloudflare-d1-backup/wrangler.jsonc"
        ) | Where-Object { Test-Path $_ }

        if ($localConfigs) {
            Write-Host "==> Local Wrangler configs detected; dry-run commands intentionally use tracked example configs where available."
            $localConfigs | ForEach-Object { Write-Host "  $_" }
        }
    }

    if ($IncludeSdks) {
        $pythonSdkDir = Join-Path $repoRoot "sdks/python"
        $dotnetSdkSolution = Join-Path $repoRoot "sdks/dotnet/Licensecc.Client.sln"

        if (Test-Path (Join-Path $pythonSdkDir "pyproject.toml")) {
            Invoke-Step "Python SDK tests" {
                uv run --directory $pythonSdkDir pytest
            }
        } else {
            Write-Warning "Python SDK package not found at sdks/python"
        }

        if (Test-Path $dotnetSdkSolution) {
            Invoke-Step ".NET SDK tests" {
                dotnet test $dotnetSdkSolution
            }
        } else {
            Write-Warning ".NET SDK solution not found at sdks/dotnet/Licensecc.Client.sln"
        }
    }

    $status = git status --short
    if ($LASTEXITCODE -ne 0) {
        throw "git status failed with exit code $LASTEXITCODE"
    }

    $sourceLikeUntracked = $status | Where-Object { $_ -match "^\?\? (sdks/|services/)" }
    if ($sourceLikeUntracked) {
        Write-Warning "Untracked service/SDK source-like directories are present. Preserve or merge them intentionally before cleanup."
        $sourceLikeUntracked | ForEach-Object { Write-Warning $_ }
    }
} finally {
    if ($generatorPatchApplied) {
        Write-Host "==> Revert temporary vendored license-generator patch"
        git -C extern/license-generator apply --reverse $patchPath
        if ($LASTEXITCODE -ne 0) {
            Write-Warning "Could not reverse temporary vendored generator patch. Inspect extern/license-generator."
        }
    }

    Pop-Location
}
