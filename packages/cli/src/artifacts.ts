import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ARTIFACTS_ROOT = path.join(os.homedir(), ".lovable-cloud-to-supabase-exporter", "artifacts");

export const artifactDirPath = (jobId: string): string => path.join(ARTIFACTS_ROOT, jobId);

export const artifactFileName = (jobId: string): string => `lovable-cloud-export-${jobId}.zip`;

export const artifactFilePath = (jobId: string): string =>
  path.join(artifactDirPath(jobId), artifactFileName(jobId));

export const ensureCleanArtifactDir = async (jobId: string): Promise<string> => {
  const artifactDir = artifactDirPath(jobId);
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  return artifactDir;
};

export const artifactExists = async (jobId: string): Promise<boolean> => {
  try {
    const info = await stat(artifactFilePath(jobId));
    return info.isFile();
  } catch {
    return false;
  }
};
