[CmdletBinding(DefaultParameterSetName='ById')]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Context,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Namespace,
    [Parameter(Mandatory, ParameterSetName='ById')][ValidatePattern('^[A-Za-z0-9._-]+$')][string]$MoltbotId,
    [Parameter(Mandatory, ParameterSetName='ByPod')][ValidatePattern('^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$')][string]$PodName,
    [ValidatePattern('^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$')][string]$Container,
    [ValidateRange(1,10080)][int]$SinceMinutes = 60,
    [string]$OutputDirectory = (Join-Path (Get-Location) 'rancher-logs'),
    [switch]$Previous
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { throw 'kubectl was not found in PATH.' }

foreach ($resource in @('pods','pods/log')) {
    $allowed = (& kubectl --context $Context auth can-i get $resource -n $Namespace 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $allowed -ne 'yes') { throw "Read access denied for $resource in $Context/$Namespace." }
}

if ($PSCmdlet.ParameterSetName -eq 'ById') {
    $prefix = "moltbot-$MoltbotId-"
    $podData = (& kubectl --context $Context get pods -n $Namespace -o json | Out-String | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw 'Pod discovery failed.' }
    $matches = @($podData.items | Where-Object { $_.metadata.name.StartsWith($prefix) -and $_.status.phase -eq 'Running' } | Sort-Object { [DateTime]$_.metadata.creationTimestamp } -Descending)
    if ($matches.Count -eq 0) { throw "No Running pod starts with '$prefix' in $Context/$Namespace." }
    $PodName = $matches[0].metadata.name
}

$pod = (& kubectl --context $Context get pod $PodName -n $Namespace -o json | Out-String | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw "Unable to read pod '$PodName'." }
$containers = @($pod.spec.containers | ForEach-Object name)
if (-not $Container) {
    if ($containers.Count -ne 1) { throw "Pod has multiple containers ($($containers -join ', ')); specify -Container." }
    $Container = $containers[0]
} elseif ($Container -notin $containers) { throw "Container '$Container' is not present. Available: $($containers -join ', ')." }

$resolvedOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutput -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$suffix = if ($Previous) { '-previous' } else { '' }
$outputFile = Join-Path $resolvedOutput "$Context-$Namespace-$PodName-$Container$suffix-$stamp.log"
$args = @('--context',$Context,'logs',$PodName,'-n',$Namespace,'-c',$Container,"--since=$($SinceMinutes)m",'--timestamps=true')
if ($Previous) { $args += '--previous' }
$raw = (& kubectl @args 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "Log collection failed: $raw" }

$ansi = [regex]::Escape([char]27) + '\[[0-9;]*[A-Za-z]'
$sanitized = [regex]::Replace($raw, $ansi, '')
$rules = @(
    '(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,;]+',
    '(?i)(["'']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|secret|cookie)["'']?\s*[=:]\s*["'']?)[^"'',;\s}]+',
    '(?i)(https?://[^\s:/]+:)[^@\s]+(@)',
    '(?<!\d)(1[3-9]\d{9})(?!\d)',
    '(?i)([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})'
)
$replacements = @('$1[REDACTED]','$1[REDACTED]','$1[REDACTED]$2','[REDACTED_PHONE]','[REDACTED_EMAIL]')
for ($i=0; $i -lt $rules.Count; $i++) { $sanitized = [regex]::Replace($sanitized, $rules[$i], $replacements[$i]) }
[System.IO.File]::WriteAllText($outputFile, $sanitized, [System.Text.UTF8Encoding]::new($false))

$restartCount = (@($pod.status.containerStatuses | Measure-Object -Property restartCount -Sum).Sum)
[pscustomobject]@{
    Context = $Context; Namespace = $Namespace; Pod = $PodName; Container = $Container
    Phase = $pod.status.phase; Created = $pod.metadata.creationTimestamp
    RestartCount = if ($null -eq $restartCount) { 0 } else { $restartCount }
    SinceMinutes = $SinceMinutes; Previous = [bool]$Previous; SanitizedLog = $outputFile
}
