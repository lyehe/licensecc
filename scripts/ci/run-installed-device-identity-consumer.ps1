param(
    [Parameter(Mandatory = $true)]
    [string]$InstallPrefix,

    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug",

    [string]$BuildDirectory,

    [switch]$RequireC99,

    [switch]$ExpectWindowsTpm,

    [switch]$BuildWindowsTpmExample,

    [switch]$StaticRuntime
)

$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$resolvedInstallPrefix = (Resolve-Path -LiteralPath $InstallPrefix).Path
$consumerSource = Join-Path $repositoryRoot "test\consumer\device_identity"
if ([string]::IsNullOrWhiteSpace($BuildDirectory)) {
    $consumerBuild = Join-Path $repositoryRoot "build\installed-device-identity-consumer"
} elseif ([System.IO.Path]::IsPathRooted($BuildDirectory)) {
    $consumerBuild = [System.IO.Path]::GetFullPath($BuildDirectory)
} else {
    $consumerBuild = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $BuildDirectory))
}
$packageDirectory = @(
    (Join-Path $resolvedInstallPrefix "cmake\licensecc"),
    (Join-Path $resolvedInstallPrefix "lib\cmake\licensecc")
) | Where-Object { Test-Path -LiteralPath (Join-Path $_ "licensecc-config.cmake") } | Select-Object -First 1
if (-not $packageDirectory) {
    throw "Installed licensecc-config.cmake was not found below $resolvedInstallPrefix"
}

$configureArguments = @(
    "-S", $consumerSource,
    "-B", $consumerBuild,
    "-DCMAKE_BUILD_TYPE=$Configuration",
    "-DCMAKE_PREFIX_PATH=$resolvedInstallPrefix",
    "-Dlicensecc_DIR=$packageDirectory",
    "-DLCC_PROJECT_NAME=test"
)
if ($RequireC99) {
    $configureArguments += "-DLCC_DEVICE_IDENTITY_REQUIRE_C99=ON"
} else {
    $configureArguments += "-DLCC_DEVICE_IDENTITY_REQUIRE_C99=OFF"
}
if ($ExpectWindowsTpm) {
    $configureArguments += "-DLCC_DEVICE_IDENTITY_EXPECT_WINDOWS_TPM=ON"
} else {
    $configureArguments += "-DLCC_DEVICE_IDENTITY_EXPECT_WINDOWS_TPM=OFF"
}
if ($StaticRuntime) {
    if ($Configuration -eq "Debug") {
        $configureArguments += "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDebug"
    } else {
        $configureArguments += "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"
    }
}

& cmake @configureArguments
if ($LASTEXITCODE -ne 0) {
    throw "Installed device-identity consumer configure failed with exit code $LASTEXITCODE"
}

& cmake --build $consumerBuild --config $Configuration
if ($LASTEXITCODE -ne 0) {
    throw "Installed device-identity consumer build failed with exit code $LASTEXITCODE"
}

& ctest --test-dir $consumerBuild -C $Configuration --output-on-failure --no-tests=error
if ($LASTEXITCODE -ne 0) {
    throw "Installed device-identity consumer run failed with exit code $LASTEXITCODE"
}

if ($BuildWindowsTpmExample) {
    if (-not $ExpectWindowsTpm) {
        throw "-BuildWindowsTpmExample requires -ExpectWindowsTpm"
    }
    $exampleSource = Join-Path $repositoryRoot "examples\device_identity"
    $exampleBuild = "$consumerBuild-example"
    $exampleConfigureArguments = @(
        "-S", $exampleSource,
        "-B", $exampleBuild,
        "-DCMAKE_BUILD_TYPE=$Configuration",
        "-DCMAKE_PREFIX_PATH=$resolvedInstallPrefix",
        "-Dlicensecc_DIR=$packageDirectory",
        "-DLCC_PROJECT_NAME=test"
    )
    if ($StaticRuntime) {
        if ($Configuration -eq "Debug") {
            $exampleConfigureArguments += "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDebug"
        } else {
            $exampleConfigureArguments += "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded"
        }
    }
    & cmake @exampleConfigureArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Installed Windows TPM example configure failed with exit code $LASTEXITCODE"
    }
    & cmake --build $exampleBuild --config $Configuration
    if ($LASTEXITCODE -ne 0) {
        throw "Installed Windows TPM example build failed with exit code $LASTEXITCODE"
    }
}
