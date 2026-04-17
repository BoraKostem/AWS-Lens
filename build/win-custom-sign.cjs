const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function log(msg) {
  process.stdout.write(`[sslcom-sign] ${msg}\n`)
}

function getEnv(name, required = true) {
  const value = process.env[name]
  if (!value && required) {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value || ''
}

function resolveToolPath() {
  const fromEnv = process.env.SSLCOM_CODESIGNTOOL_PATH
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv
  }

  // Fallback: search common locations under tools/
  const roots = [
    path.join(process.cwd(), 'tools'),
    path.join(__dirname, '..', 'tools')
  ]

  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const stack = [root]
    while (stack.length > 0) {
      const dir = stack.pop()
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile() && entry.name.toLowerCase() === 'codesigntool.bat') {
          return full
        }
      }
    }
  }

  throw new Error(
    'CodeSignTool.bat was not found. Set SSLCOM_CODESIGNTOOL_PATH or place CodeSignTool under ./tools/.'
  )
}

exports.default = async function signWithSslCom(configuration) {
  const inputFile = configuration.path
  if (!inputFile) {
    throw new Error('electron-builder did not provide a path to sign.')
  }
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Cannot sign: input file does not exist: ${inputFile}`)
  }

  const toolPath = resolveToolPath()
  log(`signing ${inputFile}`)
  log(`using CodeSignTool at ${toolPath}`)

  const username = getEnv('ES_USERNAME')
  const password = getEnv('ES_PASSWORD')
  const totpSecret = getEnv('ES_TOTP_SECRET')
  const credentialId = getEnv('CREDENTIAL_ID', false)

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sslcom-signed-'))

  const args = [
    '/c',
    toolPath,
    'sign',
    `-username=${username}`,
    `-password=${password}`,
    `-totp_secret=${totpSecret}`,
    `-input_file_path=${inputFile}`,
    `-output_dir_path=${outputDir}`
  ]

  if (credentialId) {
    args.push(`-credential_id=${credentialId}`)
  }

  const result = spawnSync('cmd.exe', args, {
    stdio: 'inherit',
    shell: false,
    cwd: path.dirname(toolPath)
  })

  if (result.error) {
    fs.rmSync(outputDir, { recursive: true, force: true })
    throw result.error
  }

  if (result.status !== 0) {
    fs.rmSync(outputDir, { recursive: true, force: true })
    throw new Error(
      `SSL.com CodeSignTool failed for ${inputFile} with exit code ${result.status}`
    )
  }

  // CodeSignTool writes the signed artifact into output_dir_path using the
  // same base file name. Verify and copy back over the original.
  const signedFile = path.join(outputDir, path.basename(inputFile))
  if (!fs.existsSync(signedFile)) {
    fs.rmSync(outputDir, { recursive: true, force: true })
    throw new Error(
      `SSL.com CodeSignTool reported success but no signed file was produced at ${signedFile}`
    )
  }

  const signedStat = fs.statSync(signedFile)
  if (signedStat.size === 0) {
    fs.rmSync(outputDir, { recursive: true, force: true })
    throw new Error(`Signed file at ${signedFile} is empty.`)
  }

  fs.copyFileSync(signedFile, inputFile)
  fs.rmSync(outputDir, { recursive: true, force: true })
  log(`successfully signed ${path.basename(inputFile)} (${signedStat.size} bytes)`)
}
