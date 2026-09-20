$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'device-bound-exports.ps1')
$definition = @('LIBRARY licensecc_device_bound_bridge', 'EXPORTS', '    lcc_allowed')
$header = '    ordinal hint RVA      name'
$direct = '          1    0 00001000 lcc_allowed'
$valid = @('Dump of file bridge.dll', '', $header, '', $direct, '', '  Summary', '        1000 .text')
if ((Assert-DeviceBoundExports $valid $definition) -ne 1) { throw 'Direct export fixture failed' }
$incremental = '          1    0 000018A2 lcc_allowed = @ILT+2205(lcc_allowed)'
if ((Assert-DeviceBoundExports @($header, $incremental, ' Summary') $definition) -ne 1) {
    throw 'MSVC incremental-link export fixture failed'
}
$negativeRows = @(
    '         36    C          ProcessSocketNotifications (forwarded to mswsock.ProcessSocketNotifications)',
    '         12      002E8A80 [NONAME]',
    '          5               [NONAME] (forwarded to SHUNIMPL.#35)',
    '          2    1 00002000 lcc_unexpected',
    $direct,
    '          2    1 00002000 lcc_allowed = @ILT+2205(lcc_different)',
    'unrecognized export metadata'
)
foreach ($row in $negativeRows) {
    $rejected = $false
    try { $null = Assert-DeviceBoundExports @($header, $direct, $row, ' Summary') $definition }
    catch { $rejected = $true }
    if (-not $rejected) { throw "Unsupported export row was accepted: $row" }
}
$rejected = $false
try {
    $null = Assert-DeviceBoundExports @($header,
        '          1    0 000018A2 lcc_allowed = @ILT+2205(lcc_different)', ' Summary') $definition
} catch { $rejected = $true }
if (-not $rejected) { throw 'Mismatched incremental-link symbol was accepted' }
foreach ($declaration in @('lcc_extra=other.forward', 'lcc_extra @17 NONAME', 'lcc_extra @17', 'lcc_allowed')) {
    $rejected = $false
    try { $null = Assert-DeviceBoundExports $valid ($definition + $declaration) }
    catch { $rejected = $true }
    if (-not $rejected) { throw 'Unsupported export definition was accepted' }
}
foreach ($malformed in @(@($direct, ' Summary'), @($header, $direct), @($header, $direct, $header, ' Summary'))) {
    $rejected = $false
    try { $null = Assert-DeviceBoundExports $malformed $definition }
    catch { $rejected = $true }
    if (-not $rejected) { throw 'Malformed export table was accepted' }
}
Write-Host 'Device-bound export parser: direct, forwarder, ordinal, duplicate and malformed fixtures passed'
$javaName = 'Java_io_licensecc_client_DeviceBoundNative_version'
$javaDefinition = @('LIBRARY licensecc_device_bound_jni', 'EXPORTS', $javaName)
$javaRow = "          1    0 00001000 $javaName"
if ((Assert-DeviceBoundExports @($header, $javaRow, ' Summary') $javaDefinition -Java) -ne 1) { throw 'JNI export failed' }
foreach ($row in @($direct, $javaRow, "$javaRow = other.forward", '  2 1 00002000 Java_io_licensecc_client_DeviceBoundNative_extra')) {
    $rejected = $false
    try { $null = Assert-DeviceBoundExports @($header, $javaRow, $row, ' Summary') $javaDefinition -Java }
    catch { $rejected = $true }
    if (-not $rejected) { throw 'JNI extra/foreign/duplicate/forwarded export accepted' }
}
Write-Host 'JNI export parser: exact inventory and foreign/duplicate/forwarder rejection passed'
$dependencyHeader = '  Image has the following dependencies:'
$delayHeader = '  Image has the following delay load dependencies:'
$imports = @(Get-DeviceBoundDependencies @($dependencyHeader, '    KERNEL32.dll', $delayHeader, '    bcrypt.dll', '  Summary'))
if ($imports.Count -ne 2 -or $imports[0] -cne 'bcrypt.dll' -or $imports[1] -cne 'kernel32.dll') { throw 'Dependency sections failed' }
foreach ($row in @('    rogue payload.dll', '    payload.exe', '    C:\payload.dll', '    KERNEL32.dll', '    unknown dependency metadata')) {
    foreach ($section in @($dependencyHeader, $delayHeader)) {
        $rejected = $false
        try { $null = Get-DeviceBoundDependencies @($dependencyHeader, '    KERNEL32.dll', $section, $row, '  Summary') }
        catch { $rejected = $true }
        if (-not $rejected) { throw 'Unrecognized mixed dependency inventory accepted' }
    }
    $rejected = $false
    try { $null = Get-DeviceBoundDependencies @($dependencyHeader, '    KERNEL32.dll', $row, '  Summary') }
    catch { $rejected = $true }
    if (-not $rejected) { throw 'Unrecognized ordinary dependency row accepted' }
}
foreach ($incomplete in @(@($dependencyHeader, '    KERNEL32.dll'), @($dependencyHeader, ' Summary'), @($delayHeader, '    bcrypt.dll', ' Summary'))) {
    $rejected = $false
    try { $null = Get-DeviceBoundDependencies $incomplete }
    catch { $rejected = $true }
    if (-not $rejected) { throw 'Incomplete dependency inventory accepted' }
}
Write-Host 'JNI dependency parser: ordinary/delay-load and mixed unrecognized-row fixtures passed'
