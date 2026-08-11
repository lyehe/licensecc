[CmdletBinding()]
param(
    [ValidateSet(
        "dev-debug",
        "dev-device-identity-off",
        "dev-device-identity-test",
        "dev-release",
        "ci-linux-debug",
        "ci-linux-release",
        "ci-linux-core",
        "ci-linux-device-identity-test",
        "ci-linux-debug-tpm2-capability",
        "ci-linux-release-tpm2-capability",
        "ci-linux-debug-tpm2",
        "ci-linux-release-tpm2",
        "ci-windows-msvc-debug-dynamic",
        "ci-windows-msvc-debug-static",
        "ci-windows-msvc-release-dynamic",
        "ci-windows-msvc-release-static",
        "ci-windows-msvc-debug-dynamic-tpm",
        "ci-windows-msvc-debug-static-tpm",
        "ci-windows-msvc-release-dynamic-tpm",
        "ci-windows-msvc-release-static-tpm",
        "ci-windows-msvc",
        "ci-windows-device-identity-test"
    )]
    [string]$Preset = "dev-debug",

    [switch]$SkipCore,

    [switch]$SkipTests,

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
$requiredNpmVersion = "10.9.8"

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

    $rootLock = Join-Path $repoRoot "package-lock.json"
    if (-not (Test-Path $rootLock)) {
        throw "Root package-lock.json not found; run npm ci from the repository root."
    }

    $actualNpmVersion = (& npm --version 2>$null).Trim()
    $npmExitCode = $LASTEXITCODE
    if ($npmExitCode -ne 0 -or $actualNpmVersion -ne $requiredNpmVersion) {
        throw "npm $requiredNpmVersion is required for the root workspace; found '$actualNpmVersion'. Install it globally with 'npm install --global npm@$requiredNpmVersion' and retry."
    }

    $rootInstallMarker = Join-Path $repoRoot "node_modules/.package-lock.json"
    if (-not (Test-Path $rootInstallMarker)) {
        Invoke-Step "Install root workspace dependencies" {
            npm ci
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

    $manifestPath = Join-Path $PackageDir "package.json"
    $workspaceName = (Get-Content -Raw $manifestPath | ConvertFrom-Json).name
    if ([string]::IsNullOrWhiteSpace($workspaceName)) {
        throw "Workspace package name is missing from $manifestPath"
    }

    Invoke-Step "$Name $Script" {
        npm run $Script --workspace $workspaceName
    }
}

Push-Location $repoRoot
try {
    if (-not $SkipCore) {
        $purityScript = Join-Path $PSScriptRoot "check-build-purity.ps1"
        Invoke-Step "Core build purity $Preset" {
            & $purityScript -Preset $Preset -SkipTests:$SkipTests
        }
    } elseif (-not $SkipTests) {
        Write-Host "==> Skip core CMake configure/build/test"
    }

    $backendDir = $null
    if ($IncludeBackend -or $IncludeServices -or $IncludeUi -or $IncludeSchemaParity -or $IncludeE2E -or $IncludeDryRun) {
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

    if ($null -ne $backendDir) {
        Invoke-Step "Tracked secret scan" {
            npm run scan:secrets
        }
        Invoke-Step "JavaScript and TypeScript lint" {
            npm run lint
        }
        Invoke-Step "JavaScript and TypeScript typecheck" {
            npm run typecheck
        }
        Invoke-Step "Architecture boundary check" {
            npm run check:architecture
        }
        Invoke-Step "Canonical contract check" {
            npm run test:contracts
        }
    }

    if ($IncludeBackend -or $IncludeServices) {
        Invoke-NpmScript "Backend" $backendDir "test"
        Invoke-NpmScript "Backend" $backendDir "test:sql"
        Invoke-NpmScript "Backend" $backendDir "test:pg"
    }

    if ($IncludeServices) {
        Invoke-NpmScript "Admin portal" $adminDir "test"
        Invoke-NpmScript "Admin portal" $adminDir "test:sql"

        Invoke-NpmScript "Customer portal" $customerPortalDir "test"

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
        Invoke-Step "Install retained Playwright browser revisions" {
            npm run setup:browsers
        }
        Invoke-Step "Browser E2E tests" {
            npm run test:e2e
        }
    }

    if ($IncludeDryRun) {
        Invoke-Step "Credential-free Worker dry-runs" {
            npm run check:dry-run
        }
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
        Invoke-Step "Python and .NET SDK tests" {
            npm run test:sdks
        }
    }

} finally {
    Pop-Location
}
