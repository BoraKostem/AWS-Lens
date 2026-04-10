export type ErrorKind = 'permission' | 'throttle' | 'expired-token' | 'not-found' | 'timeout' | 'retryable' | 'generic'

export type ClassifiedError = {
  kind: ErrorKind
  original: string
  title: string
  guidance: string
}

const PERMISSION_PATTERNS = ['accessdenied', 'not authorized', 'unauthorizedaccess', 'forbidden', 'accessdeniedexception']
const THROTTLE_PATTERNS = ['throttling', 'rate exceeded', 'too many requests', 'throttlingexception']
const EXPIRED_PATTERNS = ['expiredtoken', 'expired token', 'token has expired', 'security token', 'invalidclienttokenid']
const NOT_FOUND_PATTERNS = ['not found', 'does not exist', 'nosuch', 'resourcenotfoundexception']
const TIMEOUT_PATTERNS = ['timed out', 'timeout', 'operationtimeouterror']
const RETRYABLE_PATTERNS = ['econnreset', 'socket hang up', 'temporarily unavailable', 'network error', 'try again']

export function classifyError(error: string): ClassifiedError {
  const lower = error.toLowerCase()

  if (PERMISSION_PATTERNS.some((p) => lower.includes(p))) {
    return {
      kind: 'permission',
      original: error,
      title: 'Access Denied',
      guidance: 'The current identity lacks the required permissions for this operation. Check the policies attached to your role or user.'
    }
  }
  if (THROTTLE_PATTERNS.some((p) => lower.includes(p))) {
    return { kind: 'throttle', original: error, title: 'Request Throttled', guidance: 'The cloud provider is rate-limiting requests. Wait a moment and try again.' }
  }
  if (EXPIRED_PATTERNS.some((p) => lower.includes(p))) {
    return { kind: 'expired-token', original: error, title: 'Session Expired', guidance: 'Your session credentials have expired. Re-authenticate or assume a new role.' }
  }
  if (NOT_FOUND_PATTERNS.some((p) => lower.includes(p))) {
    return { kind: 'not-found', original: error, title: 'Resource Not Found', guidance: 'The requested resource was not found. It may have been deleted or is in a different region.' }
  }
  if (TIMEOUT_PATTERNS.some((p) => lower.includes(p))) {
    return { kind: 'timeout', original: error, title: 'Operation Timed Out', guidance: 'The operation took too long to complete. Retry the action or narrow the scope to a smaller resource set.' }
  }
  if (RETRYABLE_PATTERNS.some((p) => lower.includes(p))) {
    return { kind: 'retryable', original: error, title: 'Temporary Failure', guidance: 'This looks transient. Retry the operation, and export diagnostics if the failure keeps repeating.' }
  }
  return { kind: 'generic', original: error, title: 'Error', guidance: '' }
}

export type SvcStateVariant =
  | 'loading'
  | 'empty'
  | 'no-selection'
  | 'no-filter-matches'
  | 'permission-denied'
  | 'partial-data'
  | 'retryable'
  | 'error'
  | 'unsupported'

export function variantForError(error?: string, fallback: SvcStateVariant = 'error'): SvcStateVariant {
  if (!error) return fallback
  const classified = classifyError(error)
  if (classified.kind === 'permission' || classified.kind === 'expired-token') {
    return 'permission-denied'
  }
  if (classified.kind === 'throttle' || classified.kind === 'timeout' || classified.kind === 'retryable') {
    return 'retryable'
  }
  return fallback
}

function article(word?: string): string {
  if (!word) return 'an'
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

function formatRefreshed(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value
  return d.toLocaleTimeString()
}

export function SvcState({
  variant,
  resourceName,
  message,
  error,
  lastRefreshed,
  compact,
  onDismiss,
  className
}: {
  variant: SvcStateVariant
  resourceName?: string
  message?: string
  error?: string
  lastRefreshed?: Date | string
  compact?: boolean
  onDismiss?: () => void
  className?: string
}) {
  const base = `svc-state${compact ? ' svc-state-compact' : ''}${className ? ` ${className}` : ''}`

  const dismiss = onDismiss ? (
    <button type="button" className="svc-state-dismiss" onClick={onDismiss} aria-label="Dismiss">&times;</button>
  ) : null

  const timestamp = lastRefreshed ? (
    <span className="svc-state-timestamp">Last refreshed: {formatRefreshed(lastRefreshed)}</span>
  ) : null

  if (variant === 'loading') {
    return (
      <div className={`${base} svc-state-loading`}>
        <span className="svc-state-spinner" />
        {message || `Loading ${resourceName || 'workspace'}...`}
        {timestamp}
      </div>
    )
  }

  if (variant === 'empty') {
    return (
      <div className={`${base} svc-state-empty`}>
        {message || `No ${resourceName || 'results'} are available yet.`}
        {timestamp}
      </div>
    )
  }

  if (variant === 'no-selection') {
    return (
      <div className={`${base} svc-state-empty`}>
        {message || `Select ${article(resourceName)} ${resourceName || 'item'} to continue.`}
        {timestamp}
      </div>
    )
  }

  if (variant === 'no-filter-matches') {
    return (
      <div className={`${base} svc-state-empty`}>
        {message || `No ${resourceName || 'items'} match the current filters.`}
        <span className="svc-state-hint">Try adjusting or clearing the filters.</span>
        {timestamp}
      </div>
    )
  }

  if (variant === 'unsupported') {
    return (
      <div className={`${base} svc-state-empty`}>
        {message || 'This action is not available for the current resource.'}
        {timestamp}
      </div>
    )
  }

  if (variant === 'partial-data') {
    return (
      <div className={`${base} svc-state-partial`}>
        {dismiss}
        <span className="svc-state-title">Incomplete Data</span>
        {message || 'Some data could not be loaded. Results may be incomplete.'}
        {timestamp}
      </div>
    )
  }

  const classified = error ? classifyError(error) : null

  if (variant === 'retryable') {
    const cls = classified ?? { title: 'Temporary Failure', guidance: 'Retry the operation in a moment.', original: error || '' }
    return (
      <div className={`${base} svc-state-partial`}>
        {dismiss}
        <span className="svc-state-title">{cls.title}</span>
        {message || cls.guidance}
        {cls.original && <code className="svc-state-code">{cls.original}</code>}
        {timestamp}
      </div>
    )
  }

  if (variant === 'error' && classified && (classified.kind === 'permission' || classified.kind === 'expired-token')) {
    return (
      <div className={`${base} svc-state-permission`}>
        {dismiss}
        <span className="svc-state-title">{classified.title}</span>
        {classified.guidance}
        <code className="svc-state-code">{classified.original}</code>
        {timestamp}
      </div>
    )
  }

  if (variant === 'permission-denied') {
    const cls = classified ?? {
      title: 'Access Denied',
      guidance: 'The current AWS identity or workspace mode does not allow this action. Check IAM permissions or switch to operator mode when appropriate.',
      original: error || ''
    }
    return (
      <div className={`${base} svc-state-permission`}>
        {dismiss}
        <span className="svc-state-title">{cls.title}</span>
        {cls.guidance}
        {cls.original && <code className="svc-state-code">{cls.original}</code>}
        {timestamp}
      </div>
    )
  }

  return (
    <div className={`${base} svc-state-error`}>
      {dismiss}
      {classified && classified.kind !== 'generic' && <span className="svc-state-title">{classified.title}</span>}
      {message || (classified ? classified.original : error || 'An unknown error occurred.')}
      {classified && classified.guidance && <span className="svc-state-hint">{classified.guidance}</span>}
      {timestamp}
    </div>
  )
}
