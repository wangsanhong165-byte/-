Option Explicit

' Aurora desktop launcher — hides the console window while starting the
' Electron companion. Double-click this file instead of soulctl.cmd when you
' only want the app window (no command window).
'
' Keep soulctl.cmd available: it remains the developer-facing entry point
' with visible logs and error messages.

Dim fso, shell, scriptDir
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = scriptDir

' Run soulctl.cmd hidden. The explicit "electron" argument keeps the batch
' script from entering its interactive "pause" branch when anything fails.
shell.Run "cmd.exe /c soulctl.cmd electron", 0, False