/**
 * Regression tests for webBridge method presence.
 *
 * History of bugs caught by this test:
 *   - subscribeTempVolumeProgress missing → blank EC2 temp-volume panel
 *   - getRelationshipMap named getOverviewRelationships → blank Overview relationship view
 *   - searchByTag named searchOverviewTags → blank tag search
 *   - terraformWorkspace short names (detectCli etc.) missing → blank terraform panels
 *
 * Rule: property names must match preload/index.ts contextBridge.exposeInMainWorld() exactly.
 */

import { describe, it, expect } from 'vitest'
import { webBridge, terraformBridge } from '../webBridge'

// Push-style methods (subscribe/unsubscribe patterns)
const PUSH_METHODS = [
  'subscribeTerminal',
  'unsubscribeTerminal',
  'subscribeTempVolumeProgress',
  'unsubscribeTempVolumeProgress',
  'onTerminalEvent',
  'offTerminalEvent',
] as const

// Previously-misnamed methods that caused runtime crashes
const CANONICAL_AWSLENS_METHODS = [
  // Was: getOverviewRelationships
  'getRelationshipMap',
  // Was: searchOverviewTags
  'searchByTag',
  // Was: terminateInstance
  'terminateEc2Instance',
  // Was: resizeEc2Instance (mapped wrong channel)
  'runEc2InstanceAction',
  // Was: listSnapshots / createSnapshot / deleteSnapshot
  'listEc2Snapshots',
  'createEc2Snapshot',
  'deleteEc2Snapshot',
  // Was: launchBastionInstance / deleteBastionInstance / listBastionInstances / findBastionConnections
  'launchBastion',
  'deleteBastion',
  'listBastions',
  'findBastionConnectionsForInstance',
  // Was: getSsmTarget
  'getSsmConnectionTarget',
  // Was: getEcrLoginPassword / dockerLoginEcr / dockerPullEcr
  'getEcrAuthorizationToken',
  'ecrDockerLogin',
  'ecrDockerPull',
  'ecrDockerPush',
  // Was: launchEksKubectl
  'launchKubectlTerminal',
  // Was: listVpcSecurityGroups
  'listSecurityGroupsForVpc',
  // Was: getReachabilityPath
  'getReachabilityAnalysis',
  // Was: lookupAccessKey
  'lookupAccessKeyOwnership',
  // Was: kmsDecrypt
  'decryptCiphertext',
  // Was: getLambdaCode / invokeLambda / createLambda / deleteLambda
  'getLambdaFunctionCode',
  'invokeLambdaFunction',
  'createLambdaFunction',
  'deleteLambdaFunction',
  // Was: openS3InVscode
  'openS3InVSCode',
  // Was: enableS3Versioning / enableS3Encryption
  'enableS3BucketVersioning',
  'enableS3BucketEncryption',
  // Was: putSecretPolicy
  'putSecretResourcePolicy',
  // Was: setSnsAttribute / subscribeSns / unsubscribeSns / publishSns / tagSns / untagSns
  'setSnsTopicAttribute',
  'snsSubscribe',
  'snsUnsubscribe',
  'snsPublish',
  'tagSnsTopic',
  'untagSnsTopic',
  // Was: receiveSqsMessages / sendSqsMessage / deleteSqsMessage / changeSqsVisibility / getSqsTimeline / tagSqs / untagSqs
  'sqsReceiveMessages',
  'sqsSendMessage',
  'sqsDeleteMessage',
  'sqsChangeVisibility',
  'sqsTimeline',
  'tagSqsQueue',
  'untagSqsQueue',
  // Was: listCloudTrailTrails
  'listTrails',
  // Was: getCloudWatchRecentEvents / getCloudWatchMetricStats / getEc2InstanceMetrics / getAllEc2MetricSeries
  'listCloudWatchRecentEvents',
  'getMetricStatistics',
  'listEc2InstanceMetrics',
  'getEc2AllMetricSeries',
  // Was: listWafWebAcls / createWafWebAcl / deleteWafWebAcl / describeWafWebAcl / associateWafResource / disassociateWafResource
  'listWebAcls',
  'createWebAcl',
  'deleteWebAcl',
  'describeWebAcl',
  'associateWebAcl',
  'disassociateWebAcl',
  // Was: openTerminal / updateTerminalContext
  'openAwsTerminal',
  'updateAwsTerminalContext',
  // IAM — was missing Iam prefix
  'listIamUserGroups',
  'addIamUserToGroup',
  'removeIamUserFromGroup',
  'createIamLoginProfile',
  'deleteIamLoginProfile',
  'listIamAccessKeys',
  'createIamAccessKey',
  'deleteIamAccessKey',
  'updateIamAccessKeyStatus',
  'listIamMfaDevices',
  'deleteIamMfaDevice',
  'listAttachedIamUserPolicies',
  'listIamUserInlinePolicies',
  'attachIamUserPolicy',
  'detachIamUserPolicy',
  'putIamUserInlinePolicy',
  'deleteIamUserInlinePolicy',
  'listAttachedIamGroupPolicies',
  'attachIamGroupPolicy',
  'detachIamGroupPolicy',
  'listAttachedIamRolePolicies',
  'attachIamRolePolicy',
  'detachIamRolePolicy',
  'listIamRoleInlinePolicies',
  'putIamRoleInlinePolicy',
  'deleteIamRoleInlinePolicy',
  'getIamRoleTrustPolicy',
  'updateIamRoleTrustPolicy',
  'getIamPolicyVersion',
  'listIamPolicyVersions',
  'createIamPolicyVersion',
  'deleteIamPolicyVersion',
  'generateIamCredentialReport',
] as const

// terraformWorkspace bridge uses SHORT names (matching preload's terraformWorkspace object)
const TERRAFORM_WORKSPACE_METHODS = [
  'detectCli',
  'getCliInfo',
  'listProjects',
  'getProject',
  'getDrift',
  'getObservabilityReport',
  'chooseProjectDirectory',
  'chooseVarFile',
  'addProject',
  'renameProject',
  'openProjectInVsCode',
  'removeProject',
  'reloadProject',
  'selectWorkspace',
  'createWorkspace',
  'deleteWorkspace',
  'getSelectedProjectId',
  'setSelectedProjectId',
  'updateInputs',
  'getMissingRequiredInputs',
  'validateProjectInputs',
  'listCommandLogs',
  'runCommand',
  'hasSavedPlan',
  'clearSavedPlan',
  'detectMissingVars',
  'listRunHistory',
  'getRunOutput',
  'deleteRunRecord',
  'detectGovernanceTools',
  'getGovernanceToolkit',
  'runGovernanceChecks',
  'getGovernanceReport',
  'subscribe',
  'unsubscribe',
] as const

describe('webBridge — push methods', () => {
  it.each(PUSH_METHODS)('window.awsLens.%s is a function', (method) => {
    expect(typeof (webBridge as Record<string, unknown>)[method]).toBe('function')
  })
})

describe('webBridge — canonical method names (regression)', () => {
  it.each(CANONICAL_AWSLENS_METHODS)('window.awsLens.%s is a function', (method) => {
    expect(typeof (webBridge as Record<string, unknown>)[method]).toBe('function')
  })
})

describe('terraformBridge — short names matching preload terraformWorkspace', () => {
  it.each(TERRAFORM_WORKSPACE_METHODS)('window.terraformWorkspace.%s is a function', (method) => {
    expect(typeof (terraformBridge as Record<string, unknown>)[method]).toBe('function')
  })
})
