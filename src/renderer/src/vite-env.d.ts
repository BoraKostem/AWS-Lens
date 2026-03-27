/// <reference types="vite/client" />

import type {
  AssumeRoleRequest,
  AwsAssumeRoleTarget,
  AwsConnection,
  BastionLaunchConfig,
  Ec2InstanceAction,
  EbsTempInspectionProgress,
  EcsFargateServiceConfig,
  LambdaCreateConfig,
  SnapshotLaunchConfig,
  TerraformCommandRequest
} from '@shared/types'

declare global {
  interface Window {
    awsLens: {
      listProfiles: () => Promise<unknown>
      deleteProfile: (profileName: string) => Promise<unknown>
      chooseAndImportConfig: () => Promise<unknown>
      saveCredentials: (profileName: string, accessKeyId: string, secretAccessKey: string) => Promise<unknown>
      listRegions: () => Promise<unknown>
      getSessionHubState: () => Promise<unknown>
      saveAssumeRoleTarget: (target: Omit<AwsAssumeRoleTarget, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => Promise<unknown>
      deleteAssumeRoleTarget: (targetId: string) => Promise<unknown>
      deleteAssumedSession: (sessionId: string) => Promise<unknown>
      assumeRoleSession: (request: AssumeRoleRequest) => Promise<unknown>
      assumeSavedRoleTarget: (targetId: string) => Promise<unknown>
      listServices: () => Promise<unknown>
      getCallerIdentity: (connection: AwsConnection) => Promise<unknown>
      listEc2Instances: (connection: AwsConnection) => Promise<unknown>
      listEbsVolumes: (connection: AwsConnection) => Promise<unknown>
      describeEc2Instance: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      describeEbsVolume: (connection: AwsConnection, volumeId: string) => Promise<unknown>
      runEc2InstanceAction: (connection: AwsConnection, instanceId: string, action: Ec2InstanceAction) => Promise<unknown>
      terminateEc2Instance: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      resizeEc2Instance: (connection: AwsConnection, instanceId: string, instanceType: string) => Promise<unknown>
      listInstanceTypes: (connection: AwsConnection, architecture?: string, currentGenerationOnly?: boolean) => Promise<unknown>
      listEc2Snapshots: (connection: AwsConnection) => Promise<unknown>
      createEc2Snapshot: (connection: AwsConnection, volumeId: string, description: string) => Promise<unknown>
      deleteEc2Snapshot: (connection: AwsConnection, snapshotId: string) => Promise<unknown>
      tagEc2Snapshot: (connection: AwsConnection, snapshotId: string, tags: Record<string, string>) => Promise<unknown>
      getIamAssociation: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      attachIamProfile: (connection: AwsConnection, instanceId: string, profileName: string) => Promise<unknown>
      replaceIamProfile: (connection: AwsConnection, associationId: string, profileName: string) => Promise<unknown>
      removeIamProfile: (connection: AwsConnection, associationId: string) => Promise<unknown>
      launchBastion: (connection: AwsConnection, config: BastionLaunchConfig) => Promise<unknown>
      findBastionConnectionsForInstance: (connection: AwsConnection, targetInstanceId: string) => Promise<unknown>
      deleteBastion: (connection: AwsConnection, targetInstanceId: string) => Promise<unknown>
      createTempVolumeCheck: (connection: AwsConnection, volumeId: string) => Promise<unknown>
      deleteTempVolumeCheck: (connection: AwsConnection, tempUuidOrInstanceId: string) => Promise<unknown>
      listBastions: (connection: AwsConnection) => Promise<unknown>
      listPopularBastionAmis: (connection: AwsConnection, architecture?: string) => Promise<unknown>
      describeVpc: (connection: AwsConnection, vpcId: string) => Promise<unknown>
      launchFromSnapshot: (connection: AwsConnection, config: SnapshotLaunchConfig) => Promise<unknown>
      sendSshPublicKey: (connection: AwsConnection, instanceId: string, osUser: string, publicKey: string, az: string) => Promise<unknown>
      getEc2Recommendations: (connection: AwsConnection) => Promise<unknown>
      listLoadBalancerWorkspaces: (connection: AwsConnection) => Promise<unknown>
      deleteLoadBalancer: (connection: AwsConnection, loadBalancerArn: string) => Promise<unknown>
      listCloudWatchMetrics: (connection: AwsConnection) => Promise<unknown>
      getEc2MetricSeries: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      listCloudWatchLogGroups: (connection: AwsConnection) => Promise<unknown>
      listCloudWatchRecentEvents: (connection: AwsConnection, logGroupName: string) => Promise<unknown>
      listEc2InstanceMetrics: (connection: AwsConnection, instanceId: string) => Promise<unknown>
      getMetricStatistics: (connection: AwsConnection, metrics: unknown[], periodHours: number) => Promise<unknown>
      getEc2AllMetricSeries: (connection: AwsConnection, instanceId: string, periodHours: number) => Promise<unknown>
      listRoute53HostedZones: (connection: AwsConnection) => Promise<unknown>
      listRoute53Records: (connection: AwsConnection, hostedZoneId: string) => Promise<unknown>
      upsertRoute53Record: (connection: AwsConnection, hostedZoneId: string, record: unknown) => Promise<unknown>
      deleteRoute53Record: (connection: AwsConnection, hostedZoneId: string, record: unknown) => Promise<unknown>
      listTrails: (connection: AwsConnection) => Promise<unknown>
      lookupCloudTrailEvents: (connection: AwsConnection, startTime: string, endTime: string) => Promise<unknown>
      lookupCloudTrailEventsByResource: (connection: AwsConnection, resourceName: string, startTime: string, endTime: string) => Promise<unknown>
      getOverviewMetrics: (connection: AwsConnection, regions: string[]) => Promise<unknown>
      getOverviewStatistics: (connection: AwsConnection) => Promise<unknown>
      getComplianceReport: (connection: AwsConnection) => Promise<unknown>
      getRelationshipMap: (connection: AwsConnection) => Promise<unknown>
      searchByTag: (connection: AwsConnection, tagKey: string, tagValue?: string) => Promise<unknown>
      getCostBreakdown: (connection: AwsConnection) => Promise<unknown>
      openExternalUrl: (url: string) => Promise<unknown>
      chooseEc2SshKey: () => Promise<unknown>
      listEksClusters: (connection: AwsConnection) => Promise<unknown>
      describeEksCluster: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      listEksNodegroups: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      updateEksNodegroupScaling: (
        connection: AwsConnection,
        clusterName: string,
        nodegroupName: string,
        min: number,
        desired: number,
        max: number
      ) => Promise<unknown>
      listEksUpdates: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      deleteEksCluster: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      addEksToKubeconfig: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      launchKubectlTerminal: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      prepareEksKubectlSession: (connection: AwsConnection, clusterName: string) => Promise<unknown>
      runEksCommand: (connection: AwsConnection, clusterName: string, kubeconfigPath: string, command: string) => Promise<unknown>
      listEcsClusters: (connection: AwsConnection) => Promise<unknown>
      listEcsServices: (connection: AwsConnection, clusterArn: string) => Promise<unknown>
      describeEcsService: (connection: AwsConnection, clusterArn: string, serviceName: string) => Promise<unknown>
      listEcsTasks: (connection: AwsConnection, clusterArn: string, serviceName?: string) => Promise<unknown>
      updateEcsDesiredCount: (connection: AwsConnection, clusterArn: string, serviceName: string, desiredCount: number) => Promise<unknown>
      forceEcsRedeploy: (connection: AwsConnection, clusterArn: string, serviceName: string) => Promise<unknown>
      stopEcsTask: (connection: AwsConnection, clusterArn: string, taskArn: string, reason?: string) => Promise<unknown>
      deleteEcsService: (connection: AwsConnection, clusterArn: string, serviceName: string) => Promise<unknown>
      createEcsFargateService: (connection: AwsConnection, config: EcsFargateServiceConfig) => Promise<unknown>
      getEcsContainerLogs: (connection: AwsConnection, logGroup: string, logStream: string, startTime?: number) => Promise<unknown>
      listLambdaFunctions: (connection: AwsConnection) => Promise<unknown>
      getLambdaFunction: (connection: AwsConnection, functionName: string) => Promise<unknown>
      invokeLambdaFunction: (connection: AwsConnection, functionName: string, payload: string) => Promise<unknown>
      getLambdaFunctionCode: (connection: AwsConnection, functionName: string) => Promise<unknown>
      createLambdaFunction: (connection: AwsConnection, config: LambdaCreateConfig) => Promise<unknown>
      deleteLambdaFunction: (connection: AwsConnection, functionName: string) => Promise<unknown>
      listAutoScalingGroups: (connection: AwsConnection) => Promise<unknown>
      listAutoScalingInstances: (connection: AwsConnection, groupName: string) => Promise<unknown>
      updateAutoScalingCapacity: (connection: AwsConnection, groupName: string, minimum: number, desired: number, maximum: number) => Promise<unknown>
      startAutoScalingRefresh: (connection: AwsConnection, groupName: string) => Promise<unknown>
      deleteAutoScalingGroup: (connection: AwsConnection, groupName: string, forceDelete?: boolean) => Promise<unknown>
      listS3Buckets: (connection: AwsConnection) => Promise<unknown>
      listS3Governance: (connection: AwsConnection) => Promise<unknown>
      getS3GovernanceDetail: (connection: AwsConnection, bucketName: string) => Promise<unknown>
      listS3Objects: (connection: AwsConnection, bucketName: string, prefix: string) => Promise<unknown>
      createS3Bucket: (connection: AwsConnection, bucketName: string) => Promise<unknown>
      deleteS3Object: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      getS3PresignedUrl: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      createS3Folder: (connection: AwsConnection, bucketName: string, folderKey: string) => Promise<unknown>
      downloadS3Object: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      downloadS3ObjectTo: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      openS3Object: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      openS3InVSCode: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      getS3ObjectContent: (connection: AwsConnection, bucketName: string, key: string) => Promise<unknown>
      putS3ObjectContent: (connection: AwsConnection, bucketName: string, key: string, content: string, contentType?: string) => Promise<unknown>
      uploadS3Object: (connection: AwsConnection, bucketName: string, key: string, localPath: string) => Promise<unknown>
      enableS3BucketVersioning: (connection: AwsConnection, bucketName: string) => Promise<unknown>
      enableS3BucketEncryption: (connection: AwsConnection, bucketName: string) => Promise<unknown>
      putS3BucketPolicy: (connection: AwsConnection, bucketName: string, policyJson: string) => Promise<unknown>
      listRdsInstances: (connection: AwsConnection) => Promise<unknown>
      listRdsClusters: (connection: AwsConnection) => Promise<unknown>
      describeRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string) => Promise<unknown>
      describeRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) => Promise<unknown>
      startRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string) => Promise<unknown>
      stopRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string) => Promise<unknown>
      rebootRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string, forceFailover?: boolean) => Promise<unknown>
      resizeRdsInstance: (connection: AwsConnection, dbInstanceIdentifier: string, dbInstanceClass: string) => Promise<unknown>
      createRdsSnapshot: (connection: AwsConnection, dbInstanceIdentifier: string, dbSnapshotIdentifier: string) => Promise<unknown>
      startRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) => Promise<unknown>
      stopRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) => Promise<unknown>
      failoverRdsCluster: (connection: AwsConnection, dbClusterIdentifier: string) => Promise<unknown>
      createRdsClusterSnapshot: (connection: AwsConnection, dbClusterIdentifier: string, dbClusterSnapshotIdentifier: string) => Promise<unknown>
      listCloudFormationStacks: (connection: AwsConnection) => Promise<unknown>
      listCloudFormationStackResources: (connection: AwsConnection, stackName: string) => Promise<unknown>
      listCloudFormationChangeSets: (connection: AwsConnection, stackName: string) => Promise<unknown>
      createCloudFormationChangeSet: (connection: AwsConnection, input: unknown) => Promise<unknown>
      getCloudFormationChangeSetDetail: (connection: AwsConnection, stackName: string, changeSetName: string) => Promise<unknown>
      executeCloudFormationChangeSet: (connection: AwsConnection, stackName: string, changeSetName: string) => Promise<unknown>
      deleteCloudFormationChangeSet: (connection: AwsConnection, stackName: string, changeSetName: string) => Promise<unknown>
      getCloudFormationDriftSummary: (connection: AwsConnection, stackName: string) => Promise<unknown>
      startCloudFormationDriftDetection: (connection: AwsConnection, stackName: string) => Promise<unknown>
      getCloudFormationDriftDetectionStatus: (connection: AwsConnection, stackName: string, driftDetectionId: string) => Promise<unknown>
      listVpcs: (connection: AwsConnection) => Promise<unknown>
      listSubnets: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      listRouteTables: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      listInternetGateways: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      listNatGateways: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      listTransitGateways: (connection: AwsConnection) => Promise<unknown>
      listNetworkInterfaces: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      listSecurityGroupsForVpc: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      getVpcTopology: (connection: AwsConnection, vpcId: string) => Promise<unknown>
      getVpcFlowDiagram: (connection: AwsConnection, vpcId: string) => Promise<unknown>
      updateSubnetPublicIp: (connection: AwsConnection, subnetId: string, mapPublic: boolean) => Promise<unknown>
      createReachabilityPath: (connection: AwsConnection, sourceId: string, destId: string, protocol: string) => Promise<unknown>
      getReachabilityAnalysis: (connection: AwsConnection, analysisId: string) => Promise<unknown>
      deleteReachabilityPath: (connection: AwsConnection, pathId: string) => Promise<unknown>
      deleteReachabilityAnalysis: (connection: AwsConnection, analysisId: string) => Promise<unknown>
      listSecurityGroups: (connection: AwsConnection, vpcId?: string) => Promise<unknown>
      describeSecurityGroup: (connection: AwsConnection, groupId: string) => Promise<unknown>
      addInboundRule: (connection: AwsConnection, groupId: string, rule: unknown) => Promise<unknown>
      revokeInboundRule: (connection: AwsConnection, groupId: string, rule: unknown) => Promise<unknown>
      addOutboundRule: (connection: AwsConnection, groupId: string, rule: unknown) => Promise<unknown>
      revokeOutboundRule: (connection: AwsConnection, groupId: string, rule: unknown) => Promise<unknown>
      listEcrRepositories: (connection: AwsConnection) => Promise<unknown>
      listEcrImages: (connection: AwsConnection, repositoryName: string) => Promise<unknown>
      createEcrRepository: (connection: AwsConnection, repositoryName: string, imageTagMutability: string, scanOnPush: boolean) => Promise<unknown>
      deleteEcrRepository: (connection: AwsConnection, repositoryName: string, force: boolean) => Promise<unknown>
      deleteEcrImage: (connection: AwsConnection, repositoryName: string, imageDigest: string) => Promise<unknown>
      startEcrImageScan: (connection: AwsConnection, repositoryName: string, imageDigest: string, imageTag?: string) => Promise<unknown>
      getEcrScanFindings: (connection: AwsConnection, repositoryName: string, imageDigest: string) => Promise<unknown>
      getEcrAuthorizationToken: (connection: AwsConnection) => Promise<unknown>
      ecrDockerLogin: (connection: AwsConnection) => Promise<unknown>
      ecrDockerPull: (repositoryUri: string, tag: string) => Promise<unknown>
      ecrDockerPush: (localImage: string, repositoryUri: string, tag: string) => Promise<unknown>
      listSnsTopics: (connection: AwsConnection) => Promise<unknown>
      getSnsTopic: (connection: AwsConnection, topicArn: string) => Promise<unknown>
      createSnsTopic: (connection: AwsConnection, name: string, fifo: boolean, attrs?: Record<string, string>) => Promise<unknown>
      deleteSnsTopic: (connection: AwsConnection, topicArn: string) => Promise<unknown>
      setSnsTopicAttribute: (connection: AwsConnection, topicArn: string, attrName: string, attrValue: string) => Promise<unknown>
      listSnsSubscriptions: (connection: AwsConnection, topicArn: string) => Promise<unknown>
      snsSubscribe: (connection: AwsConnection, topicArn: string, protocol: string, endpoint: string) => Promise<unknown>
      snsUnsubscribe: (connection: AwsConnection, subscriptionArn: string) => Promise<unknown>
      snsPublish: (connection: AwsConnection, topicArn: string, message: string, subject?: string, groupId?: string, dedupId?: string) => Promise<unknown>
      tagSnsTopic: (connection: AwsConnection, topicArn: string, tags: Record<string, string>) => Promise<unknown>
      untagSnsTopic: (connection: AwsConnection, topicArn: string, tagKeys: string[]) => Promise<unknown>
      listSqsQueues: (connection: AwsConnection) => Promise<unknown>
      getSqsQueue: (connection: AwsConnection, queueUrl: string) => Promise<unknown>
      createSqsQueue: (connection: AwsConnection, name: string, fifo: boolean, attrs?: Record<string, string>) => Promise<unknown>
      deleteSqsQueue: (connection: AwsConnection, queueUrl: string) => Promise<unknown>
      purgeSqsQueue: (connection: AwsConnection, queueUrl: string) => Promise<unknown>
      setSqsAttributes: (connection: AwsConnection, queueUrl: string, attrs: Record<string, string>) => Promise<unknown>
      sqsSendMessage: (connection: AwsConnection, queueUrl: string, body: string, delay?: number, groupId?: string, dedupId?: string) => Promise<unknown>
      sqsReceiveMessages: (connection: AwsConnection, queueUrl: string, max: number, wait: number) => Promise<unknown>
      sqsDeleteMessage: (connection: AwsConnection, queueUrl: string, receiptHandle: string) => Promise<unknown>
      sqsChangeVisibility: (connection: AwsConnection, queueUrl: string, receiptHandle: string, timeout: number) => Promise<unknown>
      tagSqsQueue: (connection: AwsConnection, queueUrl: string, tags: Record<string, string>) => Promise<unknown>
      untagSqsQueue: (connection: AwsConnection, queueUrl: string, tagKeys: string[]) => Promise<unknown>
      sqsTimeline: (connection: AwsConnection, queueUrl: string) => Promise<unknown>
      listSsoInstances: (connection: AwsConnection) => Promise<unknown>
      createSsoInstance: (connection: AwsConnection, name: string) => Promise<unknown>
      deleteSsoInstance: (connection: AwsConnection, instanceArn: string) => Promise<unknown>
      listSsoPermissionSets: (connection: AwsConnection, instanceArn: string) => Promise<unknown>
      listSsoUsers: (connection: AwsConnection, identityStoreId: string) => Promise<unknown>
      listSsoGroups: (connection: AwsConnection, identityStoreId: string) => Promise<unknown>
      listSsoAccountAssignments: (connection: AwsConnection, instanceArn: string, accountId: string, permissionSetArn: string) => Promise<unknown>
      simulateSsoPermissions: (connection: AwsConnection, instanceArn: string, permissionSetArn: string) => Promise<unknown>
      listAcmCertificates: (connection: AwsConnection) => Promise<unknown>
      describeAcmCertificate: (connection: AwsConnection, certificateArn: string) => Promise<unknown>
      requestAcmCertificate: (connection: AwsConnection, input: unknown) => Promise<unknown>
      deleteAcmCertificate: (connection: AwsConnection, certificateArn: string) => Promise<unknown>
      listSecrets: (connection: AwsConnection) => Promise<unknown>
      describeSecret: (connection: AwsConnection, secretId: string) => Promise<unknown>
      getSecretValue: (connection: AwsConnection, secretId: string, versionId?: string) => Promise<unknown>
      createSecret: (connection: AwsConnection, input: unknown) => Promise<unknown>
      deleteSecret: (connection: AwsConnection, secretId: string, forceDeleteWithoutRecovery: boolean) => Promise<unknown>
      restoreSecret: (connection: AwsConnection, secretId: string) => Promise<unknown>
      updateSecretValue: (connection: AwsConnection, secretId: string, secretString: string) => Promise<unknown>
      updateSecretDescription: (connection: AwsConnection, secretId: string, description: string) => Promise<unknown>
      rotateSecret: (connection: AwsConnection, secretId: string) => Promise<unknown>
      putSecretResourcePolicy: (connection: AwsConnection, secretId: string, policy: string) => Promise<unknown>
      tagSecret: (connection: AwsConnection, secretId: string, tags: unknown) => Promise<unknown>
      untagSecret: (connection: AwsConnection, secretId: string, tagKeys: string[]) => Promise<unknown>
      listKeyPairs: (connection: AwsConnection) => Promise<unknown>
      createKeyPair: (connection: AwsConnection, keyName: string) => Promise<unknown>
      deleteKeyPair: (connection: AwsConnection, keyName: string) => Promise<unknown>
      decodeAuthorizationMessage: (connection: AwsConnection, encodedMessage: string) => Promise<unknown>
      lookupAccessKeyOwnership: (connection: AwsConnection, accessKeyId: string) => Promise<unknown>
      assumeRole: (connection: AwsConnection, roleArn: string, sessionName: string, externalId?: string) => Promise<unknown>
      listKmsKeys: (connection: AwsConnection) => Promise<unknown>
      describeKmsKey: (connection: AwsConnection, keyId: string) => Promise<unknown>
      decryptCiphertext: (connection: AwsConnection, ciphertext: string) => Promise<unknown>
      listWebAcls: (connection: AwsConnection, scope: string) => Promise<unknown>
      describeWebAcl: (connection: AwsConnection, scope: string, id: string, name: string) => Promise<unknown>
      createWebAcl: (connection: AwsConnection, input: unknown) => Promise<unknown>
      deleteWebAcl: (connection: AwsConnection, scope: string, id: string, name: string, lockToken: string) => Promise<unknown>
      addWafRule: (connection: AwsConnection, scope: string, id: string, name: string, lockToken: string, input: unknown) => Promise<unknown>
      updateWafRulesJson: (
        connection: AwsConnection,
        scope: string,
        id: string,
        name: string,
        lockToken: string,
        defaultAction: string,
        description: string,
        rulesJson: string
      ) => Promise<unknown>
      deleteWafRule: (connection: AwsConnection, scope: string, id: string, name: string, lockToken: string, ruleName: string) => Promise<unknown>
      associateWebAcl: (connection: AwsConnection, resourceArn: string, webAclArn: string) => Promise<unknown>
      disassociateWebAcl: (connection: AwsConnection, resourceArn: string) => Promise<unknown>
      openAwsTerminal: (connection: AwsConnection, initialCommand?: string) => Promise<unknown>
      updateAwsTerminalContext: (connection: AwsConnection) => Promise<unknown>
      sendTerminalInput: (input: string) => Promise<unknown>
      runTerminalCommand: (command: string) => Promise<unknown>
      resizeTerminal: (cols: number, rows: number) => Promise<unknown>
      closeTerminal: () => Promise<unknown>
      subscribeTerminal: (listener: (event: unknown) => void) => void
      unsubscribeTerminal: (listener: (event: unknown) => void) => void
      subscribeTempVolumeProgress: (listener: (event: EbsTempInspectionProgress) => void) => void
      unsubscribeTempVolumeProgress: (listener: (event: EbsTempInspectionProgress) => void) => void
      listIamUsers: (c: AwsConnection) => Promise<unknown>
      listIamGroups: (c: AwsConnection) => Promise<unknown>
      listIamRoles: (c: AwsConnection) => Promise<unknown>
      listIamPolicies: (c: AwsConnection, scope: string) => Promise<unknown>
      getIamAccountSummary: (c: AwsConnection) => Promise<unknown>
      listIamAccessKeys: (c: AwsConnection, u: string) => Promise<unknown>
      createIamAccessKey: (c: AwsConnection, u: string) => Promise<unknown>
      deleteIamAccessKey: (c: AwsConnection, u: string, k: string) => Promise<unknown>
      updateIamAccessKeyStatus: (c: AwsConnection, u: string, k: string, s: string) => Promise<unknown>
      listIamMfaDevices: (c: AwsConnection, u: string) => Promise<unknown>
      deleteIamMfaDevice: (c: AwsConnection, u: string, sn: string) => Promise<unknown>
      listAttachedIamUserPolicies: (c: AwsConnection, u: string) => Promise<unknown>
      listIamUserInlinePolicies: (c: AwsConnection, u: string) => Promise<unknown>
      attachIamUserPolicy: (c: AwsConnection, u: string, a: string) => Promise<unknown>
      detachIamUserPolicy: (c: AwsConnection, u: string, a: string) => Promise<unknown>
      putIamUserInlinePolicy: (c: AwsConnection, u: string, n: string, d: string) => Promise<unknown>
      deleteIamUserInlinePolicy: (c: AwsConnection, u: string, n: string) => Promise<unknown>
      listIamUserGroups: (c: AwsConnection, u: string) => Promise<unknown>
      addIamUserToGroup: (c: AwsConnection, u: string, g: string) => Promise<unknown>
      removeIamUserFromGroup: (c: AwsConnection, u: string, g: string) => Promise<unknown>
      createIamUser: (c: AwsConnection, u: string) => Promise<unknown>
      deleteIamUser: (c: AwsConnection, u: string) => Promise<unknown>
      createIamLoginProfile: (c: AwsConnection, u: string, pw: string, r: boolean) => Promise<unknown>
      deleteIamLoginProfile: (c: AwsConnection, u: string) => Promise<unknown>
      listAttachedIamRolePolicies: (c: AwsConnection, r: string) => Promise<unknown>
      listIamRoleInlinePolicies: (c: AwsConnection, r: string) => Promise<unknown>
      getIamRoleTrustPolicy: (c: AwsConnection, r: string) => Promise<unknown>
      updateIamRoleTrustPolicy: (c: AwsConnection, r: string, d: string) => Promise<unknown>
      attachIamRolePolicy: (c: AwsConnection, r: string, a: string) => Promise<unknown>
      detachIamRolePolicy: (c: AwsConnection, r: string, a: string) => Promise<unknown>
      putIamRoleInlinePolicy: (c: AwsConnection, r: string, n: string, d: string) => Promise<unknown>
      deleteIamRoleInlinePolicy: (c: AwsConnection, r: string, n: string) => Promise<unknown>
      createIamRole: (c: AwsConnection, r: string, tp: string, desc: string) => Promise<unknown>
      deleteIamRole: (c: AwsConnection, r: string) => Promise<unknown>
      listAttachedIamGroupPolicies: (c: AwsConnection, g: string) => Promise<unknown>
      attachIamGroupPolicy: (c: AwsConnection, g: string, a: string) => Promise<unknown>
      detachIamGroupPolicy: (c: AwsConnection, g: string, a: string) => Promise<unknown>
      createIamGroup: (c: AwsConnection, g: string) => Promise<unknown>
      deleteIamGroup: (c: AwsConnection, g: string) => Promise<unknown>
      getIamPolicyVersion: (c: AwsConnection, a: string, v: string) => Promise<unknown>
      listIamPolicyVersions: (c: AwsConnection, a: string) => Promise<unknown>
      createIamPolicyVersion: (c: AwsConnection, a: string, d: string, s: boolean) => Promise<unknown>
      deleteIamPolicyVersion: (c: AwsConnection, a: string, v: string) => Promise<unknown>
      createIamPolicy: (c: AwsConnection, n: string, d: string, desc: string) => Promise<unknown>
      deleteIamPolicy: (c: AwsConnection, a: string) => Promise<unknown>
      simulateIamPolicy: (c: AwsConnection, a: string, actions: string[], resources: string[]) => Promise<unknown>
      generateIamCredentialReport: (c: AwsConnection) => Promise<unknown>
      getIamCredentialReport: (c: AwsConnection) => Promise<unknown>
    }
    terraformWorkspace: {
      listProjects: (profileName: string) => Promise<unknown>
      getProject: (profileName: string, projectId: string) => Promise<unknown>
      getDrift: (profileName: string, projectId: string, connection: AwsConnection) => Promise<unknown>
      chooseProjectDirectory: () => Promise<unknown>
      addProject: (profileName: string, rootPath: string) => Promise<unknown>
      renameProject: (profileName: string, projectId: string, name: string) => Promise<unknown>
      removeProject: (profileName: string, projectId: string) => Promise<unknown>
      reloadProject: (profileName: string, projectId: string) => Promise<unknown>
      getSelectedProjectId: (profileName: string) => Promise<unknown>
      setSelectedProjectId: (profileName: string, projectId: string) => Promise<unknown>
      updateInputs: (profileName: string, projectId: string, inputs: Record<string, unknown>, varFile?: string) => Promise<unknown>
      listCommandLogs: (projectId: string) => Promise<unknown>
      runCommand: (request: TerraformCommandRequest) => Promise<unknown>
      subscribe: (listener: (event: unknown) => void) => void
      unsubscribe: (listener: (event: unknown) => void) => void
    }
  }
}

export {}
