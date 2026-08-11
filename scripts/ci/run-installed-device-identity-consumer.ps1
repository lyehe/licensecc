param(
    [Parameter(Mandatory = $true)]
    [string]$InstallPrefix,

    [switch]$RequireC99
)

$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$resolvedInstallPrefix = (Resolve-Path -LiteralPath $InstallPrefix).Path
$consumerSource = Join-Path $repositoryRoot "test\consumer\device_identity"
$consumerBuild = Join-Path $repositoryRoot "build\installed-device-identity-consumer"
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
    "-DCMAKE_BUILD_TYPE=Debug",
    "-DCMAKE_PREFIX_PATH=$resolvedInstallPrefix",
    "-Dlicensecc_DIR=$packageDirectory",
    "-DLCC_PROJECT_NAME=test"
)
if ($RequireC99) {
    $configureArguments += "-DLCC_DEVICE_IDENTITY_REQUIRE_C99=ON"
} else {
    $configureArguments += "-DLCC_DEVICE_IDENTITY_REQUIRE_C99=OFF"
}

& cmake @configureArguments
if ($LASTEXITCODE -ne 0) {
    throw "Installed device-identity consumer configure failed with exit code $LASTEXITCODE"
}

& cmake --build $consumerBuild --config Debug
if ($LASTEXITCODE -ne 0) {
    throw "Installed device-identity consumer build failed with exit code $LASTEXITCODE"
}

& ctest --test-dir $consumerBuild -C Debug --output-on-failure --no-tests=error
if ($LASTEXITCODE -ne 0) {
    throw "Installed device-identity consumer run failed with exit code $LASTEXITCODE"
}
