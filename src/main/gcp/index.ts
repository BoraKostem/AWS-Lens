export {
  GCP_SDK_SCOPES,
  MAX_PAGINATION_PAGES,
  paginationGuard,
  getGcpAuth,
  evictGcpAuthPool,
  classifyGcpError,
  outputIndicatesApiDisabled,
  requestGcp,
  type GcpRequestOptions
} from './client'

export {
  getCredentialAuth,
  getCredentialClient,
  refreshCredentials,
  setImpersonationTarget,
  getImpersonationTarget,
  getCredentialStatus,
  type GcpCredentialStatus
} from './auth'
