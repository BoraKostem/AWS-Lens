/**
 * Pure module that classifies terraform CLI stderr and cloud SDK errors into
 * a compact taxonomy, and maps each class to a one-line remediation hint.
 *
 * This file has NO Electron / Node / fs imports by design so it can be
 * unit-tested with simple fixtures.
 */

import type { TerraformAuditProviderId, TerraformErrorClass } from '@shared/types'

export type ClassifiedTerraformError = {
  errorClass: TerraformErrorClass
  suggestedAction: string
}

const MAX_CLASSIFIER_INPUT_BYTES = 16 * 1024

const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g

function stripAnsiLocal(input: string): string {
  return input.replace(ANSI_PATTERN, '')
}

function tailBytes(input: string, limit: number): string {
  if (input.length <= limit) return input
  return input.slice(input.length - limit)
}

// Pattern groups — order matters, first match wins.
const TIMEOUT_PATTERNS: RegExp[] = [
  /timed out after \d+ms/i,
  /operation timed out/i,
  /context deadline exceeded/i,
  /i\/o timeout/i,
  /deadline exceeded/i
]

const STATE_LOCK_PATTERNS: RegExp[] = [
  /Error acquiring the state lock/i,
  /state blob is already locked/i,
  /ConditionalCheckFailedException[\s\S]{0,400}LockID/i,
  /lease already taken/i,
  /Lock Info:[\s\S]*?ID:\s*[0-9a-f-]+/i
]

const AUTH_PATTERNS: RegExp[] = [
  // AWS
  /No valid credential sources/i,
  /NoCredentialProviders/i,
  /InvalidClientTokenId/i,
  /ExpiredToken/i,
  /SignatureDoesNotMatch/i,
  /The security token included in the request is (?:invalid|expired)/i,
  /UnrecognizedClientException/i,
  // Azure
  /AADSTS\d+/i,
  /Failed to get token/i,
  /AuthorizationFailed/i,
  /InvalidAuthenticationToken/i,
  /AuthenticationFailed/i,
  // GCP
  /google: could not find default credentials/i,
  /oauth2:[^\n]*invalid_grant/i,
  /PERMISSION_DENIED/i,
  /Request had insufficient authentication scopes/i,
  // Generic
  /401 Unauthorized/i,
  /403 Forbidden/i
]

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /Throttling/i,
  /RequestLimitExceeded/i,
  /TooManyRequests/i,
  /\b429\b/,
  /quota exceeded/i,
  /userRateLimitExceeded/i,
  /rate exceeded/i,
  /Too Many Requests/i
]

const NETWORK_PATTERNS: RegExp[] = [
  /dial tcp[^\n]*: connect/i,
  /no such host/i,
  /EAI_AGAIN/i,
  /ECONNRESET/i,
  /connection reset/i,
  /connection refused/i,
  /TLS handshake/i,
  /x509: certificate/i,
  /socket hang up/i,
  /ENOTFOUND/i
]

const PLUGIN_PATTERNS: RegExp[] = [
  /Failed to install provider/i,
  /Could not load plugin/i,
  /checksums did not match/i,
  /Required plugins are not installed/i,
  /Incompatible provider version/i,
  /no available releases match the given constraints/i
]

const CONFIG_PATTERNS: RegExp[] = [
  /Error: Invalid\b/i,
  /Error: Unsupported\b/i,
  /Error: Missing required\b/i,
  /Error: Reference to undeclared/i,
  /Error: Argument or block definition required/i,
  /configuration is invalid/i
]

function anyMatch(patterns: RegExp[], haystack: string): boolean {
  return patterns.some((pattern) => pattern.test(haystack))
}

/**
 * SUGGESTED_ACTIONS[class][provider] → one-line remediation hint.
 * Every class provides a value for every provider so the UI banner is never blank.
 */
export const SUGGESTED_ACTIONS: Record<TerraformErrorClass, Record<TerraformAuditProviderId, string>> = {
  timeout: {
    aws: 'Increase command timeout or check AWS service health, then retry.',
    azure: 'Increase command timeout or check Azure service health, then retry.',
    gcp: 'Increase command timeout or check GCP service health, then retry.',
    local: 'Increase command timeout in settings, then retry.'
  },
  auth: {
    aws: 'Run `aws sso login` or refresh your profile credentials, then retry.',
    azure: 'Run `az login` to refresh your Azure session, then retry.',
    gcp: 'Run `gcloud auth application-default login`, then retry.',
    local: 'Verify backend credentials for this project, then retry.'
  },
  rate_limit: {
    aws: 'Wait and retry; consider `-parallelism=5` to slow API calls.',
    azure: 'Wait and retry; reduce `-parallelism` to slow API calls.',
    gcp: 'Wait and retry; reduce `-parallelism` to slow API calls.',
    local: 'Wait a few seconds and retry.'
  },
  state_lock: {
    aws: 'Run `terraform force-unlock <LOCK_ID>` after confirming no other run is active.',
    azure: 'Run `terraform force-unlock <LOCK_ID>`; also check the Azure blob lease state.',
    gcp: 'Run `terraform force-unlock <LOCK_ID>`; also check the GCS object generation lock.',
    local: 'Delete `.terraform.tfstate.lock.info` if no other run is active.'
  },
  network: {
    aws: 'Check VPN/proxy and AWS endpoint reachability, then retry.',
    azure: 'Check VPN/proxy and Azure endpoint reachability, then retry.',
    gcp: 'Check VPN/proxy and GCP endpoint reachability, then retry.',
    local: 'Check network connectivity to the backend, then retry.'
  },
  plugin: {
    aws: 'Run `terraform init -upgrade` to reinstall providers, then retry.',
    azure: 'Run `terraform init -upgrade` to reinstall providers, then retry.',
    gcp: 'Run `terraform init -upgrade` to reinstall providers, then retry.',
    local: 'Run `terraform init -upgrade` to reinstall providers, then retry.'
  },
  config: {
    aws: 'Fix the `.tf` file referenced in the error and re-run `terraform validate`.',
    azure: 'Fix the `.tf` file referenced in the error and re-run `terraform validate`.',
    gcp: 'Fix the `.tf` file referenced in the error and re-run `terraform validate`.',
    local: 'Fix the `.tf` file referenced in the error and re-run `terraform validate`.'
  },
  cancelled: {
    aws: 'Run was cancelled by user; re-run when ready.',
    azure: 'Run was cancelled by user; re-run when ready.',
    gcp: 'Run was cancelled by user; re-run when ready.',
    local: 'Run was cancelled by user; re-run when ready.'
  },
  unknown: {
    aws: 'Review the output below for the exact Terraform error.',
    azure: 'Review the output below for the exact Terraform error.',
    gcp: 'Review the output below for the exact Terraform error.',
    local: 'Review the output below for the exact Terraform error.'
  }
}

export function suggestedActionFor(
  errorClass: TerraformErrorClass,
  provider: TerraformAuditProviderId
): string {
  return SUGGESTED_ACTIONS[errorClass][provider] ?? SUGGESTED_ACTIONS.unknown[provider]
}

export type ClassifyTerraformErrorInput = {
  output: string
  exitCode: number | null
  errorMessage: string
  provider: TerraformAuditProviderId
  /** Optional throwable — used for `instanceof` pre-checks (cancelled, timeout) before regex fallback. */
  errorName?: string
}

/**
 * Classify a failed terraform CLI run from its accumulated output + exit code.
 * Callers pass `errorName` so this module can avoid importing Electron-side error classes:
 * pass 'TerraformCommandCancelledError' or 'OperationTimeoutError' when applicable.
 */
export function classifyTerraformError(input: ClassifyTerraformErrorInput): ClassifiedTerraformError {
  // Pre-checks from the caller's error object — these are more reliable than regex.
  if (input.errorName === 'TerraformCommandCancelledError') {
    return {
      errorClass: 'cancelled',
      suggestedAction: suggestedActionFor('cancelled', input.provider)
    }
  }
  if (input.errorName === 'OperationTimeoutError') {
    return {
      errorClass: 'timeout',
      suggestedAction: suggestedActionFor('timeout', input.provider)
    }
  }

  const rawHaystack = `${input.errorMessage}\n${input.output}`
  const haystack = tailBytes(stripAnsiLocal(rawHaystack), MAX_CLASSIFIER_INPUT_BYTES)

  if (anyMatch(TIMEOUT_PATTERNS, haystack)) {
    return { errorClass: 'timeout', suggestedAction: suggestedActionFor('timeout', input.provider) }
  }
  if (anyMatch(STATE_LOCK_PATTERNS, haystack)) {
    return { errorClass: 'state_lock', suggestedAction: suggestedActionFor('state_lock', input.provider) }
  }
  if (anyMatch(AUTH_PATTERNS, haystack)) {
    return { errorClass: 'auth', suggestedAction: suggestedActionFor('auth', input.provider) }
  }
  if (anyMatch(RATE_LIMIT_PATTERNS, haystack)) {
    return { errorClass: 'rate_limit', suggestedAction: suggestedActionFor('rate_limit', input.provider) }
  }
  if (anyMatch(NETWORK_PATTERNS, haystack)) {
    return { errorClass: 'network', suggestedAction: suggestedActionFor('network', input.provider) }
  }
  if (anyMatch(PLUGIN_PATTERNS, haystack)) {
    return { errorClass: 'plugin', suggestedAction: suggestedActionFor('plugin', input.provider) }
  }
  if ((input.exitCode === 1 || input.exitCode === null) && anyMatch(CONFIG_PATTERNS, haystack)) {
    return { errorClass: 'config', suggestedAction: suggestedActionFor('config', input.provider) }
  }

  return { errorClass: 'unknown', suggestedAction: suggestedActionFor('unknown', input.provider) }
}

/**
 * Classify a cloud SDK error (Azure/GCP/AWS SDK) raised during a drift scan.
 * Uses message-level pattern matching across the same taxonomy. `state_lock`,
 * `plugin`, and `config` are CLI-specific and therefore never returned here.
 */
export function classifyCloudSdkError(
  error: unknown,
  provider: TerraformAuditProviderId
): ClassifiedTerraformError {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const name = error instanceof Error ? error.name : ''

  if (name === 'TerraformCommandCancelledError') {
    return { errorClass: 'cancelled', suggestedAction: suggestedActionFor('cancelled', provider) }
  }
  if (name === 'OperationTimeoutError') {
    return { errorClass: 'timeout', suggestedAction: suggestedActionFor('timeout', provider) }
  }

  const haystack = stripAnsiLocal(message)

  if (anyMatch(TIMEOUT_PATTERNS, haystack)) {
    return { errorClass: 'timeout', suggestedAction: suggestedActionFor('timeout', provider) }
  }
  if (anyMatch(AUTH_PATTERNS, haystack)) {
    return { errorClass: 'auth', suggestedAction: suggestedActionFor('auth', provider) }
  }
  if (anyMatch(RATE_LIMIT_PATTERNS, haystack)) {
    return { errorClass: 'rate_limit', suggestedAction: suggestedActionFor('rate_limit', provider) }
  }
  if (anyMatch(NETWORK_PATTERNS, haystack)) {
    return { errorClass: 'network', suggestedAction: suggestedActionFor('network', provider) }
  }

  return { errorClass: 'unknown', suggestedAction: suggestedActionFor('unknown', provider) }
}
