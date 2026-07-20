const { spawnSync } = require('node:child_process')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const executablePath = path.resolve(process.argv[2] || '')
const iconPath = path.resolve(process.argv[3] || '')
const packageJson = require(path.join(projectRoot, 'package.json'))

if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: node apply-windows-resources.cjs <exe-path> <icon-path>')
}

const appBuilderPath = path.join(
  projectRoot,
  'node_modules',
  'app-builder-bin',
  'win',
  process.arch,
  'app-builder.exe'
)
const executableName = path.basename(executablePath, '.exe')
const productName = packageJson.build?.productName || packageJson.productName || packageJson.name
const companyName =
  typeof packageJson.author === 'string' ? packageJson.author : packageJson.author?.name
const versionParts = packageJson.version.split('.').slice(0, 4)
while (versionParts.length < 4) versionParts.push('0')

const resourceArguments = [
  executablePath,
  '--set-version-string',
  'FileDescription',
  packageJson.description || productName,
  '--set-version-string',
  'ProductName',
  productName,
  '--set-version-string',
  'LegalCopyright',
  `Copyright © ${new Date().getFullYear()} ${productName}`,
  '--set-file-version',
  packageJson.version,
  '--set-product-version',
  versionParts.join('.'),
  '--set-version-string',
  'InternalName',
  executableName,
  '--set-version-string',
  'OriginalFilename',
  `${executableName}.exe`
]

if (companyName) {
  resourceArguments.push('--set-version-string', 'CompanyName', companyName)
}
resourceArguments.push('--set-icon', iconPath)

const result = spawnSync(
  appBuilderPath,
  ['rcedit', '--args', JSON.stringify(resourceArguments)],
  { stdio: 'inherit' }
)

if (result.error) throw result.error
process.exit(result.status ?? 1)
