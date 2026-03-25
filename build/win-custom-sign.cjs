const { spawnSync } = require('node:child_process')
const path = require('node:path')

function getEnv(name, required = true) {
  const value = process.env[name]
  if (!value && required) {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value || ''
}

exports.default = async function signWithSslCom(configuration) {
  const toolPath = process.env.SSLCOM_CODESIGNTOOL_PATH ||
    path.join(process.cwd(), 'tools', 'CodeSignTool', 'CodeSignTool.bat')

  const username = getEnv('ES_USERNAME')
  const password = getEnv('ES_PASSWORD')
  const totpSecret = getEnv('ES_TOTP_SECRET')
  const credentialId = getEnv('CREDENTIAL_ID', false)

  const args = [
    'sign',
    `-username=${username}`,
    `-password=${password}`,
    `-totp_secret=${totpSecret}`,
    `-input_file_path=${configuration.path}`,
    '-override=true'
  ]

  if (credentialId) {
    args.push(`-credential_id=${credentialId}`)
  }

  const result = spawnSync(toolPath, args, {
    stdio: 'inherit',
    shell: false
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`SSL.com CodeSignTool failed for ${configuration.path} with exit code ${result.status}`)
  }
}
