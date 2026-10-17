import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateSceneDurations, getRequiredVoiceSceneDuration, getSceneTiming } from '../src/media/scene-timing.js';
import { buildSrt } from '../src/media/scene-planner.js';

test('voice timing keeps longer estimates and fits complete audio inside shorter scenes', () => {
  const shortVoice = getSceneTiming({
    plannedDurationSeconds: 8,
    currentDurationSeconds: 8,
    voiceDurationSeconds: 3.2,
    marginSeconds: 0.5,
  });
  assert.equal(shortVoice.targetDurationSeconds, 8);
  assert.equal(shortVoice.autoAdjusted, false);
  assert.equal(shortVoice.needsMoreTime, false);

  const longVoice = getSceneTiming({
    plannedDurationSeconds: 3,
    currentDurationSeconds: 3,
    voiceDurationSeconds: 6.2,
    marginSeconds: 0.5,
  });
  assert.equal(longVoice.requiredDurationSeconds, 7);
  assert.equal(longVoice.targetDurationSeconds, 7);
  assert.equal(longVoice.autoAdjusted, true);
  assert.equal(longVoice.needsMoreTime, true);
  assert.ok(longVoice.targetDurationSeconds >= longVoice.voiceDurationSeconds + 0.5);
});

test('voice timing preserves manual bases, voice-free scenes and estimated source', () => {
  const manual = getSceneTiming({
    plannedDurationSeconds: 10,
    currentDurationSeconds: 11,
    voiceDurationSeconds: 4,
    marginSeconds: 0.5,
    durationSource: 'manual',
  });
  assert.equal(manual.targetDurationSeconds, 10);
  assert.equal(manual.durationSource, 'manual');
  assert.equal(manual.autoAdjusted, false);

  const noVoice = getSceneTiming({
    plannedDurationSeconds: 4,
    currentDurationSeconds: 7,
    voiceDurationSeconds: null,
    marginSeconds: 0.5,
  });
  assert.equal(noVoice.targetDurationSeconds, 4);
  assert.equal(noVoice.needsMoreTime, false);
});

test('voice margin is included in whole-second scene timings and invalid measurements are not guessed', () => {
  assert.equal(getRequiredVoiceSceneDuration(3.01, 0.5), 4);
  assert.equal(getRequiredVoiceSceneDuration(3.5, 0.5), 4);
  assert.equal(getRequiredVoiceSceneDuration(0, 0.5), null);
  assert.equal(getRequiredVoiceSceneDuration(Number.NaN, 0.5), null);
  assert.equal(getRequiredVoiceSceneDuration(4, Number.NaN), null);
});

test('consecutive voice scenes and silent scenes share one recalculated subtitle timeline', () => {
  const timings = [
    getSceneTiming({ plannedDurationSeconds: 3, currentDurationSeconds: 3, voiceDurationSeconds: 3.1, marginSeconds: 0.5 }),
    getSceneTiming({ plannedDurationSeconds: 4, currentDurationSeconds: 4, voiceDurationSeconds: 6.2, marginSeconds: 0.5 }),
    getSceneTiming({ plannedDurationSeconds: 2, currentDurationSeconds: 2, voiceDurationSeconds: null, marginSeconds: 0.5 }),
  ];
  const scenes = timings.map((timing, index) => ({
    durationSeconds: timing.targetDurationSeconds,
    subtitleText: `Escena ${index + 1}`,
  }));
  assert.deepEqual(scenes.map((scene) => scene.durationSeconds), [4, 7, 2]);
  assert.equal(scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0), 13);
  const subtitles = buildSrt(scenes);
  assert.match(subtitles, /00:00:00,000 --> 00:00:04,000/);
  assert.match(subtitles, /00:00:04,000 --> 00:00:11,000/);
  assert.match(subtitles, /00:00:11,000 --> 00:00:13,000/);
});

test('the 180-second project cap is explicit and never claims an unallocated voice fits', () => {
  const scenes = [
    { plannedDurationSeconds: 5, targetDurationSeconds: 10 },
    { plannedDurationSeconds: 175, targetDurationSeconds: 175 },
  ];
  const durations = allocateSceneDurations(scenes, 180);
  assert.deepEqual(durations, [5, 175]);
  assert.equal(durations[0] < scenes[0].targetDurationSeconds, true);
  assert.throws(() => allocateSceneDurations([
    { plannedDurationSeconds: 180, targetDurationSeconds: 180 },
    { plannedDurationSeconds: 1, targetDurationSeconds: 1 },
  ], 180), RangeError);
});
