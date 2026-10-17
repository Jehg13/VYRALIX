export function getRequiredVoiceSceneDuration(voiceDurationSeconds, marginSeconds) {
  if (!Number.isFinite(voiceDurationSeconds) || voiceDurationSeconds <= 0 ||
    !Number.isFinite(marginSeconds) || marginSeconds < 0) {
    return null;
  }
  return Math.ceil(voiceDurationSeconds + marginSeconds);
}

export function allocateSceneDurations(scenes, projectLimitSeconds) {
  const plannedTotal = scenes.reduce((sum, scene) => sum + scene.plannedDurationSeconds, 0);
  if (plannedTotal > projectLimitSeconds) {
    throw new RangeError('Planned scene durations exceed the project duration limit.');
  }
  let remainingExpansion = projectLimitSeconds - plannedTotal;
  return scenes.map((scene) => {
    const expansion = Math.max(0, scene.targetDurationSeconds - scene.plannedDurationSeconds);
    const allocatedExpansion = Math.min(expansion, remainingExpansion);
    remainingExpansion -= allocatedExpansion;
    return scene.plannedDurationSeconds + allocatedExpansion;
  });
}

export function getSceneTiming({
  plannedDurationSeconds,
  currentDurationSeconds,
  voiceDurationSeconds,
  marginSeconds,
  durationSource = 'estimated',
}) {
  const requiredDurationSeconds = getRequiredVoiceSceneDuration(voiceDurationSeconds, marginSeconds);
  const baseDurationSeconds = plannedDurationSeconds || currentDurationSeconds;
  const targetDurationSeconds = requiredDurationSeconds === null
    ? baseDurationSeconds
    : Math.max(baseDurationSeconds, requiredDurationSeconds);
  return {
    plannedDurationSeconds: baseDurationSeconds,
    currentDurationSeconds,
    voiceDurationSeconds,
    requiredDurationSeconds,
    targetDurationSeconds,
    durationSource,
    autoAdjusted: targetDurationSeconds > baseDurationSeconds,
    needsMoreTime: currentDurationSeconds < targetDurationSeconds,
  };
}
