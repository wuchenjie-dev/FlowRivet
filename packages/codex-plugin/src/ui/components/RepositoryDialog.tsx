import { GitBranch, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { GitLabProject } from "../../contracts/gitlab.js";

export function RepositoryDialog(props: {
  projects: GitLabProject[];
  pending: boolean;
  error?: string;
  onBind: (project: GitLabProject, paths: { localPath?: string; parentDirectory?: string }) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<GitLabProject>();
  const [mode, setMode] = useState<"existing" | "clone">("existing");
  const [path, setPath] = useState("");
  const filtered = useMemo(() => props.projects.filter((project) =>
    project.pathWithNamespace.toLowerCase().includes(query.trim().toLowerCase())), [props.projects, query]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => openerRef.current?.focus();
  }, []);

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
          <button type="button" className="icon-button" aria-label="关闭仓库选择" onClick={props.onCancel}><X size={17} /></button>
        </header>
        <div className="repository-body">
          <label>搜索 GitLab 项目<input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="项目名称或路径" /></label>
          <div className="repository-list" role="listbox" aria-label="GitLab 项目">
            {filtered.map((project) => (
              <button key={project.projectId} type="button" role="option" aria-selected={selected?.projectId === project.projectId} onClick={() => setSelected(project)}>
                <strong>{project.displayName}</strong><span>{project.pathWithNamespace}</span>
              </button>
            ))}
            {filtered.length === 0 ? <p>没有匹配的项目</p> : null}
          </div>
          <div className="repository-modes" aria-label="仓库准备方式">
            <button type="button" aria-pressed={mode === "existing"} onClick={() => setMode("existing")}>复用本地仓库</button>
            <button type="button" aria-pressed={mode === "clone"} onClick={() => setMode("clone")}>克隆到父目录</button>
          </div>
          <label>{mode === "existing" ? "本地仓库绝对路径" : "父目录绝对路径"}<input value={path} onChange={(event) => setPath(event.target.value)} placeholder={mode === "existing" ? "C:\\workspace\\project" : "C:\\workspace"} /></label>
          {props.error ? <p role="alert">{props.error}</p> : null}
        </div>
        <footer className="repository-actions">
          <button type="button" onClick={props.onCancel}>取消</button>
          <button type="button" disabled={!selected || !path.trim() || props.pending} onClick={() => selected && props.onBind(selected, mode === "existing" ? { localPath: path.trim() } : { parentDirectory: path.trim() })}>
            {props.pending ? "正在准备..." : "确认关联"}
          </button>
        </footer>
      </section>
    </dialog>
  );
}
