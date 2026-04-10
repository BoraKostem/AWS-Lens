import type { AwsRegionOption } from '@shared/types'

const AWS_REGIONS: AwsRegionOption[] = [
  { providerId: 'aws', kind: 'region', id: 'us-east-1', name: 'US East (N. Virginia)' },
  { providerId: 'aws', kind: 'region', id: 'us-east-2', name: 'US East (Ohio)' },
  { providerId: 'aws', kind: 'region', id: 'us-west-1', name: 'US West (N. California)' },
  { providerId: 'aws', kind: 'region', id: 'us-west-2', name: 'US West (Oregon)' },
  { providerId: 'aws', kind: 'region', id: 'af-south-1', name: 'Africa (Cape Town)' },
  { providerId: 'aws', kind: 'region', id: 'ap-east-1', name: 'Asia Pacific (Hong Kong)' },
  { providerId: 'aws', kind: 'region', id: 'ap-south-1', name: 'Asia Pacific (Mumbai)' },
  { providerId: 'aws', kind: 'region', id: 'ap-south-2', name: 'Asia Pacific (Hyderabad)' },
  { providerId: 'aws', kind: 'region', id: 'ap-southeast-1', name: 'Asia Pacific (Singapore)' },
  { providerId: 'aws', kind: 'region', id: 'ap-southeast-2', name: 'Asia Pacific (Sydney)' },
  { providerId: 'aws', kind: 'region', id: 'ap-southeast-3', name: 'Asia Pacific (Jakarta)' },
  { providerId: 'aws', kind: 'region', id: 'ap-southeast-4', name: 'Asia Pacific (Melbourne)' },
  { providerId: 'aws', kind: 'region', id: 'ap-southeast-5', name: 'Asia Pacific (Malaysia)' },
  { providerId: 'aws', kind: 'region', id: 'ap-southeast-7', name: 'Asia Pacific (Thailand)' },
  { providerId: 'aws', kind: 'region', id: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)' },
  { providerId: 'aws', kind: 'region', id: 'ap-northeast-2', name: 'Asia Pacific (Seoul)' },
  { providerId: 'aws', kind: 'region', id: 'ap-northeast-3', name: 'Asia Pacific (Osaka)' },
  { providerId: 'aws', kind: 'region', id: 'ca-central-1', name: 'Canada (Central)' },
  { providerId: 'aws', kind: 'region', id: 'ca-west-1', name: 'Canada West (Calgary)' },
  { providerId: 'aws', kind: 'region', id: 'eu-central-1', name: 'Europe (Frankfurt)' },
  { providerId: 'aws', kind: 'region', id: 'eu-central-2', name: 'Europe (Zurich)' },
  { providerId: 'aws', kind: 'region', id: 'eu-west-1', name: 'Europe (Ireland)' },
  { providerId: 'aws', kind: 'region', id: 'eu-west-2', name: 'Europe (London)' },
  { providerId: 'aws', kind: 'region', id: 'eu-west-3', name: 'Europe (Paris)' },
  { providerId: 'aws', kind: 'region', id: 'eu-south-1', name: 'Europe (Milan)' },
  { providerId: 'aws', kind: 'region', id: 'eu-south-2', name: 'Europe (Spain)' },
  { providerId: 'aws', kind: 'region', id: 'eu-north-1', name: 'Europe (Stockholm)' },
  { providerId: 'aws', kind: 'region', id: 'il-central-1', name: 'Israel (Tel Aviv)' },
  { providerId: 'aws', kind: 'region', id: 'me-south-1', name: 'Middle East (Bahrain)' },
  { providerId: 'aws', kind: 'region', id: 'me-central-1', name: 'Middle East (UAE)' },
  { providerId: 'aws', kind: 'region', id: 'mx-central-1', name: 'Mexico (Central)' },
  { providerId: 'aws', kind: 'region', id: 'sa-east-1', name: 'South America (Sao Paulo)' }
]

export function listAwsRegions(): AwsRegionOption[] {
  return AWS_REGIONS
}
