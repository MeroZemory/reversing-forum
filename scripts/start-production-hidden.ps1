[CmdletBinding()]
param(
    [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
    [Parameter(Mandatory = $true)][string]$NodePath
)
$ErrorActionPreference = 'Stop'
$repo = (Get-Item -LiteralPath $RepoPath).FullName
$node = (Get-Item -LiteralPath $NodePath).FullName
if (!(Test-Path -LiteralPath $repo -PathType Container) -or !(Test-Path -LiteralPath $node -PathType Leaf)) {
    throw 'Repository directory and Node executable are required.'
}
$supervisor = Join-Path $repo 'scripts\production-supervisor.mjs'
if (!(Test-Path -LiteralPath $supervisor -PathType Leaf)) { throw 'Supervisor script is missing.' }
# Supervisor checks live ownership and holds a mutex. Reentry leaves the existing process alone.
Start-Process -FilePath $node -ArgumentList ('"' + $supervisor + '"') -WorkingDirectory $repo -WindowStyle Hidden | Out-Null
