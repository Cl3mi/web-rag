import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node',
		passWithNoTests: true
	},
	resolve: {
		alias: {
			$lib: new URL('./src/lib', import.meta.url).pathname
		}
	}
});
