import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/memory': 'src/adapters/memory.ts',
    'adapters/postgres': 'src/adapters/postgres.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['pg'],
})
