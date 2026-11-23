# Start the table server on your own Windows computer, behind a Cloudflare Tunnel.
# Run from the repository root in PowerShell:
#   .\deploy\home\start-table.ps1 -Subdomain tables.example.com
# The guide is docs/guides/deploy-home-computer.md.
param(
  [Parameter(Mandatory = $true)]
  [string]$Subdomain
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'data/table-oracle-cards.json')) {
  Write-Error 'Missing data/table-oracle-cards.json. Run: bun run scryfall:update; bun run table:cards'
}
if (-not (Test-Path 'apps/web/dist-table/index.html')) {
  Write-Error 'Missing the table web bundle. Run: bun run --cwd apps/web build:table'
}

# Loopback only: cloudflared on this computer is the only thing that reaches the server.
$env:TABLE_HOST = '127.0.0.1'
$env:TABLE_PORT = '3002'
$env:TABLE_BEHIND_TLS_PROXY = '1'
$env:TABLE_TRUSTED_PROXY = '127.0.0.1'
$env:TABLE_PUBLIC_ORIGIN = "https://$Subdomain"
$env:TABLE_ALLOWED_ORIGINS = "https://$Subdomain"
$env:TABLE_ALLOWED_HOSTS = $Subdomain

bun run serve:table
