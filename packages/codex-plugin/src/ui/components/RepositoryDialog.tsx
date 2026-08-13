import { Check, FolderOpen, GitBranch, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { GitLabProject } from "../../contracts/gitlab.js";
import type { ExecutionRepository } from "../../contracts/executions.js";
import type { DirectoryPurpose, DirectorySelection } from "../../local-directory/directory-picker.js";

export function RepositoryDialog(props: {
  projects: GitLabProject[];
  initialProject?: GitLabProject;
  initialRepository?: ExecutionRepository;
  pending: boolean;
  error?: string;
  onBind: (project: GitLabProject, paths: { localPath?: string; parentDirectory?: string }) => void;
  onSelectDirectory: (purpose: DirectoryPurpose, initialDirectory?: string) => Promise<DirectorySelection>;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<GitLabProject | undefined>(props.initialProject);
  const [mode, setMode] = useState<"existing" | "clone">("existing");
  const [paths, setPaths] = useState({
    existing: props.initialRepository?.localPath ?? "",
    clone: "",
  });
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const [directoryError, setDirectoryError] = useState<string>();
  const [directorySelected, setDirectorySelected] = useState(false);
  const directoryRequest = useRef(0);
  const path = paths[mode];
  const filtered = useMemo(() => props.projects.filter((project) =>
    project.pathWithNamespace.toLowerCase().includes(query.trim().toLowerCase())), [props.projects, query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      directoryRequest.current += 1;
      openerRef.current?.focus();
    };
  }, []);

  function changeMode(nextMode: "existing" | "clone") {
    directoryRequest.current += 1;
    setSelectingDirectory(false);
    setDirectoryError(undefined);
    setDirectorySelected(false);
    setMode(nextMode);
  }

  async function selectDirectory() {
    const request = ++directoryRequest.current;
    const requestedMode = mode;
    setSelectingDirectory(true);
    setDirectoryError(undefined);
    setDirectorySelected(false);
    try {
      const selection = await props.onSelectDirectory(
        requestedMode === "existing" ? "existing_repository" : "clone_parent",
        paths[requestedMode] || undefined,
      );
      if (request !== directoryRequest.current) return;
      if (selection.outcome === "selected") {
        setPaths((current) => ({ ...current, [requestedMode]: selection.absolutePath }));
        setDirectorySelected(true);
      }
    } catch {
      if (request === directoryRequest.current) {
        setDirectoryError("无法打开文件夹选择器，请手动输入绝对路径");
      }
    } finally {
      if (request === directoryRequest.current) setSelectingDirectory(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="repository-dialog"
      aria-labelledby="repository-dialog-heading"
      onCancel={(event) => { event.preventDefault(); props.onCancel(); }}
      onClick={(event) => { if (event.target === event.currentTarget) props.onCancel(); }}
    >
      <section className="repository-panel">
        <header className="repository-header">
          <div><GitBranch size={17} aria-hidden="true" /><h2 id="repository-dialog-heading">选择研发仓库</h2></div>
          <button type="button" className="icon-button" aria-label="关闭仓库选择" disabled={props.pending} onClick={props.onCancel}><X size={17} /></button>
        </header>
        <div className="repository-body">
          <label>搜索 GitLab 项目<input autoFocus disabled={props.pending} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="项目名称或路径" /></label>
          <div className="repository-list" role="listbox" aria-label="GitLab 项目">
            {filtered.map((project) => (
              <button key={project.projectId} type="button" role="option" disabled={props.pending} aria-selected={selected?.projectId === project.projectId} onClick={() => setSelected(project)}>
                <strong>{project.displayName}</strong><span>{project.pathWithNamespace}</span>
              </button>
            ))}
            {filtered.length === 0 ? <p>没有匹配的项目</p> : null}
          </div>
          <div className="repository-modes" aria-label="仓库准备方式">
            <button type="button" disabled={props.pending} aria-pressed={mode === "existing"} onClick={() => changeMode("existing")}>复用本地仓库</button>
            <button type="button" disabled={props.pending} aria-pressed={mode === "clone"} onClick={() => changeMode("clone")}>克隆到父目录</button>
          </div>
          <label>
            {mode === "existing" ? "本地仓库绝对路径" : "父目录绝对路径"}
            <span className="repository-path-field">
              <input disabled={props.pending} value={path} onChange={(event) => {
                setDirectorySelected(false);
                setPaths((current) => ({ ...current, [mode]: event.target.value }));
              }} placeholder={mode === "existing" ? "C:\\workspace\\project" : "C:\\workspace"} />
              <button
                type="button"
                className="repository-directory-button"
                aria-label={mode === "existing" ? "选择本地仓库文件夹" : "选择克隆父文件夹"}
                title={mode === "existing" ? "选择本地仓库文件夹" : "选择克隆父文件夹"}
                disabled={selectingDirectory || props.pending}
                aria-busy={selectingDirectory}
                onClick={() => void selectDirectory()}
              >
                {selectingDirectory ? <><LoaderCircle size={16} className="spin" aria-hidden="true" />等待系统选择...</> : <><FolderOpen size={16} aria-hidden="true" />选择文件夹</>}
              </button>
            </span>
          </label>
          {directorySelected ? <p className="repository-directory-success" role="status" aria-live="polite"><Check size={14} aria-hidden="true" />目录已选择</p> : null}
          {directoryError ? <p className="repository-directory-error" role="alert">{directoryError}</p> : null}
          {props.error ? <p role="alert">{props.error}</p> : null}
        </div>
        <footer className="repository-actions">
          <button type="button" disabled={props.pending} onClick={props.onCancel}>取消</button>
          <button type="button" disabled={!selected || !path.trim() || props.pending} onClick={() => selected && props.onBind(selected, mode === "existing" ? { localPath: path.trim() } : { parentDirectory: path.trim() })}>
            {props.pending ? <><LoaderCircle size={15} className="spin" aria-hidden="true" />正在关联...</> : "确认关联"}
          </button>
        </footer>
      </section>
    </dialog>
  );
}
