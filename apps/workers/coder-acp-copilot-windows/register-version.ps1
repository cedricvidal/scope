<#
.SYNOPSIS
  Registers the coder-acp-copilot-windows agent and its current version with the Scope API.
  Designed to run inside the worker container where env vars are baked in at build time.

.DESCRIPTION
  1. Waits for DNS to resolve the API hostname (handles cold Windows nodes).
  2. Waits for the API to become healthy.
  3. Upserts the agent document from agent.json (idempotent).
  4. Registers the current version using baked-in env vars (COPILOT_CLI_VERSION, BUILD_TIME, GIT_COMMIT).

.PARAMETER ApiUrl
  Base URL of the Scope API. Defaults to the in-cluster service address.

.PARAMETER MaxHealthRetries
  Maximum number of health check attempts before giving up. Default 60 (~5 minutes).

.PARAMETER MaxDnsRetries
  Maximum number of DNS resolution attempts before giving up. Default 24 (~2 minutes).

.PARAMETER VersionRetries
  Number of retry attempts for version registration. Default 3.
#>
param(
  [string]$ApiUrl = "http://api.scoped.svc.cluster.local:80",
  [int]$MaxHealthRetries = 60,
  [int]$MaxDnsRetries = 24,
  [int]$VersionRetries = 3
)

$ErrorActionPreference = "Stop"

$AgentId = "coder-acp-copilot-windows"
$QueueName = if ($env:QUEUE_NAME) { $env:QUEUE_NAME.Trim() } else { "" }
if (-not $QueueName) {
  throw "QUEUE_NAME environment variable is required"
}

# Build version strings from env vars baked into the worker image
$copilotCliVersion = if ($env:COPILOT_CLI_VERSION) { $env:COPILOT_CLI_VERSION } else { "unknown" }
$AgentVersion = "copilot-$copilotCliVersion"

$buildTime = if ($env:BUILD_TIME) { $env:BUILD_TIME } else { "unknown" }
$gitCommit = if ($env:GIT_COMMIT) { $env:GIT_COMMIT } else { "unknown" }
$WorkerVersion = "$AgentVersion-$buildTime-$gitCommit"

Write-Host "Registering version for $AgentId"
Write-Host "  agentVersion:  $AgentVersion"
Write-Host "  workerVersion: $WorkerVersion"

# Extract hostname from API URL for DNS check
$apiHost = ([System.Uri]$ApiUrl).Host

# Wait for DNS resolution (handles cold Windows nodes where DNS isn't ready yet)
Write-Host "Checking DNS resolution for $apiHost..."
$dnsAttempt = 0
while ($true) {
  $dnsAttempt++
  try {
    $null = [System.Net.Dns]::GetHostAddresses($apiHost)
    Write-Host "DNS resolved successfully."
    break
  } catch {
    if ($dnsAttempt -ge $MaxDnsRetries) {
      Write-Error "DNS resolution failed after $MaxDnsRetries attempts: $_"
      exit 1
    }
    Write-Host "DNS not ready (attempt $dnsAttempt/$MaxDnsRetries), retrying in 5s..."
    Start-Sleep -Seconds 5
  }
}

# Wait for API health
Write-Host "Waiting for API at $ApiUrl..."
$healthAttempt = 0
while ($true) {
  $healthAttempt++
  try {
    $null = Invoke-RestMethod -Uri "$ApiUrl/health" -TimeoutSec 5
    break
  } catch {
    if ($healthAttempt -ge $MaxHealthRetries) {
      Write-Error "API health check failed after $MaxHealthRetries attempts: $_"
      exit 1
    }
    Write-Host "API not ready (attempt $healthAttempt/$MaxHealthRetries), retrying in 5s..."
    Start-Sleep -Seconds 5
  }
}
Write-Host "API is ready."

# Upsert agent document (idempotent - creates if missing, updates if exists)
Write-Host "Upserting agent document..."
$agentJsonPath = Join-Path $PSScriptRoot "agent.json"
if (-not (Test-Path $agentJsonPath)) {
  # Fall back to current directory (when run from WORKDIR in container)
  $agentJsonPath = "agent.json"
}
$agentJson = Get-Content -Raw $agentJsonPath

try {
  $null = Invoke-RestMethod -Uri "$ApiUrl/api/v1/agents" `
    -Method Post `
    -ContentType "application/json" `
    -Body $agentJson `
    -TimeoutSec 30
  Write-Host "Agent upsert successful."
} catch {
  Write-Warning "Agent upsert failed: $_"
  Write-Warning "Continuing anyway (agent may already exist)..."
}

# Register version with retries
Write-Host "Registering version..."
$versionBody = @{
  agentVersion = $AgentVersion
  workerVersion = $WorkerVersion
  components = @{ COPILOT_CLI_VERSION = $copilotCliVersion }
  gitCommit = $gitCommit
  buildTime = $buildTime
  imageTag = $WorkerVersion
  queueName = $QueueName
} | ConvertTo-Json -Compress

$registered = $false
for ($attempt = 1; $attempt -le $VersionRetries; $attempt++) {
  try {
    $null = Invoke-RestMethod -Uri "$ApiUrl/api/v1/agents/$AgentId/versions" `
      -Method Post `
      -ContentType "application/json" `
      -Body $versionBody `
      -TimeoutSec 30
    Write-Host "Version registration successful."
    $registered = $true
    break
  } catch {
    Write-Warning "Version registration attempt $attempt/$VersionRetries failed: $_"
    if ($attempt -lt $VersionRetries) {
      $backoff = $attempt * 5
      Write-Host "Retrying in ${backoff}s..."
      Start-Sleep -Seconds $backoff
    }
  }
}

if (-not $registered) {
  Write-Error "Version registration failed after $VersionRetries attempts."
  exit 1
}

Write-Host "Version registration complete."
