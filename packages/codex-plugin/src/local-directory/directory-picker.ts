export type DirectoryPurpose = "existing_repository" | "clone_parent";

export type DirectorySelection =
  | { outcome: "selected"; absolutePath: string }
  | { outcome: "cancelled" };

export type DirectoryPickerErrorCode =
  | "directory_picker_busy"
  | "directory_picker_unavailable"
  | "directory_picker_failed"
  | "directory_picker_invalid_result";

export class DirectoryPickerError extends Error {
  constructor(readonly code: DirectoryPickerErrorCode) {
    super(code);
    this.name = "DirectoryPickerError";
  }
}

export interface DirectoryPicker {
  selectDirectory(input: {
    purpose: DirectoryPurpose;
    signal: AbortSignal;
  }): Promise<DirectorySelection>;
}
