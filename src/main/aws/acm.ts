import {
  ACMClient,
  type CertificateDetail,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  RequestCertificateCommand
} from '@aws-sdk/client-acm'

import type {
  AcmCertificateDetail,
  AcmCertificateSummary,
  AcmInUseAssociation,
  AcmLoadBalancerAssociation,
  AcmRequestCertificateInput,
  AwsConnection,
  LoadBalancerWorkspace
} from '@shared/types'
import { getAwsClient } from './client'
import { listLoadBalancerWorkspaces } from './loadBalancers'
import { logWarn } from '../observability'

function toIso(value: Date | undefined): string {
  return value ? value.toISOString() : ''
}

function getDaysUntilExpiry(notAfter: string): number | null {
  if (!notAfter) {
    return null
  }

  const timestamp = Date.parse(notAfter)
  if (Number.isNaN(timestamp)) {
    return null
  }

  const diff = timestamp - Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  return diff >= 0 ? Math.ceil(diff / dayMs) : Math.floor(diff / dayMs)
}

function getValidationIssue(validationMethod: string, validationStatus: string, recordName: string, recordValue: string): string {
  if (validationMethod !== 'DNS') {
    return ''
  }
  if (validationStatus === 'SUCCESS') {
    return ''
  }
  if (!recordName || !recordValue) {
    return 'DNS validation record missing.'
  }
  if (validationStatus === 'PENDING_VALIDATION') {
    return 'DNS validation is still pending.'
  }
  return `DNS validation status is ${validationStatus || 'unknown'}.`
}

function buildInUseAssociation(arn: string): AcmInUseAssociation {
  const [prefix, , service = '', , , resource = ''] = arn.split(':')
  if (prefix !== 'arn') {
    return { arn, service: 'unknown', resourceType: 'resource', label: arn }
  }

  if (service === 'elasticloadbalancing') {
    const parts = resource.split('/')
    const resourceType = parts[0] ?? 'load-balancer'
    const name = parts[1] ?? parts.at(-1) ?? arn
    return {
      arn,
      service,
      resourceType,
      label: `${resourceType} ${name}`
    }
  }

  const resourceType = resource.split('/')[0] || 'resource'
  const resourceId = resource.split('/').at(-1) || arn
  return {
    arn,
    service,
    resourceType,
    label: `${service}:${resourceType} ${resourceId}`
  }
}

async function loadLoadBalancerAssociations(connection: AwsConnection): Promise<Map<string, AcmLoadBalancerAssociation[]>> {
  try {
    const workspaces = await listLoadBalancerWorkspaces(connection)
    return indexLoadBalancerAssociations(workspaces)
  } catch (error) {
    logWarn('acm.load-lb-associations', 'Failed to load load balancer associations for ACM enrichment.', { region: connection.region }, error)
    return new Map()
  }
}

function indexLoadBalancerAssociations(workspaces: LoadBalancerWorkspace[]): Map<string, AcmLoadBalancerAssociation[]> {
  const associations = new Map<string, AcmLoadBalancerAssociation[]>()

  for (const workspace of workspaces) {
    for (const listener of workspace.listeners) {
      for (const certificateArn of listener.certificates) {
        const list = associations.get(certificateArn) ?? []
        list.push({
          loadBalancerArn: workspace.summary.arn,
          loadBalancerName: workspace.summary.name,
          dnsName: workspace.summary.dnsName,
          listenerArn: listener.arn,
          listenerPort: listener.port,
          listenerProtocol: listener.protocol
        })
        associations.set(certificateArn, list)
      }
    }
  }

  return associations
}

function buildCertificateView(
  certificate: CertificateDetail,
  fallbackArn: string,
  loadBalancerAssociationsMap: Map<string, AcmLoadBalancerAssociation[]>
): AcmCertificateDetail {
  const certificateArn = certificate.CertificateArn ?? fallbackArn
  const domainValidationOptions = (certificate.DomainValidationOptions ?? []).map((item: any) => {
    const resourceRecordName = item.ResourceRecord?.Name ?? ''
    const resourceRecordValue = item.ResourceRecord?.Value ?? ''
    return {
      domainName: item.DomainName ?? '',
      validationStatus: item.ValidationStatus ?? '',
      validationMethod: item.ValidationMethod ?? '',
      resourceRecordName,
      resourceRecordType: item.ResourceRecord?.Type ?? '',
      resourceRecordValue,
      validationIssue: getValidationIssue(item.ValidationMethod ?? '', item.ValidationStatus ?? '', resourceRecordName, resourceRecordValue)
    }
  })
  const notAfter = toIso(certificate.NotAfter)
  const inUseBy = (certificate.InUseBy ?? []).filter((entry: string | undefined): entry is string => Boolean(entry))
  const loadBalancerAssociations = loadBalancerAssociationsMap.get(certificateArn) ?? []
  const daysUntilExpiry = getDaysUntilExpiry(notAfter)
  const pendingValidationCount = domainValidationOptions.filter((item) => item.validationStatus === 'PENDING_VALIDATION').length
  const dnsValidationIssueCount = domainValidationOptions.filter((item) => item.validationIssue).length
  const inUse = inUseBy.length > 0 || loadBalancerAssociations.length > 0
  const unused = !inUse

  let urgencySeverity: AcmCertificateDetail['urgencySeverity'] = 'none'
  let urgencyReason = ''

  if (certificate.Status === 'EXPIRED' || certificate.Status === 'REVOKED' || certificate.Status === 'FAILED' || dnsValidationIssueCount > 0) {
    urgencySeverity = 'critical'
    urgencyReason = dnsValidationIssueCount > 0 ? 'DNS validation needs attention.' : `Certificate status is ${certificate.Status ?? 'unknown'}.`
  } else if (daysUntilExpiry !== null && daysUntilExpiry <= 7) {
    urgencySeverity = 'critical'
    urgencyReason = daysUntilExpiry < 0 ? 'Certificate is expired.' : 'Certificate expires within 7 days.'
  } else if (certificate.Status === 'PENDING_VALIDATION' || pendingValidationCount > 0 || (daysUntilExpiry !== null && daysUntilExpiry <= 30)) {
    urgencySeverity = 'warning'
    urgencyReason = pendingValidationCount > 0 ? 'Validation is still pending.' : 'Certificate expires within 30 days.'
  } else if (notAfter) {
    urgencySeverity = 'stable'
    urgencyReason = 'Certificate is currently healthy.'
  }

  return {
    certificateArn,
    domainName: certificate.DomainName ?? '',
    subjectAlternativeNames: certificate.SubjectAlternativeNames ?? [],
    status: certificate.Status ?? '',
    type: certificate.Type ?? '',
    keyAlgorithm: certificate.KeyAlgorithm ?? '',
    signatureAlgorithm: certificate.SignatureAlgorithm ?? '',
    createdAt: toIso(certificate.CreatedAt),
    issuedAt: toIso(certificate.IssuedAt),
    notBefore: toIso(certificate.NotBefore),
    notAfter,
    daysUntilExpiry,
    urgencySeverity,
    urgencyReason,
    renewalEligibility: certificate.RenewalEligibility ?? '',
    renewalStatus: certificate.RenewalSummary?.RenewalStatus ?? '',
    inUse,
    unused,
    inUseBy,
    inUseAssociations: inUseBy.map(buildInUseAssociation),
    loadBalancerAssociations,
    pendingValidationCount,
    dnsValidationIssueCount,
    domainValidationOptions
  }
}

export async function listAcmCertificates(connection: AwsConnection): Promise<AcmCertificateSummary[]> {
  const client = getAwsClient(ACMClient, connection)
  const items: Array<{ certificateArn: string }> = []
  let nextToken: string | undefined

  do {
    const response = await client.send(new ListCertificatesCommand({ NextToken: nextToken, Includes: { keyTypes: ['RSA_2048', 'EC_prime256v1'] } }))
    for (const cert of response.CertificateSummaryList ?? []) {
      items.push({
        certificateArn: cert.CertificateArn ?? ''
      })
    }
    nextToken = response.NextToken
  } while (nextToken)

  const loadBalancerAssociationsMap = await loadLoadBalancerAssociations(connection)
  const details = await Promise.all(
    items.map(async ({ certificateArn }) => {
      const response = await client.send(new DescribeCertificateCommand({ CertificateArn: certificateArn }))
      const certificate = response.Certificate
      if (!certificate) {
        return null
      }
      return buildCertificateView(certificate, certificateArn, loadBalancerAssociationsMap)
    })
  )

  return details
    .filter((detail): detail is AcmCertificateDetail => Boolean(detail))
    .map((detail): AcmCertificateSummary => ({
      certificateArn: detail.certificateArn,
      domainName: detail.domainName,
      status: detail.status,
      type: detail.type,
      inUse: detail.inUse,
      unused: detail.unused,
      createdAt: detail.createdAt,
      issuedAt: detail.issuedAt,
      notAfter: detail.notAfter,
      daysUntilExpiry: detail.daysUntilExpiry,
      urgencySeverity: detail.urgencySeverity,
      urgencyReason: detail.urgencyReason,
      renewalEligibility: detail.renewalEligibility,
      renewalStatus: detail.renewalStatus,
      pendingValidationCount: detail.pendingValidationCount,
      dnsValidationIssueCount: detail.dnsValidationIssueCount,
      inUseByCount: detail.inUseBy.length + detail.loadBalancerAssociations.length,
      loadBalancerAssociations: detail.loadBalancerAssociations,
      inUseAssociations: detail.inUseAssociations
    }))
}

export async function describeAcmCertificate(connection: AwsConnection, certificateArn: string): Promise<AcmCertificateDetail> {
  const client = getAwsClient(ACMClient, connection)
  const loadBalancerAssociationsMap = await loadLoadBalancerAssociations(connection)
  const response = await client.send(new DescribeCertificateCommand({ CertificateArn: certificateArn }))
  const certificate = response.Certificate

  if (!certificate) {
    throw new Error('Certificate not found.')
  }

  return buildCertificateView(certificate, certificateArn, loadBalancerAssociationsMap)
}

export async function requestAcmCertificate(connection: AwsConnection, input: AcmRequestCertificateInput): Promise<string> {
  const client = getAwsClient(ACMClient, connection)
  const response = await client.send(
    new RequestCertificateCommand({
      DomainName: input.domainName,
      SubjectAlternativeNames: input.subjectAlternativeNames,
      ValidationMethod: input.validationMethod
    })
  )

  return response.CertificateArn ?? ''
}

export async function deleteAcmCertificate(connection: AwsConnection, certificateArn: string): Promise<void> {
  const client = getAwsClient(ACMClient, connection)
  await client.send(new DeleteCertificateCommand({ CertificateArn: certificateArn }))
}
