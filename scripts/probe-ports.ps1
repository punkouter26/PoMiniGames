$ports = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -ge 5000 -and $_.LocalPort -le 5010 }
$ports | Format-Table LocalAddress, LocalPort, OwningProcess -AutoSize
Write-Output '---'
Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { 8460,8676,10272,16712 -contains $_.OwningProcess } | Format-Table LocalAddress, LocalPort, State, OwningProcess -AutoSize