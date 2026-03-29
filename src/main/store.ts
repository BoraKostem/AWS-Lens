import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'
import type {
  TerraformInputConfiguration,
  TerraformProjectEnvironmentMetadata,
  TerraformSecretReference,
  TerraformVariableLayer,
  TerraformVariableSet
} from '@shared/types'

type StoredProject = {
  id: string
  name: string
  rootPath: string
  varFile?: string
  variables?: Record<string, unknown>
  inputConfig?: TerraformInputConfiguration
  environment?: TerraformProjectEnvironmentMetadata
}

type ProfileData = {
  projects: StoredProject[]
  selectedProjectId: string
}

type StoreData = {
  profiles: Record<string, ProfileData>
}

const PROFILE_DEFAULTS: ProfileData = {
  projects: [],
  selectedProjectId: ''
}

function filePath(): string {
  return path.join(app.getPath('userData'), 'terraform-workspace-state.json')
}

function sanitizeProjects(projects: unknown[]): StoredProject[] {
  return projects
    .filter(
      (project): project is StoredProject =>
        !!project &&
        typeof (project as Record<string, unknown>).id === 'string' &&
        typeof (project as Record<string, unknown>).rootPath === 'string'
    )
    .map((p) => ({
      id: p.id,
      name: typeof p.name === 'string' && p.name ? p.name : path.basename(p.rootPath),
      rootPath: p.rootPath,
      varFile: typeof p.varFile === 'string' ? p.varFile : '',
      variables:
        p.variables && typeof p.variables === 'object' && !Array.isArray(p.variables)
          ? (p.variables as Record<string, unknown>)
          : {},
      inputConfig:
        p.inputConfig && typeof p.inputConfig === 'object' && !Array.isArray(p.inputConfig)
          ? sanitizeInputConfig(p.inputConfig as Record<string, unknown>)
          : undefined,
      environment:
        p.environment && typeof p.environment === 'object' && !Array.isArray(p.environment)
          ? sanitizeEnvironment(p.environment as Record<string, unknown>)
          : undefined
    }))
}

function sanitizeSecretReference(raw: Record<string, unknown>): TerraformSecretReference {
  return {
    source: raw.source === 'ssm-parameter' ? 'ssm-parameter' : 'secrets-manager',
    target: typeof raw.target === 'string' ? raw.target : '',
    versionId: typeof raw.versionId === 'string' ? raw.versionId : '',
    jsonKey: typeof raw.jsonKey === 'string' ? raw.jsonKey : '',
    label: typeof raw.label === 'string' ? raw.label : ''
  }
}

function sanitizeVariableLayer(raw: Record<string, unknown>): TerraformVariableLayer {
  const variables =
    raw.variables && typeof raw.variables === 'object' && !Array.isArray(raw.variables)
      ? raw.variables as Record<string, unknown>
      : {}
  const secretRefsRaw =
    raw.secretRefs && typeof raw.secretRefs === 'object' && !Array.isArray(raw.secretRefs)
      ? raw.secretRefs as Record<string, unknown>
      : {}
  const secretRefs = Object.fromEntries(
    Object.entries(secretRefsRaw)
      .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
      .map(([key, value]) => [key, sanitizeSecretReference(value as Record<string, unknown>)])
  )

  return {
    varFile: typeof raw.varFile === 'string' ? raw.varFile : '',
    variables,
    secretRefs
  }
}

function sanitizeVariableSet(raw: Record<string, unknown>): TerraformVariableSet {
  const overlaysRaw =
    raw.overlays && typeof raw.overlays === 'object' && !Array.isArray(raw.overlays)
      ? raw.overlays as Record<string, unknown>
      : {}
  const overlays = Object.fromEntries(
    Object.entries(overlaysRaw)
      .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
      .map(([key, value]) => [key, sanitizeVariableLayer(value as Record<string, unknown>)])
  )

  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : 'Default',
    description: typeof raw.description === 'string' ? raw.description : '',
    base: sanitizeVariableLayer(raw.base && typeof raw.base === 'object' && !Array.isArray(raw.base) ? raw.base as Record<string, unknown> : {}),
    overlays,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
  }
}

function sanitizeInputConfig(raw: Record<string, unknown>): TerraformInputConfiguration {
  const setsRaw = Array.isArray(raw.variableSets) ? raw.variableSets : []
  const variableSets = setsRaw
    .filter((set): set is Record<string, unknown> => !!set && typeof set === 'object' && !Array.isArray(set))
    .map((set) => sanitizeVariableSet(set))
    .filter((set) => Boolean(set.id))

  return {
    selectedVariableSetId: typeof raw.selectedVariableSetId === 'string' ? raw.selectedVariableSetId : '',
    selectedOverlay: typeof raw.selectedOverlay === 'string' ? raw.selectedOverlay : '',
    variableSets,
    migratedFromLegacy: raw.migratedFromLegacy !== false
  }
}

function sanitizeEnvironment(raw: Record<string, unknown>): TerraformProjectEnvironmentMetadata {
  return {
    environmentLabel: typeof raw.environmentLabel === 'string' ? raw.environmentLabel : '',
    workspaceName: typeof raw.workspaceName === 'string' ? raw.workspaceName : 'default',
    region: typeof raw.region === 'string' ? raw.region : '',
    connectionLabel: typeof raw.connectionLabel === 'string' ? raw.connectionLabel : '',
    backendType: typeof raw.backendType === 'string' ? raw.backendType : 'local',
    varSetLabel: typeof raw.varSetLabel === 'string' ? raw.varSetLabel : ''
  }
}

function read(): StoreData {
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>

    // Migrate old flat format → profile-scoped format
    if (Array.isArray(parsed.projects) && !parsed.profiles) {
      const migrated: StoreData = {
        profiles: {
          default: {
            projects: sanitizeProjects(parsed.projects),
            selectedProjectId:
              typeof parsed.selectedProjectId === 'string' ? parsed.selectedProjectId : ''
          }
        }
      }
      write(migrated)
      return migrated
    }

    // New profile-scoped format
    const profiles: Record<string, ProfileData> = {}
    if (parsed.profiles && typeof parsed.profiles === 'object' && !Array.isArray(parsed.profiles)) {
      for (const [name, value] of Object.entries(parsed.profiles as Record<string, unknown>)) {
        const entry = value as Record<string, unknown>
        profiles[name] = {
          projects: Array.isArray(entry.projects) ? sanitizeProjects(entry.projects) : [],
          selectedProjectId:
            typeof entry.selectedProjectId === 'string' ? entry.selectedProjectId : ''
        }
      }
    }
    return { profiles }
  } catch {
    return { profiles: {} }
  }
}

function write(data: StoreData): void {
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf-8')
}

function getProfileData(profileName: string): ProfileData {
  return read().profiles[profileName] ?? { ...PROFILE_DEFAULTS }
}

export function getProjects(profileName: string): StoredProject[] {
  return getProfileData(profileName).projects
}

export function setProjects(profileName: string, projects: StoredProject[]): void {
  const data = read()
  if (!data.profiles[profileName]) {
    data.profiles[profileName] = { ...PROFILE_DEFAULTS }
  }
  data.profiles[profileName].projects = projects
  write(data)
}

export function getSelectedProjectId(profileName: string): string {
  return getProfileData(profileName).selectedProjectId
}

export function setSelectedProjectId(profileName: string, projectId: string): void {
  const data = read()
  if (!data.profiles[profileName]) {
    data.profiles[profileName] = { ...PROFILE_DEFAULTS }
  }
  data.profiles[profileName].selectedProjectId = projectId
  write(data)
}
