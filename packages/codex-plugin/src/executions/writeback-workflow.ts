export class WritebackWorkflowError extends Error {
  readonly code = "feishu_write_capability_unsupported";
  constructor(readonly localArtifact: string) {
    super("feishu_write_capability_unsupported");
    this.name = "WritebackWorkflowError";
  }
}

export class WritebackWorkflow {
  constructor(private readonly options: {
    writeRemote?: (input: { executionId: string; content: string }) => Promise<void>;
  }) {}

  async write(input: { executionId: string; content: string }) {
    if (!this.options.writeRemote) throw new WritebackWorkflowError(input.content);
    await this.options.writeRemote(input);
    return { state: "written" as const };
  }
}
