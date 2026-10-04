$ErrorActionPreference = 'Stop'
foreach ($name in @('install-production-startup.ps1', 'start-production-hidden.ps1')) {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw "PowerShell parse failed: $name" }
    if ($name -eq 'install-production-startup.ps1') {
        $source = $ast.Extent.Text
        if (!$source.Contains('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') -or !$source.Contains("'ReversingForum-'")) {
            throw 'Installer must use a project-specific current-user Run entry.'
        }
        $starts = $ast.FindAll({ param($item) $item -is [System.Management.Automation.Language.CommandAst] -and $item.GetCommandName() -eq 'Start-Process' }, $true)
        if ($starts.Count) { throw 'Installer must not start production.' }
        if (!$source.Contains("Scope = 'logon-only'") -or !$source.Contains('MayBeDelayed = $true')) {
            throw 'Installer must report logon-only scope and possible execution delay.'
        }
        # Extract only the pure command builder, never run installer statements.
        $builder = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'New-ProductionStartupCommand' }, $true)
        if (!$builder) { throw 'Run command builder is missing.' }
        $buildCall = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.CommandAst] -and $item.GetCommandName() -eq 'New-ProductionStartupCommand' }, $true)
        $writes = $ast.FindAll({ param($item) $item -is [System.Management.Automation.Language.CommandAst] -and $item.GetCommandName() -in @('New-Item', 'New-ItemProperty') }, $true)
        foreach ($write in $writes) {
            if ($buildCall.Extent.EndOffset -ge $write.Extent.StartOffset) { throw 'Length validation must precede every registry write.' }
        }
        . ([scriptblock]::Create($builder.Extent.Text))
        $baseLength = (New-ProductionStartupCommand -PowerShellPath 'C:\ps.exe' -LauncherPath 'C:\launcher.ps1' -NodePath 'C:\node.exe').Length
        $padding = 260 - $baseLength
        $boundaryLauncher = 'C:\launcher.ps1' + ('x' * $padding)
        $boundary = New-ProductionStartupCommand -PowerShellPath 'C:\ps.exe' -LauncherPath $boundaryLauncher -NodePath 'C:\node.exe'
        if ($boundary.Length -ne 260) { throw '260-character boundary must be accepted.' }
        $rejected = $false
        try { New-ProductionStartupCommand -PowerShellPath 'C:\ps.exe' -LauncherPath ($boundaryLauncher + 'x') -NodePath 'C:\node.exe' | Out-Null } catch { $rejected = $_.Exception.Message -like '*exceeds 260 characters*' }
        if (!$rejected) { throw '261-character command must be rejected.' }
        $repo = (Get-Item -LiteralPath (Split-Path -Parent $PSScriptRoot)).FullName
        $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $actual = New-ProductionStartupCommand -PowerShellPath $powershell -LauncherPath (Join-Path $repo 'scripts\start-production-hidden.ps1') -NodePath $node
        Write-Output "PASS Run command length boundaries: 260 accepted, 261 rejected; current command $($actual.Length) characters"
    }
    Write-Output "PASS parse and static checks: $name"
}

# Mock only process launch; never execute the installer.
$fixtureRepo = Join-Path ([System.IO.Path]::GetTempPath()) ('startup space test ' + [guid]::NewGuid().ToString())
try {
    New-Item -ItemType Directory -Path (Join-Path $fixtureRepo 'scripts') -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $fixtureRepo 'scripts\production-supervisor.mjs') -Value '// test fixture'
    $launches = [System.Collections.Generic.List[object]]::new()
    function Start-Process {
        param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle)
        $launches.Add([pscustomobject]@{ FilePath = $FilePath; ArgumentList = $ArgumentList; WorkingDirectory = $WorkingDirectory; WindowStyle = $WindowStyle })
    }
    $fixtureNode = Join-Path $fixtureRepo 'node executable.exe'
    Set-Content -LiteralPath $fixtureNode -Value 'test fixture only'
    & (Join-Path $PSScriptRoot 'start-production-hidden.ps1') -RepoPath $fixtureRepo -NodePath $fixtureNode
    $launch = $launches[0]
    $expectedRepo = (Get-Item -LiteralPath $fixtureRepo).FullName
    $expectedNode = (Get-Item -LiteralPath $fixtureNode).FullName
    if ($launches.Count -ne 1 -or $launch.FilePath -cne $expectedNode -or $launch.WorkingDirectory -cne $expectedRepo -or $launch.WindowStyle -ne 'Hidden' -or $launch.ArgumentList -cne ('"' + (Join-Path $expectedRepo 'scripts\production-supervisor.mjs') + '"')) {
        throw 'Hidden launcher did not preserve exact paths and quoted arguments.'
    }
    & (Join-Path $PSScriptRoot 'start-production-hidden.ps1') -NodePath $fixtureNode
    $defaultRepo = (Get-Item -LiteralPath (Split-Path -Parent $PSScriptRoot)).FullName
    if ($launches.Count -ne 2 -or $launches[1].WorkingDirectory -cne $defaultRepo -or $launches[1].ArgumentList -cne ('"' + (Join-Path $defaultRepo 'scripts\production-supervisor.mjs') + '"')) {
        throw 'Run launcher must derive the absolute repo path from its own script location.'
    }
    Write-Output 'PASS mocked hidden launch with spaces in repo and executable paths'
} finally {
    Remove-Item Function:\Start-Process -ErrorAction SilentlyContinue
    $resolvedFixture = [System.IO.Path]::GetFullPath($fixtureRepo)
    $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (!$resolvedFixture.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path.' }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
