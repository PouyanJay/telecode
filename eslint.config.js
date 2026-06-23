import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.claude/**',
      '**/.memory/**',
      '**/*.svelte',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  // Type-aware rules for the source + test TypeScript (covered by each package's tsconfig).
  {
    files: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'apps/*/tests/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Plain (non-type-aware) recommended for config files and anything else.
  {
    files: ['**/*.ts', '**/*.js', '**/*.mjs'],
    ignores: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts', 'apps/*/tests/**/*.ts'],
    extends: [...tseslint.configs.recommended],
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Several APIs are async by contract (crypto helpers kept swappable; Fastify handlers;
      // the canUseTool/AgentAdapter Promise-returning callbacks) even when a given body has no
      // await. require-await would force ugly no-op awaits or break those signatures.
      '@typescript-eslint/require-await': 'off',
    },
  },
);
