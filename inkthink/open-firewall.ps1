# Allow devices on the same local network to reach InkThink (TCP port, default 8765).
# Run in an Administrator PowerShell:
#   powershell -ExecutionPolicy Bypass -File open-firewall.ps1
# Remove the rule later:
#   Remove-NetFirewallRule -DisplayName "InkThink 8765 (LAN)"
param([int]$Port = 8765)

$name = "InkThink $Port (LAN)"
if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
    Write-Host "Rule already exists: $name"
    exit 0
}
New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $Port `
    -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
Write-Host "Added firewall rule: $name (only devices on the local subnet can connect)"
