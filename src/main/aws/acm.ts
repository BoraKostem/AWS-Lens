import {
  ACMClient,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
  ListCertificatesCommand,
  RequestCertificateCommand
} from '@aws-sdk/client-acm'

import type { AcmCertificateDetail, AcmCertificateSummary, AcmRequestCertificateInput, AwsConnection } from '@shared/types'
import { awsClientConfig } from './client'

function createClient(connection: AwsConnection): ACMClient {
  return new ACMClient(awsClientConfig(connection))
}

function toIso(value: Date | undefined): string {
  return value ? value.toISOString() : ''
}

export async function listAcmCertificates(connection: AwsConnection): Promise<AcmCertificateSummary[]> {
  const client = createClient(connection)
  const items: AcmCertificateSummary[] = []
  let nextToken: string | undefined

  do {
    const response = await client.send(new ListCertificatesCommand({ NextToken: nextToken, Includes: { keyTypes: ['RSA_2048', 'EC_prime256v1'] } }))
    for (const cert of response.CertificateSummaryList ?? []) {
      items.push({
        certificateArn: cert.CertificateArn ?? '',
        domainName: cert.DomainName ?? '',
        status: cert.Status ?? '',
        type: cert.Type ?? '',
        inUse: Boolean((cert.InUse ?? false)),
        createdAt: toIso(cert.CreatedAt),
        issuedAt: '',
        notAfter: ''
      })
    }
    nextToken = response.NextToken
  } while (nextToken)

  return items
}

export async function describeAcmCertificate(connection: AwsConnection, certificateArn: string): Promise<AcmCertificateDetail> {
  const client = createClient(connection)
  const response = await client.send(new DescribeCertificateCommand({ CertificateArn: certificateArn }))
  const certificate = response.Certificate

  if (!certificate) {
    throw new Error('Certificate not found.')
  }

  return {
    certificateArn: certificate.CertificateArn ?? certificateArn,
    domainName: certificate.DomainName ?? '',
    subjectAlternativeNames: certificate.SubjectAlternativeNames ?? [],
    status: certificate.Status ?? '',
    type: certificate.Type ?? '',
    keyAlgorithm: certificate.KeyAlgorithm ?? '',
    signatureAlgorithm: certificate.SignatureAlgorithm ?? '',
    createdAt: toIso(certificate.CreatedAt),
    issuedAt: toIso(certificate.IssuedAt),
    notBefore: toIso(certificate.NotBefore),
    notAfter: toIso(certificate.NotAfter),
    renewalEligibility: certificate.RenewalEligibility ?? '',
    renewalStatus: certificate.RenewalSummary?.RenewalStatus ?? '',
    inUseBy: certificate.InUseBy ?? [],
    domainValidationOptions: (certificate.DomainValidationOptions ?? []).map((item) => ({
      domainName: item.DomainName ?? '',
      validationStatus: item.ValidationStatus ?? '',
      validationMethod: item.ValidationMethod ?? '',
      resourceRecordName: item.ResourceRecord?.Name ?? '',
      resourceRecordType: item.ResourceRecord?.Type ?? '',
      resourceRecordValue: item.ResourceRecord?.Value ?? ''
    }))
  }
}

export async function requestAcmCertificate(connection: AwsConnection, input: AcmRequestCertificateInput): Promise<string> {
  const client = createClient(connection)
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
  const client = createClient(connection)
  await client.send(new DeleteCertificateCommand({ CertificateArn: certificateArn }))
}
