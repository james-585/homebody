import js from '@eslint/js';

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  URL: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  structuredClone: 'readonly',
  clearTimeout: 'readonly',
};

// index.html and sw.js are not linted (CLAUDE.md: excluded until the architect adopts a
// formatter/linter for them). Only tooling, scripts and tests are linted in T1.
export default [
  {
    ignores: [
      'node_modules/',
      'test-results/',
      'playwright-report/',
      'index.html',
      'sw.js',
      'tests/fixtures/',
      'tests/golden/',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: nodeGlobals },
  },
  {
    // Shipped classic scripts (src/): browser globals only.
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        globalThis: 'readonly',
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        setTimeout: 'readonly',
        structuredClone: 'readonly',
      },
    },
  },
  {
    // Code passed to page.evaluate runs in the browser against the app's classic-script globals.
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        state: 'readonly',
        EXERCISES: 'readonly',
        mGetLastPerformance: 'readonly',
        mRenderPRs: 'readonly',
        mRenderProgress: 'readonly',
        mRenderMuscleRecovery: 'readonly',
        mRenderWeeklyVolumeChart: 'readonly',
        mRenderHome: 'readonly',
        mRenderLog: 'readonly',
        mExportData: 'readonly',
        HB: 'readonly',
        Storage: 'readonly',
        DOMException: 'readonly',
        innerWidth: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly',
        performance: 'readonly',
        persistSave: 'readonly',
      },
    },
  },
];
