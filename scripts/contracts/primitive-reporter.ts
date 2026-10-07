import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Reporter, TestCase, TestModule } from 'vitest/node';

/** Execution diagnostics come from Vitest, including retries that JSON assertions omit. */
export default class PrimitiveReporter implements Reporter {
  private completed = new Map<string, number>();

  onTestCaseResult(test: TestCase): void {
    this.completed.set(test.id, (this.completed.get(test.id) ?? 0) + 1);
  }

  onTestRunEnd(
    modules: ReadonlyArray<TestModule>,
    errors: ReadonlyArray<unknown>,
    reason: string,
  ): void {
    const path = process.env['PRIMITIVE_CONTRACT_REPORT'];
    if (!path) throw new Error('Primitive reporter requires an output path');
    const cases = modules.flatMap((module) =>
      [...module.children.allTests()].map((test) => {
        const titles = [test.name];
        let parent = test.parent;
        while (parent.type === 'suite') {
          titles.unshift(parent.name);
          parent = parent.parent;
        }
        const diagnostic = test.diagnostic();
        return {
          file: relative(process.cwd(), module.moduleId).replaceAll('\\', '/'),
          titlePath: titles,
          state: test.result().state,
          completions: this.completed.get(test.id) ?? 0,
          retryCount: diagnostic?.retryCount ?? null,
          repeatCount: diagnostic?.repeatCount ?? null,
          flaky: diagnostic?.flaky ?? null,
        };
      }),
    );
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        reason,
        unhandledErrors: errors.length,
        modules: modules.map((module) => ({
          file: relative(process.cwd(), module.moduleId).replaceAll('\\', '/'),
          passed: module.ok(),
          errors: module.errors().length,
        })),
        cases,
      }) + '\n',
      { flag: 'wx' },
    );
  }
}
