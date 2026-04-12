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

export {
  GCP_TTL_COMPUTE,
  GCP_TTL_NETWORK,
  GCP_TTL_DATA,
  GCP_TTL_IAM,
  GCP_TTL_BILLING,
  GCP_TTL_MONITOR,
  getOrFetch,
  forceRefresh,
  invalidateKey,
  invalidatePrefix,
  clearAllCache,
  getCacheStats
} from './cache'

export {
  getGcpServiceAccountDetail,
  updateGcpServiceAccount,
  addGcpServiceAccountIamBinding,
  removeGcpServiceAccountIamBinding,
  updateGcpCustomRole,
  undeleteGcpCustomRole,
  listGcpIamAuditEntries,
  generateGcpServiceAccountKeyReport,
  listGcpWorkloadIdentityPools,
  listGcpWorkloadIdentityProviders,
  listGcpIamRecommendations,
  analyzeGcpIamPolicy
} from './iam'
