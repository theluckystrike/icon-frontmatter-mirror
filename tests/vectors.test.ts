import { describe, expect, it } from 'vitest';
import vectors from './vectors/icon-frontmatter-mirror.json';
import { decide, findCaseTwin, folderNotePath, formatIcon, holdRemovals, parseIconizeData, planWanted, removalAllowed } from '../src/mirror';

const fns: Record<string, (...args: never[]) => unknown> = { decide, findCaseTwin, folderNotePath, formatIcon, holdRemovals, parseIconizeData, planWanted, removalAllowed };

describe('golden vectors (packages/spec/vectors/icon-frontmatter-mirror.json)', () => {
	it('covers acceptance cases 1 to 7 and 9 to 12', () => {
		for (const n of ['1', '2', '3', '4', '5', '6', '7', '9', '10', '11', '12']) expect(vectors.cases.some((c) => c.name.startsWith(`${n} `))).toBe(true);
		expect(vectors.cases.length).toBeGreaterThanOrEqual(30);
	});
	for (const c of vectors.cases) {
		it(c.name, () => {
			const fn = fns[c.fn];
			expect(fn).toBeTypeOf('function');
			expect(fn!(...(c.args as never[]))).toEqual(c.expected);
		});
	}
});
