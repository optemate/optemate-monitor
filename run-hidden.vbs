' Runs one monitor pass with no visible window. Used by the Task Scheduler job.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\scott\OneDrive\Desktop\Projects\More Work\Optemate\reddit-monitor"
sh.Run "cmd /c npm run once >> monitor.log 2>&1", 0, True
