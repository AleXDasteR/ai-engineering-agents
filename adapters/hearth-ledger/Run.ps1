param(
    [Parameter(Mandatory = $true)][string]$ProjectPath,
    [Parameter(Mandatory = $true)][string]$HdtPath,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [ValidateSet('Build', 'Domain')][string]$Mode = 'Domain'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$project = (Get-Item -LiteralPath $ProjectPath).FullName
$hdt = Get-Item -LiteralPath $HdtPath
if (!$hdt.PSIsContainer) { $hdt = $hdt.Directory }
$output = [IO.Path]::GetFullPath($OutputDirectory)
if ($output.StartsWith($project.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use an output directory outside the product source checkout.'
}
New-Item -ItemType Directory -Force -Path $output | Out-Null
if ($Mode -eq 'Build') {
    & (Join-Path $project 'Build.ps1') -HdtPath $hdt.FullName -OutputDirectory $output
    if (!(Test-Path -LiteralPath (Join-Path $output 'HearthLedger.dll'))) { throw 'Plugin DLL missing after build.' }
    if (!(Test-Path -LiteralPath (Join-Path $output 'HearthLedger.zip'))) { throw 'Plugin ZIP missing after build.' }
    Write-Output 'PASS plugin DLL and installation ZIP built from current sources'
    return
}
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$netstandard = Join-Path (Split-Path $compiler) 'netstandard.dll'
$db = Join-Path $hdt.FullName 'HearthDb.dll'
if (!(Test-Path -LiteralPath $db)) { throw 'HearthDb.dll is missing in HdtPath.' }
$executable = Join-Path $output 'DomainChecks.exe'
$sources = @((Join-Path $project 'src/Stats.cs'), (Join-Path $project 'src/Recommendations.cs'),
    (Join-Path $PSScriptRoot 'DomainChecks.cs'))
& $compiler /nologo /target:exe /codepage:65001 /utf8output /warn:0 "/reference:$db" "/reference:$netstandard" "/out:$executable" @sources
if ($LASTEXITCODE -ne 0) { throw 'Domain harness compilation failed.' }
Copy-Item -LiteralPath $db -Destination (Join-Path $output 'HearthDb.dll') -Force
& $executable $output
if ($LASTEXITCODE -ne 0) { throw 'Product scenarios failed.' }
