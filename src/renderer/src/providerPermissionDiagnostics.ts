import type { AzureProviderContextSnapshot, CloudProviderId, EnterpriseAccessMode } from '@shared/types'

export type ProviderPermissionDiagnosticStatus = 'ok' | 'warning' | 'error'

export type ProviderPermissionDiagnosticItem = {
  id: string
  label: string
  status: ProviderPermissionDiagnosticStatus
  detail: string
  remediation?: string
}

export type ProviderPermissionDiagnosticsReport = {
  providerId: CloudProviderId
  providerLabel: string
  summary: string
  items: ProviderPermissionDiagnosticItem[]
}

function buildAwsDiagnostics(
  providerLabel: string,
  accessMode: EnterpriseAccessMode,
  selectedContextLabel: string | null
): ProviderPermissionDiagnosticsReport {
  if (!selectedContextLabel) {
    return {
      providerId: 'aws',
      providerLabel,
      summary: 'Select an AWS profile or assumed session before the shell can explain IAM and API failures precisely.',
      items: [
        {
          id: 'aws-context',
          label: 'Shell context',
          status: 'warning',
          detail: 'No AWS profile or assumed-role session is selected yet.',
          remediation: 'Choose a profile or activate a Session Hub target so the shell can bind IAM diagnostics to a real account and region.'
        },
        {
          id: 'aws-sts',
          label: 'STS identity path',
          status: 'warning',
          detail: 'The app cannot validate caller identity or account scope until an AWS context is active.',
          remediation: 'After selecting a profile, use the terminal or session surfaces to confirm `sts:GetCallerIdentity` succeeds.'
        },
        {
          id: 'aws-read-actions',
          label: 'Read API coverage',
          status: 'warning',
          detail: 'Service consoles depend on exact `List*`, `Describe*`, and `Get*` permissions for the selected account and region.',
          remediation: 'If a screen fails, request only the blocked read actions instead of broad administrator access.'
        }
      ]
    }
  }

  return {
    providerId: 'aws',
    providerLabel,
    summary: `AWS is scoped to ${selectedContextLabel}. IAM diagnostics can now explain whether a failure is identity, read-path, or mutation-path related.`,
    items: [
      {
        id: 'aws-context',
        label: 'Shell context',
        status: 'ok',
        detail: `The shell is bound to ${selectedContextLabel}, so AWS diagnostics can stay account and region specific.`
      },
      {
        id: 'aws-sts',
        label: 'Identity resolution',
        status: 'ok',
        detail: 'AWS flows can anchor failures to the active caller identity, assumed role, and regional context.'
      },
      {
        id: 'aws-read-actions',
        label: 'Read API guidance',
        status: 'warning',
        detail: 'Inventory and posture surfaces still require exact service read actions such as `Describe*`, `List*`, or `Get*`.',
        remediation: 'Ask for the smallest missing read action that matches the blocked screen instead of broad IAM expansion.'
      },
      {
        id: 'aws-write-actions',
        label: accessMode === 'operator' ? 'Mutation path' : 'Workspace mode',
        status: accessMode === 'operator' ? 'warning' : 'ok',
        detail: accessMode === 'operator'
          ? 'Write operations can still fail when service-specific actions like `ec2:StartInstances`, `iam:PassRole`, or `s3:PutBucketPolicy` are missing.'
          : 'The shell is currently read-only, so blocked mutations should be treated as workspace mode policy rather than missing cloud permissions.',
        remediation: accessMode === 'operator'
          ? 'Escalate only the exact service mutation or `PassRole` action tied to the failed workflow.'
          : ''
      }
    ]
  }
}

function buildGcpDiagnostics(
  providerLabel: string,
  accessMode: EnterpriseAccessMode,
  selectedModeLabel: string | null
): ProviderPermissionDiagnosticsReport {
  if (!selectedModeLabel) {
    return {
      providerId: 'gcp',
      providerLabel,
      summary: 'Choose a Google Cloud connection mode first so diagnostics can map failures to the right credential source, project APIs, and IAM roles.',
      items: [
        {
          id: 'gcp-mode',
          label: 'Credential mode',
          status: 'warning',
          detail: 'No Google Cloud connection mode is selected yet.',
          remediation: 'Select ADC, service account handoff, or project-context staging before opening the shell.'
        },
        {
          id: 'gcp-apis',
          label: 'Required APIs',
          status: 'warning',
          detail: 'Shared workspaces will need Service Usage and Cloud Resource Manager coverage before project-scoped diagnostics can be trusted.',
          remediation: 'Expect to verify API enablement for the target project once live GCP probes land.'
        },
        {
          id: 'gcp-roles',
          label: 'IAM role floor',
          status: 'warning',
          detail: 'Read-only inventory will still depend on project-level roles such as Browser, Viewer, or service-specific viewer roles.',
          remediation: 'Request only the missing viewer role or permission set that matches the blocked service.'
        }
      ]
    }
  }

  return {
    providerId: 'gcp',
    providerLabel,
    summary: `${selectedModeLabel} is selected. The shell can now explain Google Cloud failures as missing APIs, project scopes, or IAM role gaps instead of generic preview errors.`,
    items: [
      {
        id: 'gcp-mode',
        label: 'Credential mode',
        status: 'ok',
        detail: `${selectedModeLabel} is now the active Google Cloud shell context.`
      },
      {
        id: 'gcp-apis',
        label: 'Project API enablement',
        status: 'warning',
        detail: 'The first rollout slices will depend on Cloud Resource Manager, Service Usage, Compute Engine, GKE, Cloud Storage, and Billing APIs.',
        remediation: 'If inventory is empty or lookups fail, confirm the required project APIs are enabled before escalating IAM.'
      },
      {
        id: 'gcp-roles',
        label: 'Project IAM roles',
        status: 'warning',
        detail: 'Shared read paths typically need Browser or Viewer plus service-specific viewer roles such as `roles/compute.viewer` or `roles/container.viewer`.',
        remediation: 'Request the narrowest project or folder role that covers the blocked service.'
      },
      {
        id: 'gcp-write-path',
        label: accessMode === 'operator' ? 'Operator write path' : 'Workspace mode',
        status: accessMode === 'operator' ? 'warning' : 'ok',
        detail: accessMode === 'operator'
          ? 'Mutating workflows will need editor-style permissions on the target project and sometimes service-account impersonation rights.'
          : 'The shell is read-only, so missing write behavior should not be treated as a cloud permission gap yet.',
        remediation: accessMode === 'operator'
          ? 'Escalate only the exact editor or impersonation permission that blocks the active flow.'
          : ''
      }
    ]
  }
}

function buildAzureDiagnostics(
  providerLabel: string,
  accessMode: EnterpriseAccessMode,
  selectedModeLabel: string | null,
  azureContext: AzureProviderContextSnapshot | null
): ProviderPermissionDiagnosticsReport {
  if (azureContext) {
    const contextReady = azureContext.auth.status === 'authenticated' && Boolean(azureContext.activeSubscriptionId || azureContext.activeTenantId)
    const baseItems: ProviderPermissionDiagnosticItem[] = [
      {
        id: 'azure-live-context',
        label: 'Live provider context',
        status: contextReady ? 'ok' : azureContext.auth.status === 'error' || azureContext.auth.status === 'signed-out' ? 'error' : 'warning',
        detail: contextReady
          ? `${azureContext.activeAccountLabel} is the active Azure provider context consumed by the shell and shared workspaces.`
          : azureContext.auth.message || 'Azure foundation is present, but the provider context is not fully ready yet.',
        remediation: contextReady
          ? ''
          : 'Use the Azure foundation panel to complete sign-in, tenant selection, and subscription selection before relying on Azure service surfaces.'
      }
    ]

    const diagnosticItems = azureContext.diagnostics.map<ProviderPermissionDiagnosticItem>((diagnostic) => ({
      id: `azure-${diagnostic.code}`,
      label: diagnostic.title,
      status: diagnostic.severity === 'error' ? 'error' : diagnostic.severity === 'warning' ? 'warning' : 'ok',
      detail: diagnostic.detail,
      remediation: diagnostic.remediation
    }))

    return {
      providerId: 'azure',
      providerLabel,
      summary: contextReady
        ? `Azure diagnostics are reading from the live provider snapshot for ${azureContext.activeAccountLabel}. Auth, scope, provider registration, and workspace mode are now differentiated explicitly.`
        : 'Azure diagnostics are reading from the live provider foundation snapshot, but auth or scope still needs remediation before service data can be trusted.',
      items: [...baseItems, ...diagnosticItems]
    }
  }

  if (!selectedModeLabel) {
    return {
      providerId: 'azure',
      providerLabel,
      summary: 'Choose an Azure connection mode first so diagnostics can tie failures to tenant scope, subscription scope, and RBAC posture consistently.',
      items: [
        {
          id: 'azure-mode',
          label: 'Tenant or subscription mode',
          status: 'warning',
          detail: 'No Azure connection mode is selected yet.',
          remediation: 'Select a subscription, tenant-aware flow, or CLI-assisted verification mode before opening the shell.'
        },
        {
          id: 'azure-rbac',
          label: 'RBAC baseline',
          status: 'warning',
          detail: 'Shared inventory will depend on subscription or resource-group Reader coverage before deeper consoles can explain failures cleanly.',
          remediation: 'Plan to verify Reader or service-specific read roles when Azure slices land.'
        },
        {
          id: 'azure-providers',
          label: 'Resource provider registration',
          status: 'warning',
          detail: 'Azure services can fail even with RBAC when the required `Microsoft.*` resource providers are not registered on the subscription.',
          remediation: 'Check provider registration before escalating broad access requests.'
        }
      ]
    }
  }

  return {
    providerId: 'azure',
    providerLabel,
    summary: `${selectedModeLabel} is selected. The shell can now separate Azure failures into RBAC, subscription scope, tenant scope, and provider-registration issues.`,
    items: [
      {
        id: 'azure-mode',
        label: 'Tenant or subscription mode',
        status: 'ok',
        detail: `${selectedModeLabel} is now the active Azure shell context.`
      },
      {
        id: 'azure-rbac',
        label: 'RBAC scope',
        status: 'warning',
        detail: 'Inventory surfaces generally need Reader on the subscription or resource group, while mutations need Contributor or narrower service roles.',
        remediation: 'Escalate only the role assignment scope that matches the blocked resource path.'
      },
      {
        id: 'azure-providers',
        label: 'Provider registration',
        status: 'warning',
        detail: 'Core slices will depend on providers such as `Microsoft.Compute`, `Microsoft.Storage`, `Microsoft.ContainerService`, and `Microsoft.Monitor`.',
        remediation: 'Confirm the missing `Microsoft.*` provider is registered before requesting higher RBAC.'
      },
      {
        id: 'azure-write-path',
        label: accessMode === 'operator' ? 'Operator write path' : 'Workspace mode',
        status: accessMode === 'operator' ? 'warning' : 'ok',
        detail: accessMode === 'operator'
          ? 'Write flows may also need Graph-adjacent or role-assignment permissions beyond plain ARM read access.'
          : 'The shell is read-only, so blocked mutations should be interpreted as workspace policy rather than an Azure RBAC gap.',
        remediation: accessMode === 'operator'
          ? 'Escalate only the exact Azure role assignment or Graph permission tied to the failed task.'
          : ''
      }
    ]
  }
}

export function buildProviderPermissionDiagnostics(params: {
  providerId: CloudProviderId
  providerLabel: string
  accessMode: EnterpriseAccessMode
  awsSelectedContextLabel?: string | null
  selectedPreviewModeLabel?: string | null
  azureContext?: AzureProviderContextSnapshot | null
}): ProviderPermissionDiagnosticsReport {
  const { providerId, providerLabel, accessMode, awsSelectedContextLabel, selectedPreviewModeLabel, azureContext } = params

  switch (providerId) {
    case 'gcp':
      return buildGcpDiagnostics(providerLabel, accessMode, selectedPreviewModeLabel ?? null)
    case 'azure':
      return buildAzureDiagnostics(providerLabel, accessMode, selectedPreviewModeLabel ?? null, azureContext ?? null)
    case 'aws':
    default:
      return buildAwsDiagnostics(providerLabel, accessMode, awsSelectedContextLabel ?? null)
  }
}
