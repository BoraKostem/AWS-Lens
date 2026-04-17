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
  resolvedAt: string
  resolveError: string
}

export type TerragruntStack = {
  stackRoot: string
  units: TerragruntUnit[]
  dependencyOrder: string[][]
  cycles: string[][]
}

export type TerragruntProjectInfo =
  | { kind: 'terragrunt-unit'; unit: TerragruntUnit }
  | { kind: 'terragrunt-stack'; stack: TerragruntStack }

export type TerraformProjectKind = 'terraform' | 'terragrunt-unit' | 'terragrunt-stack'
