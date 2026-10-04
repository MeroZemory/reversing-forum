[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
    [string]$NodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
)
$ErrorActionPreference = 'Stop'

function New-ProductionStartupCommand {
    param([string]$PowerShellPath, [string]$LauncherPath, [string]$NodePath)
    $command = '"' + $PowerShellPath + '" -NoProfile -NonInteractive -W Hidden -EP Bypass -File "' + $LauncherPath + '" -NodePath "' + $NodePath + '"'
    if ($command.Length -gt 260) {
        throw "Current-user Run command exceeds 260 characters ($($command.Length)); registration was not changed."
    }
    return $command
}

$repo = (Get-Item -LiteralPath $RepoPath).FullName.TrimEnd('\', '/')
$node = (Get-Item -LiteralPath $NodePath).FullName
if (!(Test-Path -LiteralPath $repo -PathType Container) -or !(Test-Path -LiteralPath $node -PathType Leaf)) {
    throw 'Repository directory and Node executable are required.'
}
$launcher = Join-Path $repo 'scripts\start-production-hidden.ps1'
$supervisor = Join-Path $repo 'scripts\production-supervisor.mjs'
if (!(Test-Path -LiteralPath $launcher -PathType Leaf) -or !(Test-Path -LiteralPath $supervisor -PathType Leaf)) {
    throw 'Production startup scripts are missing.'
}
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($repo.ToLowerInvariant()))
    $suffix = ([System.BitConverter]::ToString($digest)).Replace('-', '').Substring(0, 16).ToLowerInvariant()
} finally { $sha.Dispose() }
$entryName = 'ReversingForum-' + $suffix
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command = New-ProductionStartupCommand -PowerShellPath $powershell -LauncherPath $launcher -NodePath $node
if ($PSCmdlet.ShouldProcess($key + '\' + $entryName, 'Register hidden production startup after current-user logon')) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -LiteralPath $key -Name $entryName -Value $command -PropertyType String -Force | Out-Null
    $registered = Get-ItemPropertyValue -LiteralPath $key -Name $entryName
    if ($registered -cne $command) { throw 'Startup registration verification failed.' }
    [pscustomobject]@{ EntryName = $entryName; RepoPath = $repo; NodePath = $node; Trigger = 'Current-user logon'; Scope = 'logon-only'; MayBeDelayed = $true; CommandLength = $command.Length; Registered = $true }
}
