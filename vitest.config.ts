import { configDefaults, defineConfig } from 'vitest/config';

// Vitest 4 dropped dist/ from the default exclude, and the build compiles *.test.ts into each package's dist/.
export default defineConfig({ test: { exclude: [...configDefaults.exclude, '**/dist/**'] } });
