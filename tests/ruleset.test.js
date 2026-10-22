import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* .github/ruleset.json is applied by hand, so nothing enforces it at push
   time. These assertions pin the parts that are easy to get wrong and
   expensive to notice. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ruleset = JSON.parse(fs.readFileSync(path.join(root, '.github/ruleset.json'), 'utf8'));
const ruleOf = type => ruleset.rules.find(r => r.type === type);

test('the ruleset targets the default branch', () => {
  // An empty include list is the failure this file exists to prevent: the
  // ruleset reads as active in the UI while matching no branches at all.
  assert.deepEqual(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH']);
  assert.equal(ruleset.enforcement, 'active');
  assert.equal(ruleset.target, 'branch');
});

test('it carries the four rules that make it useful', () => {
  assert.deepEqual(
    ruleset.rules.map(r => r.type).sort(),
    ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks']);
});

test('it requires a pull request but no approvals', () => {
  // The repo has one person with write access, so requiring an approval would
  // lock them out of merging their own work entirely.
  assert.equal(ruleOf('pull_request').parameters.required_approving_review_count, 0);
});

test('it requires only a check that actually runs on pull requests', () => {
  const checks = ruleOf('required_status_checks').parameters.required_status_checks;
  assert.deepEqual(checks.map(c => c.context), ['test']);

  // main also carries build/deploy/report-build-status from GitHub Pages, and
  // those never run on a pull request - requiring one would hang every PR
  // forever waiting on a check that cannot report.
  const pagesChecks = ['build', 'deploy', 'report-build-status'];
  for(const c of checks){
    assert.ok(!pagesChecks.includes(c.context), `${c.context} does not run on pull requests`);
  }
  // Pinned to GitHub Actions so another app cannot satisfy the check.
  assert.equal(checks[0].integration_id, 15368);
  assert.equal(ruleOf('required_status_checks').parameters.strict_required_status_checks_policy, true);
});

test('nothing is exempt from it', () => {
  assert.deepEqual(ruleset.bypass_actors, [],
    'a bypass actor would let that app push straight past every rule above');
});
