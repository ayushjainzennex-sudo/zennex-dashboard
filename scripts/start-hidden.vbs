' Starts the dashboard server (npm run serve:lan, reachable on the local network) with no window. Used by the Windows startup shortcut.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = root
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")
shell.Run "cmd /c npm run serve:lan > """ & root & "\data\server.log"" 2>&1", 0, False
