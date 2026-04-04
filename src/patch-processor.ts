export interface PatchProcessingContext {
  repoFullName: string;
  owner: string;
  repo: string;
  workflowRunId: number;
  workflowName?: string;
  branch?: string;
  prNumber?: number;
  artifactId: number;
  artifactName: string;
  patchPath: string;
}

export interface PatchFile {
  filename: string;
  content: string;
}

export async function processPatch(
  context: PatchProcessingContext,
  patch: PatchFile,
): Promise<void> {
  // Replace this with your real patch pipeline (queue, DB, apply engine, etc).
  console.log(
    "Processing patch",
    JSON.stringify({
      repo: context.repoFullName,
      runId: context.workflowRunId,
      artifact: context.artifactName,
      pr: context.prNumber ?? null,
      branch: context.branch ?? null,
      filename: patch.filename,
      bytes: patch.content.length,
    }),
  );
}
