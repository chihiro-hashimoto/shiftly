import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'], environment: 'node' } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'security', include: ['tests/security/**/*.test.ts'], environment: 'node' } },
    ],
  },
});
