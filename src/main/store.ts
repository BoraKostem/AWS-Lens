import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

type StoredProject = {
  id: string
  name: string
  rootPath: string
  varFile?: string
  variables?: Record<string, unknown>
}

type StoreData = {
  projects: StoredProject[]
  selectedProjectId: string
}

const DEFAULTS: StoreData = {
  projects: [],
  selectedProjectId: ''
}

function filePath(): string {
  return path.join(app.getPath('userData'), 'terraform-workspace-state.json')
}

function read(): StoreData {
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<StoreData>
    return {
      projects: Array.isArray(parsed.projects)
        ? parsed.projects.filter(
            (project): project is StoredProject =>
              !!project &&
              typeof project.id === 'string' &&
              typeof project.rootPath === 'string'
          ).map((p) => ({
            id: p.id,
            name: typeof p.name === 'string' && p.name ? p.name : path.basename(p.rootPath),
            rootPath: p.rootPath,
            varFile: typeof p.varFile === 'string' ? p.varFile : '',
            variables: (p.variables && typeof p.variables === 'object' && !Array.isArray(p.variables))
              ? p.variables as Record<string, unknown>
              : {}
          }))
        : [],
      selectedProjectId: typeof parsed.selectedProjectId === 'string' ? parsed.selectedProjectId : ''
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function write(data: StoreData): void {
  fs.writeFileSync(filePath(), JSON.stringify(data, null, 2), 'utf-8')
}

export function getProjects(): StoredProject[] {
  return read().projects
}

export function setProjects(projects: StoredProject[]): void {
  const data = read()
  data.projects = projects
  write(data)
}

export function getSelectedProjectId(): string {
  return read().selectedProjectId
}

export function setSelectedProjectId(projectId: string): void {
  const data = read()
  data.selectedProjectId = projectId
  write(data)
}
