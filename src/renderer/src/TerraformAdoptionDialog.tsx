import { useEffect, useMemo, useState } from 'react'

import type {
  AwsConnection,
  TerraformAdoptionCodegenResult,
  TerraformAdoptionDetectionResult,
  TerraformAdoptionImportExecutionResult,
  TerraformAdoptionMappingResult,
  TerraformAdoptionTarget,
  TerraformAdoptionValidationResult,
  TerraformProjectListItem
} from '@shared/types'
import {
  detectAdoption,
  executeAdoptionImport,
  generateAdoptionCode,
  listProjects,
  mapAdoption,
  openProjectInVsCode,
  validateAdoptionImport
} from './terraformApi'
import './terraform-adoption-dialog.css'

type ManualPreview = {
  address: string
  importId: string
  importCommand: string
  planCommand: string
  resourceBlock: string
  suggestedFileName: string
  rollbackCommand: string
  notes: string[]
}

function terraformContextKey(connection: AwsConnection): string {
  return connection.kind === 'profile'
    ? `profile:${connection.profile}`
    : `assumed-role:${connection.sessionId}`
}

function normalizeEnvironmentTag(tags?: Record<string, string>): string {
  if (!tags) return ''
  return tags.Environment?.trim()
    || tags.environment?.trim()
    || tags.env?.trim()
    || ''
}

function slugify(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return normalized || 'adopted'
}

function renderTags(tags?: Record<string, string>, indent = '  '): string[] {
  const entries = Object.entries(tags ?? {}).filter(([, value]) => value.trim())
  if (entries.length === 0) return []
  return [
    `${indent}tags = {`,
    ...entries.map(([key, value]) => `${indent}  "${key}" = "${value}"`),
    `${indent}}`
  ]
}

function withWorkspace(workspace: string, command: string): string {
  if (!workspace || workspace === 'default') {
    return command
  }
  return `terraform workspace select ${workspace}\n${command}`
}

function baseResourceBlock(type: TerraformAdoptionTarget['resourceType'], name: string): string[] {
  switch (type) {
    case 'aws_db_instance':
      return [`resource "${type}" "${name}" {`, `  identifier = "${name}"`, '}']
    case 'aws_rds_cluster':
      return [`resource "${type}" "${name}" {`, `  cluster_identifier = "${name}"`, '}']
    case 'aws_s3_bucket':
      return [`resource "${type}" "${name}" {`, `  bucket = "${name}"`, '}']
    case 'aws_iam_user':
    case 'aws_iam_group':
    case 'aws_iam_role':
      return [`resource "${type}" "${name}" {`, `  name = "${name}"`, '}']
    case 'aws_iam_policy':
      return [
        `resource "${type}" "${name}" {`,
        `  name   = "${name}"`,
        '  policy = jsonencode({',
        '    Version = "2012-10-17"',
        '    Statement = []',
        '  })',
        '}'
      ]
    case 'aws_security_group':
      return [
        `resource "${type}" "${name}" {`,
        `  name        = "${name}"`,
        '  description = "Imported security group"',
        '  vpc_id      = ""',
        '}'
      ]
    case 'aws_eks_cluster':
      return [
        `resource "${type}" "${name}" {`,
        `  name     = "${name}"`,
        '  role_arn = ""',
        '  vpc_config {',
        '    subnet_ids = []',
        '  }',
        '}'
      ]
    case 'aws_ecs_service':
      return [
        `resource "${type}" "${name}" {`,
        `  name            = "${name}"`,
        '  cluster         = ""',
        '  task_definition = ""',
        '  desired_count   = 1',
        '}'
      ]
    case 'aws_lambda_function':
      return [
        `resource "${type}" "${name}" {`,
        `  function_name = "${name}"`,
        '  role          = ""',
        '  handler       = ""',
        '  runtime       = ""',
        '  filename      = ""',
        '}'
      ]
    case 'aws_route53_zone':
      return [`resource "${type}" "${name}" {`, `  name = "${name}"`, '}']
    case 'aws_secretsmanager_secret':
      return [`resource "${type}" "${name}" {`, `  name = "${name}"`, '}']
    case 'aws_kms_key':
      return [`resource "${type}" "${name}" {`, '  description = "Imported KMS key"', '}']
    case 'aws_sqs_queue':
    case 'aws_sns_topic':
      return [`resource "${type}" "${name}" {`, `  name = "${name}"`, '}']
    default:
      return [`resource "${type}" "${name}" {`, '  # add required arguments before planning', '}']
  }
}

function buildManualPreview(target: TerraformAdoptionTarget, project: TerraformProjectListItem): ManualPreview {
  const suggestedName = slugify(target.name || target.displayName || target.identifier)
  const address = `${target.resourceType}.${suggestedName}`
  const importId = target.identifier || target.arn || target.name || target.displayName
  const base = baseResourceBlock(target.resourceType, suggestedName)
  const tagLines = renderTags(target.tags)
  const resourceBlock = [
    ...base.slice(0, -1),
    ...(tagLines.length > 0 ? tagLines : []),
    base[base.length - 1]
  ].join('\n')
  const importCommand = withWorkspace(project.currentWorkspace || 'default', `terraform import ${address} ${importId}`)
  const planCommand = withWorkspace(project.currentWorkspace || 'default', `terraform plan -target ${address}`)
  const suggestedFileName = `${target.serviceId.replace(/[^a-z0-9-]+/gi, '-')}-adoption.tf`
  const rollbackCommand = `terraform state rm ${address}`
  const notes = [
    'Cross-service rollout currently uses manual adoption mode outside the EC2 guided importer.',
    'Confirm required arguments in the generated HCL before running plan or apply.',
    'After import, run a targeted plan and compare the imported address against the live AWS resource.'
  ]

  return {
    address,
    importId,
    importCommand,
    planCommand,
    resourceBlock,
    suggestedFileName,
    rollbackCommand,
    notes
  }
}

function compatibilityLabel(project: TerraformProjectListItem, target: TerraformAdoptionTarget): { region: string; workspace: string } {
  const region = project.environment.region === target.region ? 'Region match' : `Region review: ${project.environment.region || '-'}`
  const envTag = normalizeEnvironmentTag(target.tags)
  const workspace = envTag
    ? ((project.currentWorkspace || 'default').toLowerCase() === envTag.toLowerCase()
      ? 'Workspace match'
      : `Workspace review: ${project.currentWorkspace || 'default'}`)
    : `Workspace ${project.currentWorkspace || 'default'}`
  return { region, workspace }
}

export function TerraformAdoptionDialog({
  open,
  onClose,
  connection,
  target
}: {
  open: boolean
  onClose: () => void
  connection: AwsConnection
  target: TerraformAdoptionTarget | null
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [detection, setDetection] = useState<TerraformAdoptionDetectionResult | null>(null)
  const [projects, setProjects] = useState<TerraformProjectListItem[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [actionMessage, setActionMessage] = useState('')
  const [actionError, setActionError] = useState('')
  const [mapping, setMapping] = useState<TerraformAdoptionMappingResult | null>(null)
  const [mappingLoading, setMappingLoading] = useState(false)
  const [mappingError, setMappingError] = useState('')
  const [codegen, setCodegen] = useState<TerraformAdoptionCodegenResult | null>(null)
  const [codegenLoading, setCodegenLoading] = useState(false)
  const [codegenError, setCodegenError] = useState('')
  const [importRunning, setImportRunning] = useState(false)
  const [importError, setImportError] = useState('')
  const [importResult, setImportResult] = useState<TerraformAdoptionImportExecutionResult | null>(null)
  const [validationLoading, setValidationLoading] = useState(false)
  const [validationError, setValidationError] = useState('')
  const [validation, setValidation] = useState<TerraformAdoptionValidationResult | null>(null)

  useEffect(() => {
    if (!open || !target) {
      return
    }

    let cancelled = false
    setLoading(true)
    setError('')
    setActionMessage('')
    setActionError('')
    setMapping(null)
    setMappingError('')
    setCodegen(null)
    setCodegenError('')
    setImportResult(null)
    setImportError('')
    setValidation(null)
    setValidationError('')

    void Promise.all([
      detectAdoption(terraformContextKey(connection), connection, target),
      listProjects(terraformContextKey(connection), connection)
    ])
      .then(([nextDetection, nextProjects]) => {
        if (cancelled) return
        setDetection(nextDetection)
        const ranked = [...nextProjects].sort((left, right) => {
          const leftRegion = left.environment.region === connection.region ? 1 : 0
          const rightRegion = right.environment.region === connection.region ? 1 : 0
          return rightRegion - leftRegion || left.name.localeCompare(right.name)
        })
        setProjects(ranked)
        setSelectedProjectId((current) => ranked.some((entry) => entry.id === current) ? current : (ranked[0]?.id ?? ''))
      })
      .catch((nextError) => {
        if (cancelled) return
        setDetection(null)
        setProjects([])
        setSelectedProjectId('')
        setError(nextError instanceof Error ? nextError.message : 'Terraform adoption context failed to load.')
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, target?.identifier, target?.resourceType, target?.name, target?.arn, connection.region, connection.sessionId])

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  )
  const preview = useMemo(
    () => (target && selectedProject ? buildManualPreview(target, selectedProject) : null),
    [selectedProject, target]
  )
  const guidedSupported = target?.resourceType === 'aws_instance'
  const managed = Boolean(detection && detection.managedProjectCount > 0)

  useEffect(() => {
    if (!open || !target || !selectedProject || managed || !guidedSupported) {
      setMapping(null)
      setMappingError('')
      setMappingLoading(false)
      return
    }

    let cancelled = false
    setMappingLoading(true)
    setMappingError('')
    setImportResult(null)
    setImportError('')
    setValidation(null)
    setValidationError('')

    void mapAdoption(terraformContextKey(connection), selectedProject.id, connection, target)
      .then((result) => {
        if (!cancelled) {
          setMapping(result)
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setMapping(null)
          setMappingError(nextError instanceof Error ? nextError.message : 'Terraform resource mapping failed.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setMappingLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, target, selectedProject, managed, guidedSupported, connection])

  useEffect(() => {
    if (!open || !target || !selectedProject || !mapping || managed || !guidedSupported) {
      setCodegen(null)
      setCodegenError('')
      setCodegenLoading(false)
      return
    }

    let cancelled = false
    setCodegenLoading(true)
    setCodegenError('')

    void generateAdoptionCode(terraformContextKey(connection), selectedProject.id, connection, target)
      .then((result) => {
        if (!cancelled) {
          setCodegen(result)
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setCodegen(null)
          setCodegenError(nextError instanceof Error ? nextError.message : 'Terraform code generation preview failed.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setCodegenLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, target, selectedProject, mapping, managed, guidedSupported, connection])

  if (!open || !target) {
    return null
  }

  async function handleOpenProject(): Promise<void> {
    if (!selectedProject) return
    setActionError('')
    try {
      await openProjectInVsCode(selectedProject.rootPath)
      setActionMessage(`Opened ${selectedProject.name} in VS Code.`)
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : 'Failed to open Terraform project.')
    }
  }

  async function copyText(label: string, value: string): Promise<void> {
    setActionError('')
    try {
      await navigator.clipboard.writeText(value)
      setActionMessage(`${label} copied.`)
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : `Failed to copy ${label.toLowerCase()}.`)
    }
  }
  const projectCompatibility = selectedProject ? compatibilityLabel(selectedProject, target) : null

  async function runValidation(): Promise<void> {
    if (!selectedProject || !target || validationLoading) return
    setValidationLoading(true)
    setValidationError('')
    setValidation(null)

    try {
      const result = await validateAdoptionImport(terraformContextKey(connection), selectedProject.id, connection, target)
      setValidation(result)
    } catch (nextError) {
      setValidationError(nextError instanceof Error ? nextError.message : 'Post-import validation failed.')
    } finally {
      setValidationLoading(false)
    }
  }

  async function handleExecuteImport(): Promise<void> {
    if (!selectedProject || !target || !codegen || importRunning) return
    setImportRunning(true)
    setImportError('')
    setImportResult(null)
    setValidation(null)
    setValidationError('')

    try {
      const result = await executeAdoptionImport(terraformContextKey(connection), selectedProject.id, connection, target)
      setImportResult(result)
      if (!result.log.success) {
        const tail = result.log.output.split('\n').map((line) => line.trim()).filter(Boolean).slice(-1)[0] || 'see command output for details'
        setImportError(`Terraform import failed: ${tail}`)
        return
      }
      setActionMessage(`Terraform import completed for ${target.identifier}.`)
      await runValidation()
      const refreshedDetection = await detectAdoption(terraformContextKey(connection), connection, target)
      setDetection(refreshedDetection)
    } catch (nextError) {
      setImportError(nextError instanceof Error ? nextError.message : 'Terraform import execution failed.')
    } finally {
      setImportRunning(false)
    }
  }

  return (
    <div className="tf-adoption-overlay" onClick={onClose}>
      <div className="tf-adoption-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="tf-adoption-head">
          <div>
            <span className="tf-adoption-kicker">Terraform Adoption</span>
            <h3>Manage {target.displayName} in Terraform</h3>
            <p>
              Review tracked project matches, choose a target project, and continue with the adoption workflow for this resource type.
            </p>
          </div>
          <button type="button" className="svc-btn muted" onClick={onClose}>Close</button>
        </div>

        {loading && <div className="tf-adoption-banner">Loading Terraform adoption context...</div>}
        {error && <div className="tf-adoption-banner error">{error}</div>}
        {actionMessage && <div className="tf-adoption-banner success">{actionMessage}</div>}
        {actionError && <div className="tf-adoption-banner error">{actionError}</div>}

        <div className="tf-adoption-grid">
          <section className="tf-adoption-card">
            <div className="tf-adoption-card-head">
              <h4>Detection</h4>
              <span className={`tf-adoption-pill ${managed ? 'managed' : detection?.configHintProjectCount ? 'config' : 'manual'}`}>
                {managed ? 'Managed' : detection?.configHintProjectCount ? 'Config hints' : 'Manual mode'}
              </span>
            </div>
            <div className="tf-adoption-meta">
              <span>Type</span>
              <strong>{target.resourceType}</strong>
            </div>
            <div className="tf-adoption-meta">
              <span>Import ID</span>
              <strong>{target.identifier || '-'}</strong>
            </div>
            <div className="tf-adoption-meta">
              <span>Region</span>
              <strong>{target.region}</strong>
            </div>
            {detection && (
              <div className="tf-adoption-note">
                {detection.scannedProjectCount} tracked project{detection.scannedProjectCount === 1 ? '' : 's'} scanned.
                {!detection.supported && ' State detection is heuristic for this resource type; verify the preview before importing.'}
              </div>
            )}
            {detection?.projects.length ? (
              <div className="tf-adoption-list">
                {detection.projects.map((project) => (
                  <div key={project.projectId} className="tf-adoption-list-item">
                    <div className="tf-adoption-list-head">
                      <strong>{project.projectName}</strong>
                      <span className={`tf-adoption-pill ${project.status === 'managed' ? 'managed' : 'config'}`}>
                        {project.status === 'managed' ? 'State match' : 'Config hint'}
                      </span>
                    </div>
                    <small>{project.currentWorkspace || 'default'} | {project.region || '-'} | {project.rootPath}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="tf-adoption-empty">No tracked project currently claims this resource in state or config.</div>
            )}
          </section>

          <section className="tf-adoption-card">
            <div className="tf-adoption-card-head">
              <h4>Project Selection</h4>
            </div>
            {projects.length === 0 ? (
              <div className="tf-adoption-empty">No tracked Terraform project found for this profile and region.</div>
            ) : (
              <div className="tf-adoption-projects">
                {projects.map((project) => {
                  const compatibility = compatibilityLabel(project, target)
                  return (
                    <label key={project.id} className={`tf-adoption-project ${project.id === selectedProjectId ? 'active' : ''}`}>
                      <input
                        type="radio"
                        name="tf-adoption-project"
                        value={project.id}
                        checked={project.id === selectedProjectId}
                        onChange={() => setSelectedProjectId(project.id)}
                      />
                      <div>
                        <strong>{project.name}</strong>
                        <small>{project.rootPath}</small>
                        <small>{compatibility.region} | {compatibility.workspace}</small>
                      </div>
                    </label>
                  )
                })}
              </div>
            )}
          </section>
        </div>

        {managed ? (
          <section className="tf-adoption-card">
            <div className="tf-adoption-card-head">
              <h4>Tracked Ownership</h4>
            </div>
            <div className="tf-adoption-empty">
              A tracked Terraform project already reports state ownership for this resource. Use the existing project instead of starting a new adoption flow.
            </div>
          </section>
        ) : (
          selectedProject && (
            guidedSupported ? (
              <section className="tf-adoption-card">
                <div className="tf-adoption-card-head">
                  <h4>Guided EC2 Adoption</h4>
                  <span className="tf-adoption-pill manual">EC2</span>
                </div>
                {projectCompatibility && (
                  <div className="tf-adoption-note">
                    {projectCompatibility.region}. {projectCompatibility.workspace}. Review the generated HCL before writing it to the selected project.
                  </div>
                )}
                <div className="tf-adoption-actions">
                  <button type="button" className="svc-btn" onClick={() => void handleOpenProject()}>Open Project</button>
                  {codegen && (
                    <>
                      <button type="button" className="svc-btn" onClick={() => void copyText('Import command', codegen.importCommand)}>Copy Import</button>
                      <button type="button" className="svc-btn" onClick={() => void copyText('HCL preview', codegen.resourceBlock)}>Copy HCL</button>
                    </>
                  )}
                  <button
                    type="button"
                    className="svc-btn"
                    disabled={importRunning || !codegen}
                    onClick={() => void handleExecuteImport()}>
                    {importRunning ? 'Import Running...' : 'Write HCL and Run Import'}
                  </button>
                  <button
                    type="button"
                    className="svc-btn"
                    disabled={validationLoading || !importResult?.log.success}
                    onClick={() => void runValidation()}>
                    {validationLoading ? 'Validating...' : 'Run Post-Import Validation'}
                  </button>
                </div>

                {mappingLoading && <div className="tf-adoption-banner">Mapping Terraform placement...</div>}
                {mappingError && <div className="tf-adoption-banner error">{mappingError}</div>}
                {mapping && (
                  <>
                    <div className="tf-adoption-grid tf-adoption-grid-compact">
                      <div className="tf-adoption-meta">
                        <span>Address</span>
                        <strong>{mapping.suggestedAddress}</strong>
                      </div>
                      <div className="tf-adoption-meta">
                        <span>Module</span>
                        <strong>{mapping.module.displayPath}</strong>
                      </div>
                      <div className="tf-adoption-meta">
                        <span>Confidence</span>
                        <strong>{mapping.confidence}</strong>
                      </div>
                    </div>
                    {mapping.reasons.length > 0 && (
                      <div className="tf-adoption-list">
                        {mapping.reasons.map((reason) => (
                          <div key={reason} className="tf-adoption-list-item">
                            <small>{reason}</small>
                          </div>
                        ))}
                      </div>
                    )}
                    {mapping.warnings.length > 0 && (
                      <div className="tf-adoption-list">
                        {mapping.warnings.map((warning) => (
                          <div key={warning} className="tf-adoption-list-item">
                            <small>{warning}</small>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {codegenLoading && <div className="tf-adoption-banner">Generating HCL preview...</div>}
                {codegenError && <div className="tf-adoption-banner error">{codegenError}</div>}
                {codegen && (
                  <>
                    <div className="tf-adoption-grid tf-adoption-grid-compact">
                      <div className="tf-adoption-meta">
                        <span>File</span>
                        <strong>{codegen.filePlan.suggestedFileName}</strong>
                      </div>
                      <div className="tf-adoption-meta">
                        <span>Action</span>
                        <strong>{codegen.filePlan.action}</strong>
                      </div>
                      <div className="tf-adoption-meta">
                        <span>Working Dir</span>
                        <strong>{codegen.workingDirectory}</strong>
                      </div>
                    </div>
                    <div className="tf-adoption-preview-block">
                      <span>HCL Preview</span>
                      <pre>{codegen.resourceBlock}</pre>
                    </div>
                    <div className="tf-adoption-preview-block">
                      <span>Import Command</span>
                      <pre>{codegen.importCommand}</pre>
                    </div>
                    {codegen.notes.length > 0 && (
                      <div className="tf-adoption-list">
                        {codegen.notes.map((note) => (
                          <div key={note} className="tf-adoption-list-item">
                            <small>{note}</small>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}

                {importError && <div className="tf-adoption-banner error">{importError}</div>}
                {importResult && (
                  <div className="tf-adoption-preview-block">
                    <span>Import Output</span>
                    <pre>{importResult.log.output || 'No Terraform output was captured.'}</pre>
                  </div>
                )}

                {validationError && <div className="tf-adoption-banner error">{validationError}</div>}
                {validation && (
                  <>
                    <div className="tf-adoption-grid tf-adoption-grid-compact">
                      <div className="tf-adoption-meta">
                        <span>Status</span>
                        <strong>{validation.status}</strong>
                      </div>
                      <div className="tf-adoption-meta">
                        <span>Address</span>
                        <strong>{validation.address}</strong>
                      </div>
                      <div className="tf-adoption-meta">
                        <span>Plan</span>
                        <strong>{validation.planSummary.hasChanges ? 'changes detected' : 'clean'}</strong>
                      </div>
                    </div>
                    <div className="tf-adoption-note">{validation.summary}</div>
                    <div className="tf-adoption-preview-block">
                      <span>Validation Output</span>
                      <pre>{validation.log.output || 'No Terraform output was captured.'}</pre>
                    </div>
                  </>
                )}
              </section>
            ) : (
              preview && (
                <section className="tf-adoption-card">
                  <div className="tf-adoption-card-head">
                    <h4>Manual Adoption Preview</h4>
                    <span className="tf-adoption-pill manual">Fallback</span>
                  </div>
                  {projectCompatibility && (
                    <div className="tf-adoption-note">
                      {projectCompatibility.region}. {projectCompatibility.workspace}. Suggested file: {preview.suggestedFileName}
                    </div>
                  )}
                  <div className="tf-adoption-grid tf-adoption-grid-compact">
                    <div className="tf-adoption-meta">
                      <span>Address</span>
                      <strong>{preview.address}</strong>
                    </div>
                    <div className="tf-adoption-meta">
                      <span>Workspace</span>
                      <strong>{selectedProject.currentWorkspace || 'default'}</strong>
                    </div>
                    <div className="tf-adoption-meta">
                      <span>Project</span>
                      <strong>{selectedProject.name}</strong>
                    </div>
                  </div>
                  <div className="tf-adoption-actions">
                    <button type="button" className="svc-btn" onClick={() => void handleOpenProject()}>Open Project</button>
                    <button type="button" className="svc-btn" onClick={() => void copyText('Import command', preview.importCommand)}>Copy Import</button>
                    <button type="button" className="svc-btn" onClick={() => void copyText('Plan command', preview.planCommand)}>Copy Plan</button>
                    <button type="button" className="svc-btn" onClick={() => void copyText('HCL preview', preview.resourceBlock)}>Copy HCL</button>
                  </div>
                  <div className="tf-adoption-preview-block">
                    <span>Import Command</span>
                    <pre>{preview.importCommand}</pre>
                  </div>
                  <div className="tf-adoption-preview-block">
                    <span>HCL Preview</span>
                    <pre>{preview.resourceBlock}</pre>
                  </div>
                  <div className="tf-adoption-preview-block">
                    <span>Post-Import Plan</span>
                    <pre>{preview.planCommand}</pre>
                  </div>
                  <div className="tf-adoption-preview-block">
                    <span>Rollback Guidance</span>
                    <pre>{preview.rollbackCommand}</pre>
                  </div>
                  <div className="tf-adoption-list">
                    {preview.notes.map((note) => (
                      <div key={note} className="tf-adoption-list-item">
                        <small>{note}</small>
                      </div>
                    ))}
                  </div>
                </section>
              )
            )
          )
        )}
      </div>
    </div>
  )
}
