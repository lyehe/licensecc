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
        if ($AllowDirtyGeneratorSubmodule) {
            Write-Host "==> -AllowDirtyGeneratorSubmodule is retained for compatibility; the core checker preserves its initial source snapshot."
        }
        $purityScript = Join-Path $PSScriptRoot "check-build-purity.ps1"
        Invoke-Step "Core build purity $Preset" {
            & $purityScript -Preset $Preset -SkipTests:$SkipTests
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

} finally {
    Pop-Location
}
