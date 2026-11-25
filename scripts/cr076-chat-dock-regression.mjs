import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  stdin: {
    contents: `export * from './src/modules/chat/sessionPlan'; export * from './src/modules/chat/sessionRuntime';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, write: false, platform: 'node', format: 'esm',
});
const { emptyPlan, projectPlan, getRuntime, setGoal, updateGoalState, markStreamStart, finishOnce, isCurrentTurn, dropRuntime, recordToolUse, recordToolResult } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const use = (toolId, name, input) => ({ type: 'toolUse', toolId, name, inputJson: JSON.stringify(input) });
const result = (toolId, content, isError = false) => ({ type: 'toolResult', toolId, content, isError });
const native = items => ({ type: 'planUpdate', items });
const turn = { type: 'turn' };
const apply = (plan, ...events) => { for (const event of events) projectPlan(plan, event); };
const items = plan => [...plan.tasks.values(), ...plan.todos].map(({ id, text, state }) => [id, text, state]);

const a = getRuntime('fixture-A');
const b = getRuntime('fixture-B');
const history = [
  turn,
  use('a:create', 'TaskCreate', { subject: 'Phase one' }),
  use('a:create', 'TaskCreate', { subject: 'Duplicate invocation' }),
  use('a:second', 'TaskCreate', { subject: 'Phase two' }),
  result('a:second', JSON.stringify({ task: { id: 24 } })),
  result('a:create', '[{"type":"text","text":"Task #17 created successfully: Phase one"}]'),
  result('a:create', 'Task #1000 created successfully: replay duplicate'),
  use('a:edit', 'TaskUpdate', { taskId: '17', status: 'in_progress', subject: 'Phase one renamed' }),
  result('a:edit', 'Updated task #17'),
  use('a:failure', 'TaskUpdate', { taskId: '17', status: 'completed' }),
  result('a:failure', 'Denied', true),
  result('a:failure', 'Unexpected duplicate success'),
  use('a:wrong-id', 'TaskUpdate', { taskId: 'a:create', status: 'completed' }),
  result('a:wrong-id', 'Updated'),
  use('a:invalid-create', 'TaskCreate', { subject: 'No returned ID' }),
  result('a:invalid-create', 'Unrecognized result shape'),
  result('a:orphan', 'Task #30 created successfully: orphan result'),
  use('a:orphan', 'TaskCreate', { subject: 'Out of order' }),
  result('a:orphan', 'Task #31 created successfully: duplicate orphan result'),
  use('a:read', 'Read', { path: 'fixture.md' }), result('a:read', 'fixture'),
  use('a:todos', 'TodoWrite', { todos: [{ content: 'Run tests', status: 'pending' }] }),
  result('a:todos', 'Todos modified successfully'),
];
apply(a.plan, ...history);
assert.deepEqual(items(a.plan), [
  ['task:24', 'Phase two', 'pending'],
  ['task:17', 'Phase one renamed', 'running'],
  ['todo:0', 'Run tests', 'pending'],
]);
console.log('PASS Claude: returned IDs, out-of-order matching, failure/orphan/duplicate suppression, genuine plan tools only');

const tail = [turn, use('a:todos', 'TodoWrite', { todos: [] }), result('a:todos', 'Todos modified successfully'),
  use('a:delete', 'TaskUpdate', { taskId: 24, status: 'deleted' }), result('a:delete', 'Deleted task #24'),
  native([{ text: 'Native plan', status: 'completed' }]), native([{ text: 'Malformed', status: 'unknown' }])];
apply(a.plan, ...tail);
assert.deepEqual(items(a.plan), [['task:17', 'Phase one renamed', 'running'], ['todo:0', 'Native plan', 'completed']]);
const replay = emptyPlan();
apply(replay, ...JSON.parse(JSON.stringify([...history, ...tail, turn])));
assert.deepEqual(items(replay), items(a.plan));
apply(a.plan, native([]));
assert.deepEqual(items(a.plan), [['task:17', 'Phase one renamed', 'running']]);
console.log('PASS Complete-list replacement/clear, delete, turn boundary and ordered reducer replay');

assert.equal(a.todoExpanded, false);
assert.equal(b.todoExpanded, false);
a.todoExpanded = true;
apply(a.plan, use('local', 'TaskCreate', { subject: 'Separate' }));
apply(b.plan, result('local', 'Task #6 created successfully: Separate'));
assert.deepEqual(items(b.plan), []);
assert.equal(b.todoExpanded, false);
const generation = markStreamStart('fixture-A');
assert.ok(isCurrentTurn('fixture-A', generation));
assert.equal(isCurrentTurn('fixture-B', generation), false);
recordToolUse('fixture-A', 'read', 'Read');
recordToolResult('fixture-A', 'read', true);
assert.equal(a.steps.at(-1).state, 'failed');
assert.equal(a.plan.tasks.size, 1);
assert.ok(finishOnce('fixture-A', generation, 'failed'));
assert.equal(isCurrentTurn('fixture-A', generation), false);
assert.equal(finishOnce('fixture-A', generation, 'success'), false);
console.log('PASS Session/turn isolation, default collapse and tool history remains separate');

assert.equal(a.goal, null);
const firstGoal = setGoal('fixture-A', '  Plan\nReview  ');
assert.equal(firstGoal.text, 'Plan\nReview');
assert.equal(a.goalArmed, true);
updateGoalState('fixture-A', 'paused');
assert.equal(a.goalArmed, false);
assert.equal(setGoal('fixture-A', 'Updated').id, firstGoal.id);
assert.equal(a.goal.state, 'paused');
updateGoalState('fixture-A', 'blocked');
updateGoalState('fixture-A', 'active');
assert.equal(a.goalArmed, true);
updateGoalState('fixture-A', 'cancelled');
const nextGoal = setGoal('fixture-A', 'New goal');
assert.notEqual(nextGoal.id, firstGoal.id);
assert.ok(nextGoal.history.some(record => record.state === 'cancelled'));
updateGoalState('fixture-A', 'complete');
assert.equal(a.goalArmed, false);
assert.equal(b.goal, null);
dropRuntime('fixture-A');
assert.equal(getRuntime('fixture-A').goal, null);
console.log('PASS Goal identity, edit/pause/block/resume/cancel/complete, cancellation history and session cleanup');
