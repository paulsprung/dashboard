export async function restartTeamSpeakContainer(containerName: string) {
  // Placeholder only. In production, mount /var/run/docker.sock and call Docker API or use dockerode.
  return { ok: true, message: `Placeholder restart for ${containerName}. Enable Docker socket integration to execute.` };
}

export async function teamspeakStatus(containerName: string) {
  return { container: containerName, status: 'unknown', detail: 'Docker socket unavailable - returning placeholder.' };
}
