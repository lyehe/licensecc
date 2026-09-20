function Assert-DeviceBoundExports {
    param([string[]]$DumpbinOutput, [string[]]$Definition, [switch]$Java)
    $library = if ($Java) { 'LIBRARY licensecc_device_bound_jni' } else { 'LIBRARY licensecc_device_bound_bridge' }
    $symbol = if ($Java) { 'Java_io_licensecc_client_(?:DeviceBoundNative|FeatureSessionNative)_[A-Za-z0-9_]+' } else { 'lcc_[A-Za-z0-9_]+' }
    $lines = @($Definition | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if ($lines.Count -lt 3 -or $lines[0] -cne $library -or $lines[1] -cne 'EXPORTS') {
        throw 'Unsupported bridge export definition header'
    }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($line in $lines[2..($lines.Count - 1)]) {
        if ($line -cnotmatch "^$symbol`$" -or -not $expected.Add($line)) {
            throw 'Unsupported or duplicate bridge export definition'
        }
    }
    $actual = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $inTable = $false
    $seenTable = $false
    $ended = $false
    foreach ($line in $DumpbinOutput) {
        if ($line -match '^\s*ordinal\s+hint\s+RVA\s+name\s*$') {
            if ($seenTable) { throw 'Multiple DLL export tables' }
            $inTable = $true
            $seenTable = $true
            continue
        }
        if (-not $inTable) { continue }
        if ($line -match '^\s*Summary\s*$') {
            $inTable = $false
            $ended = $true
            continue
        }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        # No ignored table rows: forwarders, ordinal-only exports, aliases,
        # duplicate names and new dumpbin formats must fail for explicit review.
        # MSVC's optional incremental-link annotation must repeat the same name.
        $rowPattern = '^\s*\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(?<name>' + $symbol + ')(?:\s+=\s+@ILT\+\d+\(\k<name>\))?\s*$'
        if ($line -cnotmatch $rowPattern) {
            throw 'Unsupported DLL export table row'
        }
        if (-not $actual.Add($Matches['name'])) { throw 'Duplicate DLL export' }
    }
    if (-not $seenTable -or -not $ended -or -not $actual.SetEquals($expected)) {
        throw 'Installed bridge exports differ from the explicit allowlist'
    }
    return $actual.Count
}

function Get-DeviceBoundDependencies {
    param([string[]]$DumpbinOutput)
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $sections = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $inSection = $false
    $ended = $false
    $sectionCount = 0
    foreach ($line in $DumpbinOutput) {
        if ($line -cmatch '^\s*Image has the following (?<delay>delay load )?dependencies:\s*$') {
            $kind = if ($Matches['delay']) { 'delay' } else { 'ordinary' }
            if ($ended -or ($inSection -and $sectionCount -eq 0) -or -not $sections.Add($kind)) {
                throw 'Unexpected or empty dependency section'
            }
            $inSection = $true
            $sectionCount = 0
            continue
        }
        if ($line -cmatch '^\s*Summary\s*$') {
            if (-not $inSection -or $sectionCount -eq 0 -or $ended) { throw 'Unexpected dependency summary' }
            $ended = $true
            $inSection = $false
            continue
        }
        if (-not $inSection -or [string]::IsNullOrWhiteSpace($line)) { continue }
        # Parse every row, not just recognizable DLL suffixes: spaces, paths,
        # foreign formats and unreviewed PE extensions must not vanish from inventory.
        if ($line -cnotmatch '^\s+(?<name>[A-Za-z0-9_.-]+\.dll)\s*$') { throw 'Unrecognized dependency row' }
        if (-not $names.Add($Matches['name'])) { throw 'Duplicate dependency row' }
        $sectionCount++
    }
    if (-not $ended -or -not $sections.Contains('ordinary') -or $names.Count -eq 0) {
        throw 'Incomplete dependency inventory'
    }
    return @($names | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
}
