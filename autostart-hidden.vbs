' Starts the control panel with no console window, at logon or from the .cmd.
' The panel then starts the proxy itself, so Codex works without opening the UI.
' Output is redirected to logs\panel-stdout.log; a hidden process would
' otherwise discard it and leave nothing to diagnose.
Dim shell, fso, node, base, logDir, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Derived from this script's own location, so the folder can be moved or renamed.
base = fso.GetParentFolderName(WScript.ScriptFullName)
logDir = base & "\logs"
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)

' At logon the user PATH is not always loaded yet, so a version-manager node is
' looked up directly. CODEX_NODE_EXE overrides the search.
node = shell.ExpandEnvironmentStrings("%CODEX_NODE_EXE%")
If node = "%CODEX_NODE_EXE%" Or Not fso.FileExists(node) Then node = FindNode(fso, shell)

shell.Environment("PROCESS")("HTTPS_PROXY") = "http://127.0.0.1:7897"

cmd = "cmd /c """"" & node & """ """ & base & "\control-panel.mjs"" > """ & logDir & "\panel-stdout.log"" 2>&1"""
shell.Run cmd, 0, False

' The version manager's active node, else the newest installed one, else PATH.
Function FindNode(fso, shell)
  Dim appData, roots, root, v, candidate, newest

  appData = shell.ExpandEnvironmentStrings("%APPDATA%")

  ' fnm's "default" alias points at whatever `fnm default` selected, which is the
  ' same node an interactive shell would use. Better than guessing a version.
  candidate = appData & "\fnm\aliases\default\node.exe"
  If fso.FileExists(candidate) Then
    FindNode = candidate
    Exit Function
  End If

  roots = Array(appData & "\fnm\node-versions", appData & "\nvm", _
                shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs")
  For Each root In roots
    If fso.FolderExists(root) Then
      candidate = root & "\node.exe"
      If fso.FileExists(candidate) Then
        FindNode = candidate
        Exit Function
      End If
      ' Highest folder name wins, so a fresh install beats a stale one.
      newest = ""
      For Each v In fso.GetFolder(root).SubFolders
        candidate = v.Path & "\installation\node.exe"
        If Not fso.FileExists(candidate) Then candidate = v.Path & "\node.exe"
        If fso.FileExists(candidate) And v.Name > newest Then
          newest = v.Name
          FindNode = candidate
        End If
      Next
      If newest <> "" Then Exit Function
    End If
  Next

  FindNode = "node"
End Function
