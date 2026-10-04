$ErrorActionPreference = 'Stop'
foreach ($name in @('install-production-startup.ps1', 'start-production-hidden.ps1')) {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw "PowerShell parse failed: $name" }
    if ($name -eq 'install-production-startup.ps1') {
        $installerAst = $ast
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

# Execute installer logic with every registry operation redirected to GUID fixture keys.
# Reject additional commands so a future qualified cmdlet or alias cannot bypass the mocks.
$allowedInstallerCommands = @('Split-Path', 'Get-Command', 'Select-Object', 'Get-Item', 'Test-Path', 'Join-Path', 'New-ProductionStartupCommand', 'New-Item', 'Out-Null', 'New-ItemProperty', 'Get-ItemPropertyValue')
foreach ($commandAst in $installerAst.FindAll({ param($item) $item -is [System.Management.Automation.Language.CommandAst] }, $true)) {
    if ($commandAst.GetCommandName() -notin $allowedInstallerCommands) { throw 'Installer command is not covered by the registry fixture redirects.' }
}

function Invoke-FixtureInstaller {
    param([string]$Installer, [string]$RepoPath, [string]$NodePath, [string]$FixtureKey, $Calls)
    & {
        param($Installer, $RepoPath, $NodePath, $FixtureKey, $Calls)
        $allowedFilePaths = @($RepoPath, $NodePath, (Join-Path $RepoPath 'scripts\start-production-hidden.ps1'), (Join-Path $RepoPath 'scripts\production-supervisor.mjs'))
        function Get-FixtureRegistryPath {
            param([string]$Path)
            if ($Path -cne 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run') { throw 'Unexpected installer registry path.' }
            return $FixtureKey
        }
        function Test-Path {
            param([string]$LiteralPath, [string]$Path, [string]$PathType = 'Any')
            $target = if ($LiteralPath) { $LiteralPath } else { $Path }
            if ($target -notin $allowedFilePaths) {
                $target = Get-FixtureRegistryPath $target
                $Calls.Add('Test-Path')
            }
            Microsoft.PowerShell.Management\Test-Path -LiteralPath $target -PathType $PathType
        }
        function Get-Item {
            param([string]$LiteralPath)
            if ($LiteralPath -notin @($RepoPath, $NodePath)) { $LiteralPath = Get-FixtureRegistryPath $LiteralPath; $Calls.Add('Get-Item') }
            Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath
        }
        function New-Item {
            param([string]$Path, [switch]$Force)
            $target = Get-FixtureRegistryPath $Path
            $Calls.Add('New-Item')
            # Preserve Force semantics so the old destructive implementation fails this test.
            Microsoft.PowerShell.Management\New-Item -Path $target -Force:$Force
        }
        function New-ItemProperty {
            param([string]$LiteralPath, [string]$Name, $Value, [string]$PropertyType, [switch]$Force)
            $target = Get-FixtureRegistryPath $LiteralPath
            $Calls.Add('New-ItemProperty')
            Microsoft.PowerShell.Management\New-ItemProperty -LiteralPath $target -Name $Name -Value $Value -PropertyType $PropertyType -Force:$Force
        }
        function Get-ItemPropertyValue {
            param([string]$LiteralPath, [string]$Name)
            $target = Get-FixtureRegistryPath $LiteralPath
            $Calls.Add('Get-ItemPropertyValue')
            Microsoft.PowerShell.Management\Get-ItemPropertyValue -LiteralPath $target -Name $Name
        }
        & $Installer -RepoPath $RepoPath -NodePath $NodePath -Confirm:$false
    } $Installer $RepoPath $NodePath $FixtureKey $Calls
}

$registryFixture = 'HKCU:\Software\ReversingForumStartupTest-' + [guid]::NewGuid().ToString()
$registryFixtureOwned = $false
try {
    if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $registryFixture) { throw 'Registry fixture already exists.' }
    Microsoft.PowerShell.Management\New-Item -Path $registryFixture | Out-Null
    $registryFixtureOwned = $true
    $existingKey = Join-Path $registryFixture 'Existing'
    Microsoft.PowerShell.Management\New-Item -Path $existingKey | Out-Null
    Microsoft.PowerShell.Management\New-ItemProperty -LiteralPath $existingKey -Name 'UnrelatedStartup' -Value 'keep this string' -PropertyType String | Out-Null
    Microsoft.PowerShell.Management\New-ItemProperty -LiteralPath $existingKey -Name 'UnrelatedCounter' -Value 42 -PropertyType DWord | Out-Null
    $calls = [System.Collections.Generic.List[string]]::new()
    $installer = Join-Path $PSScriptRoot 'install-production-startup.ps1'
    $first = Invoke-FixtureInstaller $installer $repo $node $existingKey $calls
    $second = Invoke-FixtureInstaller $installer $repo $node $existingKey $calls
    if (!$first.Registered -or !$second.Registered -or $first.EntryName -cne $second.EntryName -or $calls.Contains('New-Item')) { throw 'Existing fixture key must not be recreated on repeated registration.' }
    $key = Microsoft.PowerShell.Management\Get-Item -LiteralPath $existingKey
    if ($key.GetValue('UnrelatedStartup') -cne 'keep this string' -or $key.GetValue('UnrelatedCounter') -ne 42 -or $key.GetValueKind('UnrelatedCounter') -ne 'DWord' -or $key.GetValueNames().Count -ne 3) { throw 'Repeated registration changed unrelated values.' }
    Write-Output 'PASS existing GUID fixture: unrelated string/DWord preserved through two installer registrations'

    $missingKey = Join-Path $registryFixture 'Missing'
    if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $missingKey) { throw 'Missing-key fixture must initially be absent.' }
    $calls.Clear()
    $created = Invoke-FixtureInstaller $installer $repo $node $missingKey $calls
    if (@($calls | Where-Object { $_ -eq 'New-Item' }).Count -ne 1) { throw 'Missing fixture key must be created exactly once.' }
    $key = Microsoft.PowerShell.Management\Get-Item -LiteralPath $missingKey
    if ($key.GetValueNames().Count -ne 1 -or $key.GetValueKind($created.EntryName) -ne 'String') { throw 'New fixture key must contain only the project string value.' }
    $expectedCommand = $key.GetValue($created.EntryName)
    Microsoft.PowerShell.Management\New-ItemProperty -LiteralPath $missingKey -Name 'UnrelatedStartup' -Value 'preserve on update' -PropertyType String | Out-Null
    Microsoft.PowerShell.Management\New-ItemProperty -LiteralPath $missingKey -Name $created.EntryName -Value 'stale project command' -PropertyType String -Force | Out-Null
    $calls.Clear()
    $updated = Invoke-FixtureInstaller $installer $repo $node $missingKey $calls
    $key = Microsoft.PowerShell.Management\Get-Item -LiteralPath $missingKey
    if ($updated.EntryName -cne $created.EntryName -or $calls.Contains('New-Item') -or $key.GetValueNames().Count -ne 2 -or $key.GetValue('UnrelatedStartup') -cne 'preserve on update' -or $key.GetValue($created.EntryName) -cne $expectedCommand) { throw 'Update must change only the project value.' }
    Write-Output 'PASS missing GUID fixture: key created, then only project value updated'
} finally {
    if ($registryFixture -notmatch '^HKCU:\\Software\\ReversingForumStartupTest-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Unsafe registry fixture cleanup path.' }
    if ($registryFixtureOwned) {
        if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $registryFixture) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $registryFixture -Recurse -Force }
        if (Microsoft.PowerShell.Management\Test-Path -LiteralPath $registryFixture) { throw 'Registry fixture cleanup failed.' }
        Write-Output 'PASS GUID registry fixture cleanup'
    }
}

# Mock process launch; no production supervisor or additional helper is started.
$fixtureRepo = Join-Path ([System.IO.Path]::GetTempPath()) ('startup space test ' + [guid]::NewGuid().ToString())
$fixtureDirectoryOwned = $false
try {
    if (Test-Path -LiteralPath $fixtureRepo) { throw 'File fixture already exists.' }
    New-Item -ItemType Directory -Path $fixtureRepo | Out-Null
    $fixtureDirectoryOwned = $true
    New-Item -ItemType Directory -Path (Join-Path $fixtureRepo 'scripts') | Out-Null
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
    if (!$resolvedFixture.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedFixture) -notmatch '^startup space test [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Unsafe fixture cleanup path.' }
    if ($fixtureDirectoryOwned -and (Test-Path -LiteralPath $resolvedFixture)) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
    if ($fixtureDirectoryOwned -and (Test-Path -LiteralPath $resolvedFixture)) { throw 'File fixture cleanup failed.' }
}
