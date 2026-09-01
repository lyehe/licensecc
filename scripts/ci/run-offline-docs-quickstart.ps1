[CmdletBinding()]
param(
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Reuse the repository's source fingerprint and CMake tool-resolution contract.
# Dot-sourcing this file is intentionally safe: its executable entry point is
# guarded by its invocation name.
. (Join-Path $PSScriptRoot "..\check-build-purity.ps1")

function Get-ComparablePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $trimmed = $fullPath.TrimEnd([char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        ))
    if ([string]::IsNullOrEmpty($trimmed)) {
        return [System.IO.Path]::GetPathRoot($fullPath)
    }
    return $trimmed
}

function Test-SamePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Left,

        [Parameter(Mandatory = $true)]
        [string]$Right
    )

    $comparison = if ($IsWindows) {
        [System.StringComparison]::OrdinalIgnoreCase
    } else {
        [System.StringComparison]::Ordinal
    }
    return [string]::Equals((Get-ComparablePath $Left), (Get-ComparablePath $Right), $comparison)
}

function Test-PathStrictlyWithin {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Child,

        [Parameter(Mandatory = $true)]
        [string]$Parent
    )

    $childPath = Get-ComparablePath $Child
    $parentPath = Get-ComparablePath $Parent
    if (Test-SamePath $childPath $parentPath) {
        return $false
    }

    $comparison = if ($IsWindows) {
        [System.StringComparison]::OrdinalIgnoreCase
    } else {
        [System.StringComparison]::Ordinal
    }
    foreach ($separator in @(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        )) {
        if ($childPath.StartsWith($parentPath + $separator, $comparison)) {
            return $true
        }
    }
    return $false
}

function Resolve-RequiredPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Description was not found at '$Path'."
    }
    try {
        return [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path)
    } catch {
        throw "$Description at '$Path' could not be resolved: $($_.Exception.Message)"
    }
}

function Get-SafeQuickstartParent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    $buildPath = Join-Path $RepositoryRoot "build"
    if (-not (Test-Path -LiteralPath $buildPath -PathType Container)) {
        New-Item -ItemType Directory -Path $buildPath -Force | Out-Null
    }
    $resolvedBuild = Resolve-RequiredPath -Path $buildPath -Description "The build directory"
    $expectedBuild = [System.IO.Path]::GetFullPath($buildPath)
    if (-not (Test-SamePath $resolvedBuild $expectedBuild)) {
        throw "The build directory '$buildPath' resolves outside the repository build tree; refusing to allocate a quickstart workspace."
    }

    $parentPath = Join-Path $buildPath "docs-quickstart"
    if (-not (Test-Path -LiteralPath $parentPath -PathType Container)) {
        New-Item -ItemType Directory -Path $parentPath -Force | Out-Null
    }
    $resolvedParent = Resolve-RequiredPath -Path $parentPath -Description "The docs quickstart build directory"
    $expectedParent = [System.IO.Path]::GetFullPath($parentPath)
    if (-not (Test-SamePath $resolvedParent $expectedParent)) {
        throw "The docs quickstart directory '$parentPath' resolves outside '$expectedParent'; refusing to use it."
    }
    if (-not (Test-PathStrictlyWithin -Child $resolvedParent -Parent $resolvedBuild)) {
        throw "The docs quickstart directory '$resolvedParent' is not strictly below '$resolvedBuild'."
    }
    return $resolvedParent
}

function New-OwnedQuickstartWorkspace {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ParentPath
    )

    $runId = [guid]::NewGuid().ToString("N")
    $workspacePath = [System.IO.Path]::GetFullPath((Join-Path $ParentPath "run-$runId"))
    if (-not (Test-PathStrictlyWithin -Child $workspacePath -Parent $ParentPath)) {
        throw "The generated quickstart workspace '$workspacePath' is not strictly below '$ParentPath'."
    }
    if (Test-Path -LiteralPath $workspacePath) {
        throw "The generated quickstart workspace '$workspacePath' already exists; refusing to reuse it."
    }

    New-Item -ItemType Directory -Path $workspacePath -Force | Out-Null
    $resolvedWorkspace = Resolve-RequiredPath -Path $workspacePath -Description "The new quickstart workspace"
    if (-not (Test-PathStrictlyWithin -Child $resolvedWorkspace -Parent $ParentPath)) {
        throw "The resolved quickstart workspace '$resolvedWorkspace' escaped '$ParentPath'."
    }
    $markerPath = Join-Path $resolvedWorkspace ".licensecc-docs-quickstart-owner"
    $markerContent = "licensecc-docs-quickstart-v1`nrun_id=$runId`nworkspace=$resolvedWorkspace`n"
    [System.IO.File]::WriteAllText(
        $markerPath,
        $markerContent,
        [System.Text.UTF8Encoding]::new($false)
    )

    return [pscustomobject]@{
        RunId = $runId
        Path = $resolvedWorkspace
        MarkerPath = $markerPath
        MarkerContent = $markerContent
    }
}

function Remove-OwnedQuickstartWorkspace {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Workspace,

        [Parameter(Mandatory = $true)]
        [string]$ParentPath
    )

    if (-not (Test-Path -LiteralPath $Workspace.Path -PathType Container)) {
        return
    }
    $resolvedWorkspace = Resolve-RequiredPath -Path $Workspace.Path -Description "The quickstart workspace for cleanup"
    if (-not (Test-PathStrictlyWithin -Child $resolvedWorkspace -Parent $ParentPath)) {
        throw "Refusing cleanup: resolved quickstart workspace '$resolvedWorkspace' is outside '$ParentPath'."
    }
    if (-not (Test-SamePath $resolvedWorkspace $Workspace.Path)) {
        throw "Refusing cleanup: quickstart workspace path changed from '$($Workspace.Path)' to '$resolvedWorkspace'."
    }
    if (-not (Test-Path -LiteralPath $Workspace.MarkerPath -PathType Leaf)) {
        throw "Refusing cleanup: ownership marker '$($Workspace.MarkerPath)' is missing."
    }
    $actualMarker = [System.IO.File]::ReadAllText($Workspace.MarkerPath)
    if ($actualMarker -cne $Workspace.MarkerContent) {
        throw "Refusing cleanup: ownership marker '$($Workspace.MarkerPath)' does not match this run."
    }

    Remove-Item -LiteralPath $resolvedWorkspace -Recurse -Force
    if (Test-Path -LiteralPath $resolvedWorkspace) {
        throw "Quickstart workspace cleanup did not remove '$resolvedWorkspace'."
    }
}

function Get-BuiltExecutableCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BuildRoot,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $resolvedBuildRoot = Resolve-RequiredPath -Path $BuildRoot -Description "The native build directory"
    $names = if ($IsWindows) { @("$Name.exe") } else { @($Name) }
    $pathComparer = if ($IsWindows) {
        [System.StringComparer]::OrdinalIgnoreCase
    } else {
        [System.StringComparer]::Ordinal
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new($pathComparer)
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($file in @(Get-ChildItem -LiteralPath $resolvedBuildRoot -File -Force -Recurse -ErrorAction Stop)) {
        if ($names -notcontains $file.Name) {
            continue
        }
        $resolvedFile = Resolve-RequiredPath -Path $file.FullName -Description "A built $Name candidate"
        if (-not (Test-PathStrictlyWithin -Child $resolvedFile -Parent $resolvedBuildRoot)) {
            continue
        }
        if ($seen.Add($resolvedFile)) {
            $candidates.Add($resolvedFile)
        }
    }
    return $candidates.ToArray()
}

function Get-SingleBuiltExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [string]$BuildRoot,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string]$Description,

        [string[]]$ProbeArguments
    )

    $candidates = @(Get-BuiltExecutableCandidates -BuildRoot $BuildRoot -Name $Name)
    if ($candidates.Count -ne 1) {
        $found = if ($candidates.Count -eq 0) { "none" } else { $candidates -join ", " }
        throw "Expected exactly one valid built $Description below '$BuildRoot'; found $($candidates.Count): $found."
    }
    if ($null -ne $ProbeArguments -and $ProbeArguments.Count -gt 0) {
        try {
            [void](Invoke-NativeCapture -FilePath $candidates[0] -Arguments $ProbeArguments -WorkingDirectory $BuildRoot)
        } catch {
            throw "The built $Description '$($candidates[0])' did not pass its probe: $($_.Exception.Message)"
        }
    }
    return $candidates[0]
}

function Get-CapturedText {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Capture
    )

    return [System.Text.Encoding]::UTF8.GetString($Capture.Bytes)
}

function Invoke-OfflineDocsQuickstart {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,

        [Parameter(Mandatory = $true)]
        [string]$Configuration
    )

    $sourceBefore = $null
    $sourceAfter = $null
    $workspace = $null
    $quickstartParent = $null
    $operationFailure = $null
    $cleanupFailure = $null
    $purityFailure = $null

    try {
        try {
            $sourceBefore = Get-SourceSnapshot -RepositoryRoot $RepositoryRoot
        } catch {
            throw "Git is required to fingerprint source state before the offline docs quickstart: $($_.Exception.Message)"
        }

        try {
            $cmake = Resolve-CmakeTool -Name "cmake"
        } catch {
            throw "CMake 3.21 or newer is required for the offline docs quickstart: $($_.Exception.Message)"
        }

        $quickstartParent = Get-SafeQuickstartParent -RepositoryRoot $RepositoryRoot
        $workspace = New-OwnedQuickstartWorkspace -ParentPath $quickstartParent
        $nativeBuild = Join-Path $workspace.Path "native"
        $installPrefix = Join-Path $workspace.Path "install"
        # The native project contract permits generated projects in the active
        # binary tree. Keep them there so this runner does not rely on an
        # external or source-adjacent projects directory.
        $projectsBase = Join-Path $nativeBuild "projects"
        $projectName = "docs_quickstart"

        $nativeConfigureArguments = @(
            "-S", $RepositoryRoot,
            "-B", $nativeBuild,
            "-DCMAKE_BUILD_TYPE=$Configuration",
            "-DCMAKE_INSTALL_PREFIX=$installPrefix",
            "-DLCC_PROJECT_NAME=$projectName",
            "-DLCC_PROJECTS_BASE_DIR=$projectsBase",
            "-DBUILD_TESTING=OFF"
        )
        Invoke-CmakeStep -Tool $cmake -Name "Configure native Licensecc for the offline docs quickstart" -Arguments $nativeConfigureArguments
        Invoke-CmakeStep -Tool $cmake -Name "Build and install native Licensecc for the offline docs quickstart" -Arguments @(
            "--build", $nativeBuild,
            "--config", $Configuration,
            "--target", "install"
        )

        $lccgen = Get-SingleBuiltExecutable -BuildRoot $nativeBuild -Name "lccgen" -Description "lccgen executable" -ProbeArguments @("license", "issue", "--help")
        $projectPath = Resolve-RequiredPath -Path (Join-Path $projectsBase $projectName) -Description "The generated quickstart project"
        $privateKey = Resolve-RequiredPath -Path (Join-Path $projectPath "private_key.rsa") -Description "The generated quickstart private key"
        $publicKey = Resolve-RequiredPath -Path (Join-Path $projectPath "include/licensecc/$projectName/public_key.h") -Description "The generated quickstart public key"
        if (-not (Test-PathStrictlyWithin -Child $privateKey -Parent $workspace.Path) -or
            -not (Test-PathStrictlyWithin -Child $publicKey -Parent $workspace.Path)) {
            throw "Generated project material escaped the owned quickstart workspace '$($workspace.Path)'."
        }

        $licensePath = [System.IO.Path]::GetFullPath((Join-Path $projectPath "licenses/quickstart.lic"))
        if (-not (Test-PathStrictlyWithin -Child $licensePath -Parent $workspace.Path)) {
            throw "Refusing to issue the quickstart license outside the owned workspace: '$licensePath'."
        }
        Write-Host "==> Issue an offline quickstart license"
        try {
            [void](Invoke-NativeCapture -FilePath $lccgen -Arguments @(
                "license", "issue",
                "-p", $projectPath,
                "-o", $licensePath
            ) -WorkingDirectory $workspace.Path)
        } catch {
            throw "Offline quickstart license issuance failed: $($_.Exception.Message)"
        }
        if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf)) {
            throw "lccgen completed without writing the expected quickstart license '$licensePath'."
        }
        $resolvedLicense = Resolve-RequiredPath -Path $licensePath -Description "The issued quickstart license"
        if (-not (Test-PathStrictlyWithin -Child $resolvedLicense -Parent $workspace.Path)) {
            throw "The issued quickstart license escaped the owned workspace: '$resolvedLicense'."
        }

        $exampleBuild = Join-Path $workspace.Path "minimal-example"
        $packageDirectoryCandidates = @(
            @(
                (Join-Path $installPrefix "cmake/licensecc"),
                (Join-Path $installPrefix "lib/cmake/licensecc")
            ) | Where-Object {
                Test-Path -LiteralPath (Join-Path $_ "licensecc-config.cmake") -PathType Leaf
            }
        )
        if (@($packageDirectoryCandidates).Count -eq 0) {
            throw "No installed licensecc CMake package directory was found below '$installPrefix'."
        }
        $preferredPackageDirectory = if ($IsWindows) {
            Join-Path $installPrefix "cmake/licensecc"
        } else {
            Join-Path $installPrefix "lib/cmake/licensecc"
        }
        $packageDirectory = if ($packageDirectoryCandidates -contains $preferredPackageDirectory) {
            $preferredPackageDirectory
        } else {
            $packageDirectoryCandidates[0]
        }
        $packageDirectory = Resolve-RequiredPath -Path $packageDirectory -Description "The installed licensecc CMake package"
        $exampleSource = Resolve-RequiredPath -Path (Join-Path $RepositoryRoot "examples/minimal") -Description "The minimal example source"
        $exampleConfigureArguments = @(
            "-S", $exampleSource,
            "-B", $exampleBuild,
            "-DCMAKE_BUILD_TYPE=$Configuration",
            "-DCMAKE_PREFIX_PATH=$installPrefix",
            "-Dlicensecc_DIR=$packageDirectory",
            "-DLCC_PROJECT_NAME=$projectName",
            "-DBUILD_TESTING=OFF"
        )
        Invoke-CmakeStep -Tool $cmake -Name "Configure examples/minimal against the installed package" -Arguments $exampleConfigureArguments
        Invoke-CmakeStep -Tool $cmake -Name "Build examples/minimal against the installed package" -Arguments @(
            "--build", $exampleBuild,
            "--config", $Configuration
        )

        $minimal = Get-SingleBuiltExecutable -BuildRoot $exampleBuild -Name "minimal" -Description "minimal example executable"
        Write-Host "==> Run examples/minimal with the issued license"
        try {
            $runResult = Invoke-NativeCapture -FilePath $minimal -Arguments @($resolvedLicense) -WorkingDirectory $exampleBuild
        } catch {
            throw "The minimal example did not run successfully: $($_.Exception.Message)"
        }
        $runOutput = Get-CapturedText -Capture $runResult
        if (-not $runOutput.StartsWith("license OK", [System.StringComparison]::Ordinal)) {
            throw "The minimal example output did not begin with 'license OK'. Actual output: $runOutput"
        }

        Write-Host "Offline documentation quickstart passed: native install, local license issuance, installed minimal consumer, and license verification all succeeded."
    } catch {
        $operationFailure = $_
    } finally {
        if ($null -ne $workspace) {
            try {
                Remove-OwnedQuickstartWorkspace -Workspace $workspace -ParentPath $quickstartParent
            } catch {
                $cleanupFailure = $_
            }
        }
        if ($null -ne $sourceBefore) {
            try {
                $sourceAfter = Get-SourceSnapshot -RepositoryRoot $RepositoryRoot
                $sourceChanges = @(Compare-SourceSnapshots -Before $sourceBefore -After $sourceAfter)
                if ($sourceChanges.Count -gt 0) {
                    $purityFailure = "Source git status or fingerprint changed during the offline docs quickstart: $($sourceChanges -join '; ')."
                }
            } catch {
                $purityFailure = "Could not verify source git status or fingerprint after the offline docs quickstart: $($_.Exception.Message)"
            }
        }
    }

    $failures = [System.Collections.Generic.List[string]]::new()
    if ($null -ne $operationFailure) {
        $failures.Add($operationFailure.Exception.Message)
    }
    if ($null -ne $purityFailure) {
        $failures.Add($purityFailure)
    }
    if ($null -ne $cleanupFailure) {
        $failures.Add("Quickstart cleanup failed: $($cleanupFailure.Exception.Message)")
    }
    if ($failures.Count -gt 0) {
        throw ($failures -join " ")
    }
}

if ($MyInvocation.InvocationName -ne ".") {
    $repositoryRoot = Resolve-RequiredPath -Path (Join-Path $PSScriptRoot "..\..") -Description "The Licensecc repository root"
    $currentDirectory = [System.IO.Path]::GetFullPath((Get-Location).ProviderPath)
    if (-not (Test-SamePath $currentDirectory $repositoryRoot)) {
        throw "Run the offline docs quickstart from the Licensecc repository root: '$repositoryRoot'. Current directory is '$currentDirectory'."
    }
    Resolve-RequiredPath -Path (Join-Path $repositoryRoot "CMakeLists.txt") -Description "The native Licensecc CMake project" | Out-Null
    Resolve-RequiredPath -Path (Join-Path $repositoryRoot "examples/minimal/CMakeLists.txt") -Description "The minimal example CMake project" | Out-Null
    Resolve-RequiredPath -Path (Join-Path $repositoryRoot "extern/license-generator/CMakeLists.txt") -Description "The vendored lccgen source" | Out-Null

    Invoke-OfflineDocsQuickstart -RepositoryRoot $repositoryRoot -Configuration $Configuration
}
