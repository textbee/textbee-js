import { readFileSync } from 'node:fs'
import { defineConfig } from 'tsup'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node18',
  define: {
    __SDK_VERSION__: JSON.stringify(pkg.version),
  },
})
