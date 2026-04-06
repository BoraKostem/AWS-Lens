import fs from 'node:fs'
import path from 'node:path'

import type {
  AwsConnection,
  TerraformAdoptionCodeApplyResult,
  TerraformAdoptionImportExecutionResult,
  TerraformAdoptionTarget,
  TerraformCommandLog
} from '@shared/types'
import { generateTerraformAdoptionCode } from './terraformAdoptionCodegen'

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n')
}

function resourceHeader(code: string): string {
  return normalizeNewlines(code).split('\n').find((line) => line.startsWith('resource '))?.trim() ?? ''
}

export function applyTerraformAdoptionCode(
  profileName: string,
  projectId: string,
  connection: AwsConnection | undefined,
  target: TerraformAdoptionTarget
): TerraformAdoptionCodeApplyResult {
  const codegen = generateTerraformAdoptionCode(profileName, projectId, connection, target)
  const filePath = codegen.filePlan.suggestedFilePath
  const header = resourceHeader(codegen.resourceBlock)

  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
  if (header && normalizeNewlines(existing).includes(header)) {
    return {
      checkedAt: new Date().toISOString(),
      projectId: codegen.projectId,
      projectName: codegen.projectName,
      filePath,
      action: 'skipped',
      bytesWritten: 0,
      codegen
    }
  }

  const normalizedBlock = codegen.resourceBlock.trimEnd()
  let nextContents = normalizedBlock + '\n'
  let action: TerraformAdoptionCodeApplyResult['action'] = 'created'

  if (existing.trim()) {
    const trimmedExisting = existing.trimEnd()
    nextContents = `${trimmedExisting}\n\n${normalizedBlock}\n`
    action = 'appended'
  }

  fs.writeFileSync(filePath, nextContents, 'utf8')

  return {
    checkedAt: new Date().toISOString(),
    projectId: codegen.projectId,
    projectName: codegen.projectName,
    filePath,
    action,
    bytesWritten: Buffer.byteLength(nextContents, 'utf8') - Buffer.byteLength(existing, 'utf8'),
    codegen
  }
}

export function buildTerraformAdoptionImportExecutionResult(
  applyResult: TerraformAdoptionCodeApplyResult,
  log: TerraformCommandLog
): TerraformAdoptionImportExecutionResult {
  return {
    checkedAt: new Date().toISOString(),
    projectId: applyResult.projectId,
    projectName: applyResult.projectName,
    applyResult,
    log
  }
}
