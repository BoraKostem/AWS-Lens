/**
 * Web mode implementation of window.awsLens.
 * Replaces Electron's contextBridge/ipcRenderer with fetch calls to /api/rpc.
 * Injected into window.awsLens at startup when running in browser (not Electron).
 */

async function rpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const res = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, args })
  })

  if (!res.ok) {
    throw new Error(`RPC ${channel} failed: HTTP ${res.status}`)
  }

  return res.json()
}

// Terminal event listeners — bridged via WebSocket in web mode
type TerminalListener = (event: unknown) => void
const terminalListeners = new Map<TerminalListener, TerminalListener>()
let terminalWs: WebSocket | null = null

function getTerminalWs(): WebSocket {
  if (terminalWs && terminalWs.readyState === WebSocket.OPEN) {
    return terminalWs
  }
  const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/terminal`
  terminalWs = new WebSocket(wsUrl)
  return terminalWs
}

export const webBridge: Window['awsLens'] = {
  // ── Profiles ──────────────────────────────────────────────────────────────
  listProfiles: () => rpc('profiles:list'),
  deleteProfile: (profileName) => rpc('profiles:delete', profileName),
  chooseAndImportConfig: () => rpc('profiles:choose-and-import'),
  saveCredentials: (profileName, accessKeyId, secretAccessKey) =>
    rpc('profiles:save-credentials', profileName, accessKeyId, secretAccessKey),

  // ── Regions / sessions ────────────────────────────────────────────────────
  listRegions: () => rpc('regions:list'),
  getSessionHubState: () => rpc('session-hub:list'),
  saveAssumeRoleTarget: (target) => rpc('session-hub:target:save', target),
  deleteAssumeRoleTarget: (targetId) => rpc('session-hub:target:delete', targetId),
  deleteAssumedSession: (sessionId) => rpc('session-hub:session:delete', sessionId),
  assumeRoleSession: (request) => rpc('session-hub:assume', request),
  assumeSavedRoleTarget: (targetId) => rpc('session-hub:assume-saved', targetId),

  // ── Services + release ────────────────────────────────────────────────────
  listServices: () => rpc('services:list'),
  getReleaseInfo: () => rpc('release:info'),

  // ── STS / identity ────────────────────────────────────────────────────────
  getCallerIdentity: (connection) => rpc('sts:get-caller-identity', connection),

  // ── EC2 ───────────────────────────────────────────────────────────────────
  listEc2Instances: (connection) => rpc('ec2:list-instances', connection),
  listEbsVolumes: (connection) => rpc('ec2:list-ebs-volumes', connection),
  describeEc2Instance: (connection, instanceId) => rpc('ec2:describe-instance', connection, instanceId),
  describeEbsVolume: (connection, volumeId) => rpc('ec2:describe-ebs-volume', connection, volumeId),
  runEc2InstanceAction: (connection, instanceId, action) => rpc('ec2:instance-action', connection, instanceId, action),
  listSubnets: (connection) => rpc('ec2:list-subnets', connection),
  listVpcs: (connection) => rpc('ec2:list-vpcs', connection),
  getReachabilityPath: (connection, sourceId, destId) => rpc('ec2:reachability-path', connection, sourceId, destId),
  describeVpc: (connection, vpcId) => rpc('ec2:describe-vpc', connection, vpcId),
  createEc2Snapshot: (connection, instanceId) => rpc('ec2:create-snapshot', connection, instanceId),
  launchInstanceFromSnapshot: (connection, config) => rpc('ec2:launch-from-snapshot', connection, config),
  terminateInstance: (connection, instanceId) => rpc('ec2:terminate', connection, instanceId),
  listKeyPairs: (connection) => rpc('ec2:list-key-pairs', connection),
  createKeyPair: (connection, keyName) => rpc('ec2:create-key-pair', connection, keyName),
  deleteKeyPair: (connection, keyName) => rpc('ec2:delete-key-pair', connection, keyName),
  listSecurityGroups: (connection) => rpc('ec2:list-security-groups', connection),
  describeSecurityGroup: (connection, sgId) => rpc('ec2:describe-security-group', connection, sgId),
  launchBastionInstance: (connection, config) => rpc('ec2:launch-bastion', connection, config),
  chooseEc2SshKey: () => rpc('ec2:ssh:choose-key'),

  // ── ECR ───────────────────────────────────────────────────────────────────
  listEcrRepositories: (connection) => rpc('ecr:list-repositories', connection),
  describeEcrRepository: (connection, repoName) => rpc('ecr:describe-repository', connection, repoName),
  listEcrImages: (connection, repoName) => rpc('ecr:list-images', connection, repoName),
  getEcrScanResult: (connection, repoName, imageTag) => rpc('ecr:scan-result', connection, repoName, imageTag),
  getEcrAuthorizationData: (connection) => rpc('ecr:get-auth-data', connection),
  deleteEcrImage: (connection, repoName, imageTag) => rpc('ecr:delete-image', connection, repoName, imageTag),

  // ── EKS ───────────────────────────────────────────────────────────────────
  listEksClusters: (connection) => rpc('eks:list-clusters', connection),
  describeEksCluster: (connection, clusterName) => rpc('eks:describe-cluster', connection, clusterName),
  listEksNodegroups: (connection, clusterName) => rpc('eks:list-nodegroups', connection, clusterName),
  updateEksNodegroupScaling: (connection, clusterName, nodegroupName, min, desired, max) =>
    rpc('eks:update-nodegroup-scaling', connection, clusterName, nodegroupName, min, desired, max),
  listEksUpdates: (connection, clusterName) => rpc('eks:list-updates', connection, clusterName),
  deleteEksCluster: (connection, clusterName) => rpc('eks:delete-cluster', connection, clusterName),
  addEksToKubeconfig: (connection, clusterName, contextName, kubeconfigPath) =>
    rpc('eks:add-kubeconfig', connection, clusterName, contextName, kubeconfigPath),
  launchEksKubectl: (connection, clusterName) => rpc('eks:launch-kubectl', connection, clusterName),
  prepareEksKubectlSession: (connection, clusterName) => rpc('eks:prepare-kubectl-session', connection, clusterName),
  runEksCommand: (connection, clusterName, kubeconfigPath, command) =>
    rpc('eks:run-command', connection, clusterName, kubeconfigPath, command),
  getEksObservabilityReport: (connection, clusterName) => rpc('eks:get-observability-report', connection, clusterName),

  // ── Overview ──────────────────────────────────────────────────────────────
  getOverviewMetrics: (connection) => rpc('overview:get-metrics', connection),
  getOverviewStatistics: (connection) => rpc('overview:get-statistics', connection),
  getCostBreakdown: (connection) => rpc('overview:get-cost-breakdown', connection),

  // ── Security ──────────────────────────────────────────────────────────────
  getSecurityGroupSummaries: (connection) => rpc('security:list-sgs', connection),
  getAccessKeyOwnership: (connection) => rpc('security:access-key-ownership', connection),

  // ── VPC ───────────────────────────────────────────────────────────────────
  listVpcSummaries: (connection) => rpc('vpc:list', connection),

  // ── Compare ───────────────────────────────────────────────────────────────
  runComparison: (request) => rpc('compare:run', request),

  // ── Compliance ────────────────────────────────────────────────────────────
  getComplianceReport: (connection) => rpc('compliance:get-report', connection),

  // ── Terraform ─────────────────────────────────────────────────────────────
  detectTerraformCli: () => rpc('terraform:cli:detect'),
  getTerraformCliInfo: () => rpc('terraform:cli:info'),
  listTerraformProjects: (profileName, connection) => rpc('terraform:projects:list', profileName, connection),
  getTerraformProject: (profileName, projectId, connection) => rpc('terraform:projects:get', profileName, projectId, connection),
  getSelectedTerraformProject: (profileName) => rpc('terraform:projects:selected:get', profileName),
  setSelectedTerraformProject: (profileName, projectId) => rpc('terraform:projects:selected:set', profileName, projectId),
  chooseTerraformDirectory: () => rpc('terraform:projects:choose-directory'),
  chooseTerraformFile: () => rpc('terraform:projects:choose-file'),

  // ── Terminal (WebSocket) ───────────────────────────────────────────────────
  openTerminal: (connection, initialCommand?) => {
    const ws = getTerminalWs()
    const send = () => {
      ws.send(JSON.stringify({ type: 'open', cols: 120, rows: 24 }))
      if (initialCommand) {
        setTimeout(() => ws.send(JSON.stringify({ type: 'input', data: `${initialCommand}\r` })), 200)
      }
    }
    if (ws.readyState === WebSocket.OPEN) {
      send()
    } else {
      ws.addEventListener('open', send, { once: true })
    }
    return Promise.resolve()
  },
  updateTerminalContext: (_connection) => Promise.resolve(),
  sendTerminalInput: (input) => {
    getTerminalWs().send(JSON.stringify({ type: 'input', data: input }))
    return Promise.resolve()
  },
  runTerminalCommand: (command) => {
    getTerminalWs().send(JSON.stringify({ type: 'input', data: `${command}\r` }))
    return Promise.resolve()
  },
  resizeTerminal: (cols, rows) => {
    getTerminalWs().send(JSON.stringify({ type: 'resize', cols, rows }))
    return Promise.resolve()
  },
  closeTerminal: () => {
    getTerminalWs().send(JSON.stringify({ type: 'close' }))
    terminalWs = null
    return Promise.resolve()
  },
  onTerminalEvent: (listener) => {
    const ws = getTerminalWs()
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string)
        listener(msg)
      } catch {/* ignore */}
    }
    terminalListeners.set(listener, handler as TerminalListener)
    ws.addEventListener('message', handler)
  },
  offTerminalEvent: (listener) => {
    const handler = terminalListeners.get(listener)
    if (handler) {
      getTerminalWs().removeEventListener('message', handler as EventListenerOrEventListenerObject)
      terminalListeners.delete(listener)
    }
  },

  // ── Misc / stubs for desktop-only features ─────────────────────────────────
  openExternalUrl: (url) => { window.open(url, '_blank'); return Promise.resolve() },
  showItemInFolder: (_path) => Promise.resolve(),
  chooseDirectory: () => Promise.resolve({ canceled: true, path: undefined }),

  // Pass-through remaining methods as needed (populated from preload shape)
  // Unimplemented desktop features return a graceful no-op
} as Window['awsLens']
