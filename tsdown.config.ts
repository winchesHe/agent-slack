import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { 'agent-slack': 'src/cli/index.ts' },
  outDir: 'bin',
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: false,
  shims: true,
})
