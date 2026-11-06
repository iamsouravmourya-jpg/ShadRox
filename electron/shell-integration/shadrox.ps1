# ShadRox shell integration.
# Emits OSC 133 / 633 markers the in-app terminal parser already understands.
# The marker letters follow the public VS Code shell-integration protocol.
# This script is original; it is not a copy of the VS Code integration scripts.

$global:__ShadroxCmd = $null

function global:prompt {
  $esc = [char]27
  $bel = [char]7
  $exit = 0
  if ($null -ne $global:LASTEXITCODE) { $exit = [int]$global:LASTEXITCODE }
  $cwd = (Get-Location).Path
  $finished = ''
  if ($null -ne $global:__ShadroxCmd) {
    $finished = "$esc]133;D;$exit$bel"
    $global:__ShadroxCmd = $null
  }
  $cwdMark = "$esc]633;P;Cwd=$cwd$bel"
  $promptMarks = "$esc]133;A$bel$esc]133;B$bel"
  return "$finished$cwdMark$promptMarks" + "PS $($executionContext.SessionState.Path.CurrentLocation)> "
}

if (Get-Module -ListAvailable -Name PSReadLine) {
  try {
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
      $line = $null
      $cursor = $null
      [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
      $global:__ShadroxCmd = $line
      $esc = [char]27
      $bel = [char]7
      $safe = ''
      if ($null -ne $line) { $safe = ($line -replace '[\r\n\x07\x1b]', ' ') }
      [Console]::Write("$esc]633;E;$safe$bel$esc]133;C$bel")
      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
  } catch {
    # A locked-down PSReadLine still leaves prompt-time cwd and exit markers.
  }
}
