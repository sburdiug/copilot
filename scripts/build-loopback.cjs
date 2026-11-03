const { execFileSync } = require('node:child_process')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')

function build() {
  if (process.platform !== 'win32') return
  const root = join(__dirname, '..')
  const out = join(root, 'resources', 'bin')
  mkdirSync(out, { recursive: true })
  const compiler = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  execFileSync(
    compiler,
    [
      '/nologo',
      '/optimize+',
      '/target:exe',
      '/platform:anycpu',
      '/r:System.Web.Extensions.dll',
      '/out:' + join(out, 'loopback.exe'),
      join(root, 'resources', 'loopback.cs')
    ],
    { stdio: 'inherit', windowsHide: true }
  )
}

module.exports = build
if (require.main === module) build()
