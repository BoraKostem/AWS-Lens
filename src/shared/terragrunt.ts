export type TerragruntCliInfo = {
  found: boolean
  path: string
  version: string
  error: string
}

export type TerragruntIncludeRef = {
  name: string
  pathExpression: string
  resolvedPath: string
  expose: boolean
  mergeStrategy: string
}

export type TerragruntDependency = {
  name: string
  configPath: string
  resolvedPath: string
  skipOutputs: boolean
  hasMockOutputs: boolean
}

export type TerragruntGeneratedFile = {
  name: string
  targetPath: string
  ifExists: string
}

export type TerragruntRemoteState = {
  backend: string
  generatedTargetPath: string
  configSummary: Record<string, string>
}

export type TerragruntInputEntry = {
  name: string
  valueSummary: string
  valueType: 'string' | 'number' | 'boolean' | 'list' | 'object' | 'null' | 'unknown'
  isSensitive: boolean
}

export type TerragruntUnit = {
  unitPath: string
  relativePath: string
  configFile: string
  terraformSource: string
  includes: TerragruntIncludeRef[]
  dependencies: TerragruntDependency[]
  additionalDependencyPaths: string[]
  generatedFiles: TerragruntGeneratedFile[]
  remoteState: TerragruntRemoteState | null
  inputs: TerragruntInputEntry[]
  resolvedAt: string
  resolveError: string
}

export type TerragruntStack = {
  stackRoot: string
  units: TerragruntUnit[]
  dependencyOrder: string[][]
  cycles: string[][]
  /**
   * Root-level terragrunt.hcl at the stack root, when present. Not a runnable unit — it holds
   * shared inputs, locals, remote_state, and generate blocks that every child inherits.
   */
  rootConfig?: TerragruntUnit | null
}

export type TerragruntProjectInfo =
  | { kind: 'terragrunt-unit'; unit: TerragruntUnit }
  | { kind: 'terragrunt-stack'; stack: TerragruntStack }

export type TerraformProjectKind = 'terraform' | 'terragrunt-unit' | 'terragrunt-stack'

export type TerragruntDiscoveryClassification = 'stack' | 'unit' | 'none'

export type TerragruntDiscoveryResult = {
  rootPath: string
  classification: TerragruntDiscoveryClassification
  stackRoot: string
  units: TerragruntUnit[]
  rootConfig?: TerragruntUnit | null
  errors: string[]
}

export type TerragruntRunAllCommand = 'plan' | 'apply' | 'destroy'

export type TerragruntRunAllSummary = {
  succeeded: string[]
  failed: string[]
  blocked: string[]
  cancelled: string[]
}

export type TerragruntRunAllEvent =
  | { type: 'stack-started'; runId: string; stackRoot: string; command: TerragruntRunAllCommand; phases: string[][] }
  | { type: 'unit-started'; runId: string; unitPath: string; phase: number; unitRunId: string }
  | { type: 'unit-output'; runId: string; unitPath: string; chunk: string }
  | { type: 'unit-completed'; runId: string; unitPath: string; exitCode: number; success: boolean }
  | { type: 'unit-blocked'; runId: string; unitPath: string; blockedBy: string[] }
  | { type: 'unit-cancelled'; runId: string; unitPath: string }
  | { type: 'stack-completed'; runId: string; summary: TerragruntRunAllSummary }
