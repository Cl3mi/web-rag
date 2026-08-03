import type { PageServerLoad } from './$types';
import { listComparisons } from '$lib/server/compare/store';

export const load: PageServerLoad = async () => {
  return { comparisons: await listComparisons() };
};
