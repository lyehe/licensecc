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

    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-ByteHash {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [byte[]]$Bytes
    )

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Get-FileHashValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return Get-ByteHash -Bytes ([System.IO.File]::ReadAllBytes($Path))
}

function Invoke-NativeCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    foreach ($argument in $Arguments) {
        [void]$startInfo.ArgumentList.Add($argument)
    }

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Could not start the required command."
    }

    $stdout = [System.IO.MemoryStream]::new()
    try {
        $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        [void]$stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) {
            throw "Required command failed with exit code $($process.ExitCode)."
        }

        return [pscustomobject]@{
            Bytes = $stdout.ToArray()
            Error = $stderr
        }
    } finally {
        $stdout.Dispose()
        $process.Dispose()
    }
}

function Invoke-GitCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Repository,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    return Invoke-NativeCapture -FilePath "git" -Arguments (@("-C", $Repository) + $Arguments) -WorkingDirectory $Repository
}

function Get-GitText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Repository,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    return ([System.Text.Encoding]::UTF8.GetString((Invoke-GitCapture -Repository $Repository -Arguments $Arguments).Bytes)).Trim()
}

function Get-RelativeFilePath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return [System.IO.Path]::GetRelativePath($Root, $Path).Replace("\", "/")
}

function Get-UntrackedFingerprint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Repository
    )

    $output = Invoke-GitCapture -Repository $Repository -Arguments @("ls-files", "--others", "--exclude-standard", "-z")
    $rawEntries = [System.Text.Encoding]::UTF8.GetString($output.Bytes).Split([char]0, [System.StringSplitOptions]::RemoveEmptyEntries)
    $entries = [ordered]@{}
    foreach ($entry in @($rawEntries | Sort-Object)) {
        $fullPath = [System.IO.Path]::GetFullPath((Join-Path $Repository $entry))
        if ([System.IO.File]::Exists($fullPath)) {
            $entries[$entry.Replace("\", "/")] = Get-FileHashValue -Path $fullPath
        }
    }

    $serialized = ConvertTo-Json -InputObject $entries -Compress
    return [pscustomobject]@{
        Hash = Get-ByteHash -Bytes ([System.Text.Encoding]::UTF8.GetBytes($serialized))
        Entries = $entries
    }
}

function Get-RepositoryFingerprint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Repository
    )

    $head = Get-GitText -Repository $Repository -Arguments @("rev-parse", "--verify", "HEAD")
    $status = (Invoke-GitCapture -Repository $Repository -Arguments @("status", "--porcelain=v1", "--untracked-files=all", "-z")).Bytes
    $stagedDiff = (Invoke-GitCapture -Repository $Repository -Arguments @("diff", "--cached", "--binary", "--no-ext-diff")).Bytes
    $unstagedDiff = (Invoke-GitCapture -Repository $Repository -Arguments @("diff", "--binary", "--no-ext-diff")).Bytes

    return [pscustomobject]@{
        Head = $head
        StatusHash = Get-ByteHash -Bytes $status
        StagedDiffHash = Get-ByteHash -Bytes $stagedDiff
        UnstagedDiffHash = Get-ByteHash -Bytes $unstagedDiff
        Untracked = Get-UntrackedFingerprint -Repository $Repository
    }
}

function Get-DirectoryFingerprint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $entries = [ordered]@{}
    if (Test-Path -LiteralPath $Path -PathType Container) {
        $root = (Resolve-Path -LiteralPath $Path).Path
        $files = Get-ChildItem -LiteralPath $root -File -Force -Recurse | Sort-Object -Property FullName
        foreach ($file in $files) {
            $entries[(Get-RelativeFilePath -Root $root -Path $file.FullName)] = Get-FileHashValue -Path $file.FullName
        }
    }

    $serialized = ConvertTo-Json -InputObject $entries -Compress
    return [pscustomobject]@{
        Hash = Get-ByteHash -Bytes ([System.Text.Encoding]::UTF8.GetBytes($serialized))
        Entries = $entries
    }
}

function Get-SourceSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot
    )

    $root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
    return [pscustomobject]@{
        Root = Get-RepositoryFingerprint -Repository $root
        Projects = Get-DirectoryFingerprint -Path (Join-Path $root "projects")
        Install = Get-DirectoryFingerprint -Path (Join-Path $root "install")
    }
}

function Compare-RepositoryFingerprints {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [object]$Before,

        [Parameter(Mandatory = $true)]
        [object]$After
    )

    $changes = [System.Collections.Generic.List[string]]::new()
    foreach ($field in @("Head", "StatusHash", "StagedDiffHash", "UnstagedDiffHash")) {
        if ($Before.$field -ne $After.$field) {
            $changes.Add("$Name $field fingerprint changed")
        }
    }
    if ($Before.Untracked.Hash -ne $After.Untracked.Hash) {
        $changes.Add("$Name untracked-content fingerprint changed")
    }
    return $changes.ToArray()
}

function Compare-SourceSnapshots {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Before,

        [Parameter(Mandatory = $true)]
        [object]$After
    )

    $changes = [System.Collections.Generic.List[string]]::new()
    foreach ($change in (Compare-RepositoryFingerprints -Name "root" -Before $Before.Root -After $After.Root)) {
        $changes.Add($change)
    }
    foreach ($tree in @("Projects", "Install")) {
        if ($Before.$tree.Hash -ne $After.$tree.Hash) {
            $changes.Add("$($tree.ToLowerInvariant()) tree fingerprint changed")
        }
    }
    return $changes.ToArray()
}

function Get-NormalizedToolCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$Candidates
    )

    $uniquePaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $normalizedPaths = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in $Candidates) {
        $path = $null
        if ($candidate -is [string]) {
            $path = $candidate
        } elseif ($null -ne $candidate) {
            foreach ($propertyName in @("Source", "Path")) {
                $property = $candidate.PSObject.Properties[$propertyName]
                if ($null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
                    $path = [string]$property.Value
                    break
                }
            }
        }

        if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
            continue
        }

        try {
            $normalizedPath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $path -ErrorAction Stop).Path)
        } catch {
            continue
        }

        if ($uniquePaths.Add($normalizedPath)) {
            $normalizedPaths.Add($normalizedPath)
        }
    }

    return $normalizedPaths.ToArray()
}

function Test-CmakeTool {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Tool
    )

    try {
        & $Tool "--version" *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Get-VisualStudioCmakeCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("cmake", "ctest")]
        [string]$Name
    )

    if (-not $IsWindows) {
        return @()
    }

    $programFiles = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::ProgramFiles)
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($edition in @("Community", "Professional", "Enterprise", "BuildTools")) {
        $candidates.Add((Join-Path $programFiles "Microsoft Visual Studio/2022/$edition/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/$Name.exe"))
    }
    return $candidates.ToArray()
}

function Resolve-CmakeTool {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("cmake", "ctest")]
        [string]$Name,

        [scriptblock]$CommandResolver = {
            param([string]$CommandName)
            Get-Command $CommandName -CommandType Application -All -ErrorAction SilentlyContinue
        },

        [scriptblock]$VisualStudioCandidateResolver = {
            param([string]$CommandName)
            Get-VisualStudioCmakeCandidates -Name $CommandName
        }
    )

    $onPathCandidates = Get-NormalizedToolCandidates -Candidates @(& $CommandResolver $Name)
    foreach ($candidate in $onPathCandidates) {
        if (Test-CmakeTool -Tool $candidate) {
            return [string]$candidate
        }
    }

    $visualStudioCandidates = Get-NormalizedToolCandidates -Candidates @(& $VisualStudioCandidateResolver $Name)
    foreach ($candidate in $visualStudioCandidates) {
        if (Test-CmakeTool -Tool $candidate) {
            return [string]$candidate
        }
    }

    throw "$Name was not found or no usable executable passed '--version' on PATH or in the Visual Studio bundled CMake location."
}

function Invoke-CmakeStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Tool,

        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    Write-Host "==> $Name"
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE."
    }
}

function Invoke-BuildPurityCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RepositoryRoot,

        [Parameter(Mandatory = $true)]
        [string]$Preset,

        [switch]$SkipTests
    )

    $root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
    $before = Get-SourceSnapshot -RepositoryRoot $root
    $operationFailure = $null
    $purityFailure = $null

    Push-Location $root
    try {
        $cmake = Resolve-CmakeTool -Name "cmake"
        $ctest = Resolve-CmakeTool -Name "ctest"
        Invoke-CmakeStep -Tool $cmake -Name "Configure $Preset" -Arguments @("--preset", $Preset)
        Invoke-CmakeStep -Tool $cmake -Name "Build $Preset" -Arguments @("--build", "--preset", $Preset)
        if (-not $SkipTests) {
            Invoke-CmakeStep -Tool $ctest -Name "Test $Preset" -Arguments @("--preset", $Preset, "--no-tests=error")
        }
    } catch {
        $operationFailure = $_
    } finally {
        Pop-Location
        try {
            $after = Get-SourceSnapshot -RepositoryRoot $root
            $changes = @(Compare-SourceSnapshots -Before $before -After $after)
            if ($changes.Count -gt 0) {
                $purityFailure = "Source state changed during the build purity check: $($changes -join '; ')."
            }
        } catch {
            $purityFailure = "Could not verify source purity after the build: $($_.Exception.Message)"
        }
    }

    if ($operationFailure -and $purityFailure) {
        throw "$($operationFailure.Exception.Message) $purityFailure"
    }
    if ($operationFailure) {
        throw $operationFailure
    }
    if ($purityFailure) {
        throw $purityFailure
    }

    Write-Host "Build purity check passed: source fingerprints were unchanged."
}

if ($MyInvocation.InvocationName -ne ".") {
    $scriptRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    Invoke-BuildPurityCheck -RepositoryRoot $scriptRoot -Preset $Preset -SkipTests:$SkipTests
}
